/* Standalone narration controller. Load as a normal <script> before the page controller. */
(function attachPanoramaSpeech(root) {
  'use strict';

  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };

  function create(options = {}) {
    const synthesis = root.speechSynthesis;
    const documentBase = root.document?.baseURI || root.location?.href;
    const settings = {
      audioBase: options.audioBase ? new URL(options.audioBase, documentBase).href : documentBase,
      audioMap: { ...(options.audioMap || {}) },
      source: options.source || 'auto',
      voiceURI: options.voiceURI || '',
      rate: clamp(options.rate ?? 1, 0.5, 2, 1),
      pitch: clamp(options.pitch ?? 1, 0, 2, 1),
      volume: clamp(options.volume ?? 1, 0, 1, 1),
      lang: options.lang || 'zh-CN',
      startTimeout: clamp(options.startTimeout ?? 15000, 1000, 60000, 15000),
    };
    let state = { status: 'idle', source: 'none', id: null };
    let current = null;
    let serial = 0;
    let destroyed = false;

    function emit(update) {
      state = { ...state, ...update };
      options.onState?.({ ...state });
    }

    function getVoices() {
      return (synthesis?.getVoices?.() || []).map(voice => ({
        name: voice.name,
        lang: voice.lang,
        voiceURI: voice.voiceURI,
        localService: voice.localService,
        default: voice.default,
      })).sort((a, b) => Number(/^zh/i.test(b.lang)) - Number(/^zh/i.test(a.lang)));
    }

    const voicesChanged = () => options.onVoices?.(getVoices());
    synthesis?.addEventListener?.('voiceschanged', voicesChanged);

    function release(run) {
      root.clearTimeout(run.timer);
      if (run.audio) {
        run.audio.onplay = run.audio.onpause = run.audio.onended = run.audio.onerror = null;
        run.audio.onloadedmetadata = run.audio.ontimeupdate = null;
        run.audio.pause();
        run.audio.removeAttribute('src');
        run.audio.load();
        run.audio = null;
      }
      if (run.utterance) {
        run.utterance.onstart = run.utterance.onend = run.utterance.onerror = null;
        run.utterance.onpause = run.utterance.onresume = run.utterance.onboundary = null;
        run.utterance = null;
        synthesis?.cancel();
      }
    }

    function isCurrent(run) {
      return current === run && run.serial === serial && !destroyed;
    }

    function finish(run, status, error) {
      if (!isCurrent(run)) return;
      current = null;
      release(run);
      const result = { ...state, status, ...(error ? { error } : {}) };
      emit(result);
      run.resolve({ ...result });
    }

    function stop(reason = 'cancelled') {
      serial += 1;
      const old = current;
      current = null;
      if (old) {
        release(old);
        old.resolve({ status: 'stopped', source: old.source || 'none', id: old.item.id, reason });
      }
      emit({ status: 'idle', source: 'none', id: null, error: null, reason, position: 0, duration: null });
    }

    function startSpeech(run, fallbackReason) {
      if (!isCurrent(run)) return;
      release(run);
      if (!synthesis || !root.SpeechSynthesisUtterance || !run.item.text?.trim()) {
        finish(run, 'error', {
          code: 'speech-unavailable',
          message: run.item.text?.trim() ? '当前浏览器的文字朗读接口不可用，请选择旁白音频。' : '此步骤尚未配置旁白文字或音频。',
        });
        return;
      }
      const item = run.item;
      run.started = false;
      const utterance = new root.SpeechSynthesisUtterance(item.text);
      run.utterance = utterance;
      run.source = 'speech';
      utterance.lang = item.lang || settings.lang;
      utterance.rate = clamp(item.rate ?? settings.rate, 0.5, 2, 1);
      utterance.pitch = settings.pitch;
      utterance.volume = settings.volume;
      const voices = synthesis.getVoices();
      utterance.voice = voices.find(voice => voice.voiceURI === settings.voiceURI)
        || voices.find(voice => voice.lang.toLowerCase() === utterance.lang.toLowerCase())
        || voices.find(voice => /^zh/i.test(voice.lang)) || null;
      emit({ status: run.paused ? 'paused' : 'loading', source: 'speech', error: null, fallbackReason: fallbackReason || null });
      utterance.onstart = () => {
        if (!isCurrent(run)) return;
        run.started = true;
        root.clearTimeout(run.timer);
        if (run.paused) synthesis.pause();
        emit({ status: run.paused ? 'paused' : 'playing', voice: utterance.voice?.name || '浏览器默认中文语音' });
      };
      utterance.onpause = () => isCurrent(run) && emit({ status: 'paused' });
      utterance.onresume = () => isCurrent(run) && emit({ status: 'playing' });
      utterance.onboundary = event => isCurrent(run) && options.onBoundary?.({ id: item.id, charIndex: event.charIndex, charLength: event.charLength || 0 });
      utterance.onend = () => finish(run, 'ended');
      utterance.onerror = event => finish(run, 'error', {
        code: event.error || 'speech-failed',
        message: event.error === 'not-allowed' ? '浏览器阻止了自动朗读，请点击朗读按钮。' : '浏览器朗读失败，可选择其他中文语音或旁白音频。',
      });
      run.timer = root.setTimeout(() => {
        if (!run.paused) finish(run, 'error', { code: 'speech-timeout', message: '语音未开始，请点击朗读或选择其他中文语音。' });
      }, settings.startTimeout);
      synthesis.cancel();
      synthesis.resume();
      synthesis.speak(utterance);
    }

    function startAudio(run, reference) {
      let url;
      try {
        const source = typeof reference === 'string' ? reference : reference.src;
        url = new URL(source, settings.audioBase);
        if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol)) throw new Error('Unsupported audio protocol');
        if (url.protocol === 'data:' && !url.href.startsWith('data:audio/')) throw new Error('Expected audio data URL');
      } catch {
        if (settings.source === 'audio') finish(run, 'error', { code: 'invalid-audio', message: '旁白音频地址无效。' });
        else startSpeech(run, 'invalid-audio');
        return;
      }
      if (!root.Audio) {
        if (settings.source === 'audio') finish(run, 'error', { code: 'audio-unavailable', message: '当前浏览器的音频播放接口不可用。' });
        else startSpeech(run, 'audio-unavailable');
        return;
      }
      const audio = new root.Audio();
      run.started = false;
      run.audio = audio;
      run.source = 'audio';
      audio.preload = 'auto';
      audio.volume = settings.volume;
      audio.playbackRate = clamp(run.item.rate ?? settings.rate, 0.5, 2, 1);
      emit({ status: 'loading', source: 'audio', audio: url.href, error: null });
      const failed = error => {
        if (!isCurrent(run) || run.audio !== audio) return;
        if (settings.source !== 'audio' && run.item.text?.trim()) startSpeech(run, error?.name || 'audio-unavailable');
        else finish(run, 'error', {
          code: error?.name === 'NotAllowedError' ? 'not-allowed' : 'audio-failed',
          message: error?.name === 'NotAllowedError' ? '浏览器阻止了自动播放，请点击朗读按钮。' : '旁白音频无法播放，请检查音频地址和格式。',
        });
      };
      run.audioFailed = failed;
      audio.onplay = () => {
        if (!isCurrent(run) || run.audio !== audio) return;
        run.started = true;
        root.clearTimeout(run.timer);
        if (run.paused) audio.pause();
        emit({ status: run.paused ? 'paused' : 'playing' });
      };
      audio.onpause = () => isCurrent(run) && run.paused && emit({ status: 'paused' });
      audio.onended = () => finish(run, 'ended');
      audio.onerror = () => failed(audio.error);
      audio.onloadedmetadata = () => {
        if (!isCurrent(run)) return;
        const duration = Number.isFinite(audio.duration) ? audio.duration : null;
        const startAt = run.item.startAt ?? (duration && run.item.startFraction ? duration * run.item.startFraction : 0);
        if (startAt > 0) audio.currentTime = Math.min(startAt, Math.max(0, (duration || startAt) - 0.05));
        emit({ duration });
      };
      audio.ontimeupdate = () => {
        if (!isCurrent(run)) return;
        state.position = audio.currentTime;
        options.onProgress?.({ id: run.item.id, position: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null });
      };
      run.timer = root.setTimeout(() => {
        if (!run.paused) failed({ name: 'AudioStartTimeout' });
      }, settings.startTimeout);
      audio.src = url.href;
      try {
        audio.play()?.catch(failed);
      } catch (error) {
        failed(error);
      }
    }

    function play(entry) {
      if (destroyed) return Promise.resolve({ status: 'error', error: { code: 'destroyed', message: '朗读控制器已关闭。' } });
      stop('replaced');
      const item = typeof entry === 'string' ? { text: entry } : { ...(entry || {}) };
      item.id = item.id ?? null;
      item.text = String(item.text || '');
      const run = { serial, item, paused: false, source: 'none' };
      const completion = new Promise(resolve => { run.resolve = resolve; });
      current = run;
      emit({ status: 'loading', source: 'none', id: item.id, error: null, reason: null, audio: null, voice: null, position: 0, duration: null, fallbackReason: null });
      const reference = item.audio || settings.audioMap[item.id];
      if (reference && settings.source !== 'speech') startAudio(run, reference);
      else if (settings.source === 'audio') finish(run, 'error', { code: 'audio-unmapped', message: '此步骤尚未配置音频，可切换浏览器中文朗读。' });
      else startSpeech(run);
      return completion;
    }

    function pause() {
      if (!current) return;
      current.paused = true;
      root.clearTimeout(current.timer);
      current.audio?.pause();
      if (current.utterance) synthesis?.pause();
      emit({ status: 'paused' });
    }

    function resume() {
      if (!current || !current.paused) return;
      const run = current;
      run.paused = false;
      if (!run.started) {
        run.timer = root.setTimeout(() => {
          if (!isCurrent(run) || run.paused) return;
          if (run.audio) run.audioFailed({ name: 'AudioStartTimeout' });
          else finish(run, 'error', { code: 'speech-timeout', message: '语音未开始，请点击朗读或选择其他中文语音。' });
        }, settings.startTimeout);
      }
      if (run.audio) {
        try { run.audio.play()?.catch(run.audioFailed); } catch (error) { run.audioFailed(error); }
      } else if (run.utterance) {
        synthesis?.resume();
      }
      if (isCurrent(run)) emit({ status: run.started ? 'playing' : 'loading' });
    }

    function getPosition() {
      const audio = current?.audio;
      if (!audio) return null;
      return { position: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null };
    }

    function seek(seconds) {
      const audio = current?.audio;
      if (!audio || !Number.isFinite(seconds)) return false;
      if (audio.readyState >= 1) audio.currentTime = Math.max(0, seconds);
      else current.item.startAt = Math.max(0, seconds);
      return true;
    }

    return {
      play, pause, resume, stop, seek, getPosition,
      getState: () => ({ ...state }),
      getVoices,
      setVoice: voiceURI => { settings.voiceURI = voiceURI || ''; },
      setSource: source => {
        if (!['auto', 'audio', 'speech'].includes(source)) throw new TypeError('source must be auto, audio, or speech');
        settings.source = source;
      },
      setAudioMap: map => { settings.audioMap = { ...(map || {}) }; },
      setRate: rate => { settings.rate = clamp(rate, 0.5, 2, 1); },
      destroy: () => {
        stop('destroyed');
        destroyed = true;
        synthesis?.removeEventListener?.('voiceschanged', voicesChanged);
      },
    };
  }

  root.PanoramaSpeech = Object.freeze({ create });
})(typeof window === 'undefined' ? globalThis : window);
