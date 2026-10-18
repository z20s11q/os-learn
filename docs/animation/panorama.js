import { machine, registerGroups, flagDefinitions, memoryRegions, virtualRegions, stages, steps, lowMemorySamples, getStepState } from './panorama-data.js';
import { memoryOverview, memoryCell, physicalSamples } from './panorama-memory.js';
import { splitCues, cueTargets, planBeats, relatedCodeLines, estimateStarts, startsFromWords, cueAt } from './panorama-cues.js';
import { annotate, annotateHtml } from './panorama-glossary.js';
import { DEFAULT_NARRATOR, AVAILABLE_NARRATORS } from './narration-config.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gloss = value => annotateHtml(value, esc);
const pad = n => String(n).padStart(2, '0');
const hex = n => `0x${BigInt(n).toString(16)}`;
const kindLabel = kind => ({ recorded: '历史真实采样', 'source-inferred': '源码推导', schematic: '机制示意', unknown: '未采样' }[kind] || '未采样');
const actionLabel = action => ({ read: '读取', write: '写入', execute: '执行', map: '映射', copy: '复制', load: '装入', allocate: '分配', clear: '清零', free: '释放', decompress: '解压' }[action] || String(action || '').toUpperCase());
const allRegisters = registerGroups.flatMap(g => g.items);
const registerIds = new Set(allRegisters.map(r => r.id));
const flagByToken = new Map();
for (const f of flagDefinitions) { flagByToken.set(f.id, f); if (!flagByToken.has(f.en)) flagByToken.set(f.en, f); }
const coreFlags = new Set(['CF', 'PF', 'AF', 'ZF', 'SF', 'TF', 'IF', 'DF', 'OF', 'IOPL']);
const defaultOpenGroups = new Set(['execution', 'control', 'segments', 'general']);
const groupOverride = new Map();
const lastShown = new Map();

let current = 0;
let beat = 0;
let lesson = null;
let playing = false;
let speed = 1;
let timer = null;
let frameRequest = 0;
let playbackGeneration = 0;
let silentElapsed = 0;
let silentStarted = 0;
let audioReady = Promise.resolve();
let selectedRegion = null;
let memoryItems = [];
let selectedMemory = '';
let sourceCodePromise;
let currentSpeech = { status: 'idle' };
let speechResume = false;
let endAfterSpeech = false;
let speechOffset = 0;
let voiceGeneration = 0;
let customAudioMap = null;
let narratorWords = {};
let narratorCues = {};
const narratorPaths = { fire: 'audio/panorama-fire/manifest.json', fish: 'audio/panorama-fish/manifest.json', mambo: 'audio/panorama-mambo/manifest.json', xiaoyi: 'audio/panorama/manifest.json', xiaoxiao: 'audio/panorama-xiaoxiao/manifest.json', yunxi: 'audio/panorama-yunxi/manifest.json' };

function hashPosition() {
  const [hash, beatPart] = decodeURIComponent(location.hash.slice(1)).split('@');
  let index = steps.findIndex(s => s.id === hash);
  if (index < 0) {
    const legacy = ['power-off', 'power-off', 'reset-vector', 'boot-image', 'grub-core', 'setup-main', 'enable-pae', 'enable-pae', 'start-kernel', 'kernel-init', 'initcalls', 'mount-ext2', 'switch-root', 'busybox-init', 'spawn-terminals', 'shell-ready', 'shell-ready', 'next-key'];
    const match = hash.match(/^s(\d+)$/i);
    index = match ? Math.max(0, steps.findIndex(s => s.id === legacy[Math.max(0, Math.min(17, Number(match[1]) - 1))])) : 0;
  }
  const beatIndex = beatPart === 'end' ? Infinity : Math.max(0, (Number(beatPart) || 1) - 1);
  return { index, beat: beatIndex };
}
function snapshotAt(index) {
  for (let i = index; i >= 0; i--) if (steps[i].evidenceKey) return { ...getStepState(i), index: i };
  return null;
}
function inspect(title, html) {
  if (playing) pause();
  $('inspectTitle').textContent = title;
  $('inspectBody').innerHTML = html;
  if (!$('inspectDialog').open) $('inspectDialog').showModal();
}
function openDialog(id) {
  if (playing) pause();
  $(id).showModal();
}

/* ---------- lesson model: one step split into subtitle beats ---------- */

function resolveFlags(set) {
  const ids = new Set();
  for (const token of set) { const f = flagByToken.get(token); if (f) ids.add(f.id); }
  return ids;
}
function buildLesson(index) {
  const state = getStepState(index);
  const step = state.step;
  const cues = splitCues(step.narration || `${step.title}。${step.summary}${step.detail}`);
  const targets = cues.map(cue => {
    const t = cueTargets(cue.text, registerIds);
    t.flagIds = resolveFlags(t.flags);
    for (const id of t.flagIds) t.registers.add(flagByToken.get(id).register);
    t.codeLines = relatedCodeLines(cue.text, step.code);
    return t;
  });
  const delta = state.sampleDelta;
  const changedIds = [...new Set([...(delta?.registers || []).map(r => r.id), ...(delta?.segments || []).map(s => s.id)])];
  const before = new Set();
  for (let i = 0; i < index; i++) for (const line of steps[i].terminal) before.add(line);
  const terminalLines = step.terminal.filter(line => !before.has(line));
  const plan = planBeats({ targets, registerIds: changedIds, flags: delta?.flags || [], memoryChanges: step.memoryChanges, terminalLines: terminalLines.length, position: state.provenance.position });
  return { index, state, step, cues, targets, plan, delta, terminalBefore: [...before], terminalLines };
}
function beatStarts(durationSeconds) {
  const measured = narratorCues[lesson.step.id];
  if (Array.isArray(measured) && measured.length === lesson.cues.length
      && measured.every((t, i) => Number.isFinite(t) && t >= 0 && (!i || t >= measured[i - 1]))) return measured;
  const words = narratorWords[lesson.step.id];
  return startsFromWords(lesson.cues, lesson.step.narration, words) || estimateStarts(lesson.cues, durationSeconds || lesson.step.duration, 0.15, 0.4);
}
function revealedAt(map, id) { return map.has(id) ? map.get(id) : -1; }

/* ---------- CPU ---------- */

function registerDetail(id) {
  const def = allRegisters.find(r => r.id === id);
  if (!def) return;
  const exact = getStepState(current);
  const snapshot = snapshotAt(current);
  const value = snapshot?.registers[id];
  const segment = snapshot?.segments?.[id];
  const delta = exact.sampleDelta?.registers.find(r => r.id === id);
  const cacheDelta = exact.sampleDelta?.segments?.find(r => r.id === id);
  const metadata = snapshot?.registerMetadata?.[id];
  const bits = flagDefinitions.filter(f => f.register === id);
  inspect(`${def.en} · ${def.zh}`, `<p>${esc(def.note)}</p><p>宽度：<code>${metadata?.width || def.width} bit</code>。本步采样值：<code>${esc(value ?? '未采样')}</code>。</p>${metadata ? `<h3>本帧字段证据</h3><p>来源：<code>${esc(typeof metadata.source === 'string' ? metadata.source : JSON.stringify(metadata.source))}</code><br>captureId：<code>${esc(metadata.captureId || snapshot.frame.captureId)}</code></p>${metadata.raw != null ? `<p>原始表示：</p><pre>${esc(metadata.raw)}</pre>` : ''}${metadata.reason ? `<p>${esc(metadata.reason)}</p>` : ''}` : ''}${snapshot && value != null ? `<p>来源：${esc(steps[snapshot.index].title)}，frame ${snapshot.frame.frameId}。${snapshot.index === current ? '当前教学停点的历史采样。' : '保留的最近历史停点，不能当成本微步骤的即时值。'}</p>` : '<p>采集器未保存该字段，未知不会显示成零。</p>'}${delta ? `<h3>相邻采样点之间的净变化</h3><p><code>${esc(delta.before)} → ${esc(delta.after)}</code></p><p>${esc(exact.sampleDelta.note)}</p>` : ''}${segment ? `<h3>隐藏段缓存 / Hidden segment cache</h3><table><tr><th>字段</th><th>采样值</th></tr>${Object.entries(segment).map(([k,v]) => `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`).join('')}</table>` : ''}${cacheDelta ? `<h3>隐藏缓存的净变化</h3><table><tr><th>字段</th><th>之前</th><th>之后</th></tr>${cacheDelta.fields.map(f=>`<tr><td>${esc(f.field)}</td><td><code>${esc(f.before)}</code></td><td><code>${esc(f.after)}</code></td></tr>`).join('')}</table>` : ''}${bits.length ? `<h3>位定义与本步值</h3>${flagTable(exact.flags.filter(f => f.register === id))}` : ''}`);
}
function flagTable(flags) {
  return `<table><thead><tr><th>位 / Bit</th><th>名称 / Name</th><th>本步值</th><th>说明</th></tr></thead><tbody>${flags.map(f => `<tr><td>${esc(f.register.toUpperCase())}[${f.width > 1 ? `${f.bit + f.width - 1}:${f.bit}` : f.bit}]</td><td><code>${esc(f.en)}</code><br>${esc(f.zh)}</td><td>${f.value ?? '?'}<br>${esc(kindLabel(f.kind))}</td><td>${esc(f.note)}</td></tr>`).join('')}</tbody></table>`;
}
function nextStepPending(state) {
  const pending = new Set(), pendingFlags = new Set();
  const next = current + 1 < steps.length ? getStepState(current + 1) : null;
  if (state.frame && next?.frame && next.sampleDelta && next.sampleDelta.fromFrameId >= state.frame.frameId && next.frame.frameId > state.frame.frameId && next.frame.sessionId === state.frame.sessionId) {
    for (const r of next.sampleDelta.registers) if (!['rip', 'linearPc', 'cpl'].includes(r.id) && state.registers[r.id] != null && BigInt(state.registers[r.id]) === BigInt(r.before)) pending.add(r.id);
    for (const f of next.sampleDelta.flags) if (state.flags.find(x => x.id === f.id)?.value === f.before) pendingFlags.add(f.id);
    for (const segment of next.sampleDelta.segments || []) if (segment.fields.some(f => state.segments?.[segment.id]?.[f.field] === f.before)) pending.add(segment.id);
  }
  return { pending, pendingFlags };
}
function sourceFocus(state) {
  const focus = new Set(), focusFlags = new Set();
  if (!state.frame || ['before', 'entry'].includes(state.provenance.position)) {
    for (const [id, value] of Object.entries(state.step.cpu.bits || {})) {
      const measured = state.flags.find(f => f.id === id);
      if (!state.frame || measured?.value !== value) { focusFlags.add(id); focus.add(id.split('.')[0]); }
    }
  }
  return { focus, focusFlags };
}
/** CPU values as seen at the current beat: changes not yet narrated keep their previous value. */
function cpuAtBeat(state) {
  const snapshot = snapshotAt(current);
  const values = { ...(snapshot?.registers || state.registers) };
  const segments = snapshot?.segments ? JSON.parse(JSON.stringify(snapshot.segments)) : null;
  const flagValues = new Map(state.flags.map(f => [f.id, f.value]));
  const hidden = new Set(), flipped = new Set(), changed = new Set(), hiddenFlags = new Set(), flippedFlags = new Set(), changedFlags = new Set();
  const plan = lesson.plan;
  for (const r of lesson.delta?.registers || []) {
    const at = revealedAt(plan.registers, r.id);
    if (at > beat) { values[r.id] = r.before; hidden.add(r.id); } else { changed.add(r.id); if (at === beat) flipped.add(r.id); }
  }
  for (const s of lesson.delta?.segments || []) {
    const at = revealedAt(plan.registers, s.id);
    if (at > beat) { if (segments?.[s.id]) for (const f of s.fields) segments[s.id][f.field] = f.before; hidden.add(s.id); }
    else { changed.add(s.id); if (at === beat) flipped.add(s.id); }
  }
  for (const f of lesson.delta?.flags || []) {
    const at = revealedAt(plan.flags, f.id);
    if (at > beat) { flagValues.set(f.id, f.before); hiddenFlags.add(f.id); } else { changedFlags.add(f.id); if (at === beat) flippedFlags.add(f.id); }
  }
  return { snapshot, values, segments, flagValues, hidden, flipped, changed, hiddenFlags, flippedFlags, changedFlags };
}
function renderRegisters(state, cpu, target) {
  const { snapshot, values } = cpu;
  const atEnd = beat === lesson.plan.last;
  const next = atEnd ? nextStepPending(state) : { pending: new Set(), pendingFlags: new Set() };
  const { focus, focusFlags } = sourceFocus(state);
  $('cpuMode').textContent = state.mode === '未逐指令采样' && snapshot ? `${snapshot.mode} · 最近采样` : state.mode;
  $('privilege').textContent = values.cpl == null ? 'CPL —' : `CPL ${values.cpl}${snapshot?.index !== current ? ' · 样本' : ''}`;
  $('cpuSample').textContent = snapshot ? (snapshot.index === current ? `实测 frame ${snapshot.frame.frameId} · ${Object.values(snapshot.registers).filter(v => v != null).length}/${allRegisters.length} 字段 · ${({ entry: '操作入口', after: '操作执行后', before: '操作执行前', waiting: '等待停点' })[state.provenance.position] || '检查停点'}${cpu.hidden.size ? ` · 还有 ${cpu.hidden.size} 处变化待讲到` : ''}` : `数值保留：${steps[snapshot.index].title}；本步即时值未采样`) : '尚无 CPU 采样 · 未知字段保留“未采样”';
  const relevant = id => cpu.hidden.has(id) || cpu.changed.has(id) || target.registers.has(id) || focus.has(id);
  $('registers').innerHTML = registerGroups.map(group => {
    const open = groupOverride.get(group.id) ?? (defaultOpenGroups.has(group.id) || group.items.some(r => relevant(r.id)));
    const items = group.items.map(r => {
      const value = values[r.id];
      const status = cpu.hidden.has(r.id) ? 'will-change' : cpu.changed.has(r.id) ? 'changed' : state.step.id === 'reset-vector' && value != null ? 'initialized' : next.pending.has(r.id) ? 'will-change' : focus.has(r.id) ? 'focus-field' : value == null ? 'unknown' : 'stable';
      const label = status === 'initialized' ? '复位后初始采样；比较起点为复位后初始采样' : status === 'changed' ? '本步实测净变化' : status === 'will-change' ? (cpu.hidden.has(r.id) ? '这一步稍后讲到时将变化' : '下一步已记录的数值将变化') : status === 'focus-field' ? '本步源码关注字段，尚未实测变化' : '';
      const delta = lesson.delta?.registers.find(d => d.id === r.id);
      const was = status === 'changed' && delta ? `<span class="register-was">原 ${esc(delta.before)}</span>` : '';
      const flip = cpu.flipped.has(r.id) || (lastShown.has(r.id) && lastShown.get(r.id) !== value && value != null);
      lastShown.set(r.id, value);
      const name = ({ linearPc: 'PC', cpl: 'CPL', kernelGsBase: 'KGS BASE', ftwAbridged: 'FTW8' })[r.id] || r.en.split(' / ')[0];
      return `<button class="register-row ${value == null ? 'unknown' : ''} ${status} ${target.registers.has(r.id) ? 'cue-hit' : ''} ${flip ? 'flip' : ''}" data-register="${r.id}" data-change="${status}" title="${esc(`${r.en} · ${r.zh}。${label}。值：${value ?? '未采样'}。${r.note}`)}"><span class="register-name">${esc(name)}<span>${esc(r.zh)}</span></span><span class="register-value">${esc(value ?? '未采样')}</span>${was}</button>`;
    }).join('');
    return `<section class="register-group ${open ? '' : 'collapsed'}" data-group="${group.id}"><button class="group-title" data-group-toggle="${group.id}" aria-expanded="${open}">${esc(group.en.toUpperCase())}<span>${esc(group.zh)} · ${group.items.length} ${open ? '▾' : '▸'}</span></button><div class="register-grid">${items}</div></section>`;
  }).join('');
  const cs = cpu.segments?.cs;
  $('segmentDetails').innerHTML = cs ? `<div class="segment-cache ${cpu.flipped.has('cs') || target.registers.has('cs') ? 'cue-hit' : ''}"><b>CS 隐藏缓存</b> base <code>${esc(cs.base)}</code> · limit <code>${esc(cs.limit)}</code> · attr <code>${esc(cs.attributes)}</code></div>` : '';
  function cells(ids) {
    return ids.map(id => {
      const f = state.flags.find(b => b.id === id);
      const value = cpu.flagValues.get(id);
      const status = cpu.hiddenFlags.has(id) ? 'will-change' : cpu.changedFlags.has(id) ? 'bit-changed' : next.pendingFlags.has(id) ? 'will-change' : focusFlags.has(id) ? 'focus-field' : 'stable';
      const label = status === 'bit-changed' ? '本步实测净变化' : status === 'will-change' ? (cpu.hiddenFlags.has(id) ? '这一步稍后讲到时将变化' : '下一步已记录的标志位将变化') : status === 'focus-field' ? '本步源码关注，尚未实测变化' : '';
      const key = `flag:${id}`;
      const flip = cpu.flippedFlags.has(id) || (lastShown.has(key) && lastShown.get(key) !== value && value != null);
      lastShown.set(key, value);
      return `<button class="flag-cell ${value ? 'on' : ''} ${f.kind === 'source-inferred' ? 'inferred' : ''} ${status} ${target.flagIds.has(id) ? 'cue-hit' : ''} ${flip ? 'flip' : ''}" data-flag="${f.id}" data-change="${status}" title="${esc(`${f.register.toUpperCase()}.${f.en} · ${f.zh}。${label}。${f.note}（${kindLabel(f.kind)}）`)}"><span class="flag-label"><b>${f.en}</b><small>${esc(f.zh)}</small></span><strong>${value ?? '?'}</strong></button>`;
    }).join('');
  }
  const shownFlag = f => coreFlags.has(f.en) || (f.en !== 'FIXED' && cpu.flagValues.get(f.id)) || cpu.hiddenFlags.has(f.id) || cpu.changedFlags.has(f.id) || target.flagIds.has(f.id) || focusFlags.has(f.id);
  $('rflags').innerHTML = cells(flagDefinitions.filter(f => f.register === 'rflags' && shownFlag(f)).map(f => f.id));
  $('modeFlags').innerHTML = cells(['cr0.PE', 'cr0.PG', 'cr0.WP', 'cr0.CD', 'cr4.PAE', 'cr4.PGE', 'efer.LME', 'efer.LMA', 'efer.NXE', 'efer.SCE', 'cr4.OSFXSR', 'cr4.OSXSAVE']);
  const scroll = $('cpuScroll');
  const spot = scroll.querySelector('.register-row.flip, .register-row.cue-hit');
  if (spot) {
    const box = scroll.getBoundingClientRect(), r = spot.getBoundingClientRect();
    if (r.top < box.top + 4 || r.bottom > box.bottom - 4) scroll.scrollTop += r.top - box.top - box.height / 3;
  }
}

/* ---------- machine & memory ---------- */

const components = [['cpu', 'CPU', '中央处理器'], ['rom', 'ROM', '固件存储'], ['ram', 'RAM', '物理内存'], ['disk', 'DISK', '根盘 / 引导盘'], ['tty', 'I/O', '终端与设备']];
const componentOf = id => ({ mmu: 'cpu', scheduler: 'cpu', filesystem: 'disk' })[id] || (/tty|vga|serial|keyboard|irq|uart|interrupt|timer/.test(id) ? 'tty' : id);
function renderMachine(state, cpu, target) {
  const step = state.step;
  const revealedMemory = step.memoryChanges.filter((m, i) => lesson.plan.memory[i] <= beat);
  const nowMemory = step.memoryChanges.filter((m, i) => lesson.plan.memory[i] === beat);
  const nowTerminal = lesson.plan.terminal.some(b => b === beat);
  const active = new Set(state.activeComponents.map(componentOf));
  const hit = new Set(target.components);
  if (cpu.flipped.size || cpu.flippedFlags.size) hit.add('cpu');
  for (const m of nowMemory) { hit.add(m.region === 'rom' ? 'rom' : 'ram'); hit.add('cpu'); }
  if (nowTerminal) hit.add('tty');
  $('topology').innerHTML = components.map(([id, en, zh]) => `<div class="component ${active.has(id) ? 'active' : ''} ${hit.has(id) ? 'cue-hit' : ''}" data-component="${id}"><b>${en}</b><small>${zh}</small></div>`).join('');
  const latest = nowMemory.at(-1) || revealedMemory.at(-1);
  const zhOf = id => memoryRegions.find(r => r.id === id)?.zh || id;
  $('busActivity').textContent = latest ? `CPU ${actionLabel(latest.action)} → ${zhOf(latest.region)}` : hit.size > 1 ? [...hit].map(id => components.find(c => c[0] === id)?.[1]).filter(Boolean).join(' ⇄ ') : state.stage.en;
  document.querySelector('.topology-panel').classList.toggle('bus-live', nowMemory.length > 0);
  const viewport = memoryOverview(machine.ramBytes);
  const snap = snapshotAt(current);
  const samples = physicalSamples(snap?.frame);
  $('memoryStart').textContent = hex(viewport.start);
  $('memoryEnd').textContent = hex(viewport.end - 1);
  $('memoryUnit').textContent = `${viewport.count} 格 · 每格 1 MiB`;
  $('memoryUnit').title = '按物理地址分组的显示单位；页表页大小由分页状态单独确定；复位时尚未开启分页，后续也可能使用 2 MiB 大页。';
  $('ramGrid').setAttribute('aria-label', `全部 512 MiB 物理地址 ${hex(viewport.start)} 到 ${hex(viewport.end - 1)}，每格 1 MiB`);
  const activeRegions = new Set(revealedMemory.map(m => m.region));
  const hitRegions = new Set([...target.regions, ...nowMemory.map(m => m.region)]);
  const regionsNow = state.memoryRegions.map(r => ({ ...r, active: activeRegions.has(r.id), hit: hitRegions.has(r.id) }));
  $('ramGrid').innerHTML = Array.from({ length: viewport.count }, (_, i) => {
    const cell = memoryCell(viewport, i, samples, snap?.memoryDelta?.windows || []);
    const { start, end } = cell;
    const overlaps = regionsNow.filter(r => r.start < end && r.end > start);
    const activeRegion = overlaps.find(r => r.hit) || overlaps.find(r => r.active);
    const r = activeRegion || overlaps.sort((a, b) => (Math.min(b.end, end) - Math.max(b.start, start)) - (Math.min(a.end, end) - Math.max(a.start, start)))[0];
    const known = cell.windows.length > 0;
    const note = known ? `${snap.index === current ? '本停点' : '最近停点'} frame ${snap.frame.frameId} · ${cell.value !== null ? `字节 ${cell.value}` : '格内有采样窗口，未必覆盖全格'} · ${snap.frame.captureId}` : '未采样；字节内容和分配状态待确认';
    return `<button class="ram-cell ${activeRegion?.active ? 'active' : r?.lastChange ? 'used' : ''} ${activeRegion?.hit ? 'cue-hit' : ''} ${known ? 'sampled' : ''} ${cell.changed ? 'observed-change' : ''}" style="--region-color:${r?.color || '#ba826a'}" data-address="${start}" ${r ? `data-region="${r.id}"` : ''} title="${esc(`${hex(start)}–${hex(end - 1)} · ${overlaps.map(r => r.zh).join(' / ')} · ${note}`)}" aria-label="${esc(`内存格 ${i + 1}：${hex(start)} 到 ${hex(end - 1)}，${note}`)}"></button>`;
  }).join('');
  $('ramLegend').innerHTML = regionsNow.filter(r => r.start >= 0x100000).map(r => `<span class="${r.hit ? 'cue-hit' : ''}" style="--region-color:${r.color}"><i></i>${esc(r.zh)}</span>`).join('') + '<span class="legend-note">描边：格内有采样</span>';
  $('lowMap').innerHTML = regionsNow.filter(r => r.end <= 0x100000).map(r => `<button class="low-region ${r.active ? 'active' : ''} ${r.hit ? 'cue-hit' : ''} ${selectedRegion === r.id ? 'selected' : ''}" data-region="${r.id}" style="--region-color:${r.color}" title="${esc(`${r.zh} / ${r.en} · ${hex(r.start)}–${hex(r.end - 1)} · ${r.end - r.start} B · ${r.note}`)}">${esc(hex(r.start))}<small>${esc(({ ivt: '中断向量', bda: 'BIOS数据', low: '低位RAM', boot: '引导窗口', setup: '引导工作', vga: '显存', rom: '固件窗口' })[r.id] || '低位RAM')}</small></button>`).join('');
  const focusRegion = regionsNow.find(r => r.id === selectedRegion) || (latest && regionsNow.find(r => r.id === latest.region)) || regionsNow.find(r => r.hit) || regionsNow.find(r => r.active) || regionsNow[0];
  const change = latest && latest.region === focusRegion.id ? latest : null;
  $('regionDetail').innerHTML = `${change ? `<em class="${nowMemory.includes(change) ? 'live' : ''}">${esc(actionLabel(change.action))}</em>` : ''}<strong>${esc(focusRegion.zh)}</strong> <code>${hex(focusRegion.start)}–${hex(focusRegion.end - 1)}</code>${change ? `<span>${gloss(change.text)}</span>` : ''}`;
  $('regionDetail').title = focusRegion.note;
  const reset = snap ? getStepState('reset-vector') : null;
  const rom = { start: 0xfffffff0, end: 0x100000000, cellBytes: 1, count: 16 };
  const romHit = target.regions.has('rom') && /0xfffffff0|复位向量|FAR JMP|ea 5b/i.test(lesson.cues[beat]?.text || '');
  $('resetRomBytes').innerHTML = Array.from({ length: rom.count }, (_, i) => {
    const cell = memoryCell(rom, i, physicalSamples(reset?.frame));
    const note = reset ? `复位帧 ${reset.frame.frameId} · ${reset.frame.captureId}；来源为复位停点记录` : '断电状态：字节内容缺省';
    return `<span class="${romHit && i < 5 ? 'cue-hit' : ''}" data-address="${hex(cell.start)}" title="${esc(`${hex(cell.start)} · ${note}`)}">${cell.value ?? '??'}</span>`;
  }).join('');
  $('virtualMap').innerHTML = step.stageIndex >= 7 ? virtualRegions.slice(0, 3).map(r => `<span title="${esc(r.note)}">${esc(r.en)} ${esc(r.address)}</span>`).join('') : '';
  document.querySelector('.ram-panel').classList.toggle('cue-panel', hitRegions.size > 0);
  document.querySelector('.bytes-panel').classList.toggle('cue-panel', target.bytes);
}
function renderMemory() {
  const snap = snapshotAt(current);
  memoryItems = [];
  if (snap) for (const [i, m] of (snap.frame.memory || []).entries()) memoryItems.push({ ...m, id: `frame:${i}`, title: `${({ pc: '指令窗口', stack: '栈窗口' })[m.label] || m.label || '内存样本'} ${m.address}`, bytes: m.bytes || m.hex, note: `${snap.index === current ? '本停点历史样本' : '保留最近停点'} · frame ${snap.frame.frameId} · ${m.addressSpace === 'linear' ? '线性地址' : m.addressSpace === 'physical' ? '物理地址' : m.addressSpace} · ${m.length} B${m.coverage === 'read-failed' ? ' · 读取失败' : ''}`, sourceNote: `${m.note || ''} ${m.captureId || m.attribution?.captureId || snap.frame.captureId}` });
  for (const m of snap ? lowMemorySamples : []) {
    const capture = m.captureId || m.attribution?.captureId;
    const physical = m.addressSpace === 'physical';
    memoryItems.push({ ...m, id: `low:${m.address}`, title: `${physical ? '完成停点物理回读' : '历史回读'} ${m.address}`, bytes: m.hex || m.bytes, note: capture ? `完成停点 frame ${m.frameId ?? m.attribution?.frameId} · ${physical ? '物理地址' : m.addressSpace} · ${m.length} B · ${capture}` : `历史回读 · 逐段采集时点/地址空间未记录 · ${m.length} B${m.coverage === 'read-failed' ? ' · 读取失败' : ''}`, sourceNote: m.note });
  }
  if (!memoryItems.some(m => m.id === selectedMemory)) selectedMemory = memoryItems[0]?.id || '';
  $('memorySelect').innerHTML = memoryItems.map(m => `<option value="${esc(m.id)}" ${m.id === selectedMemory ? 'selected' : ''}>${esc(m.title)}</option>`).join('');
  const deltas = snap?.memoryDelta?.windows || [];
  for (const item of memoryItems) {
    item.delta = deltas.find(w => w.addressSpace === item.addressSpace && BigInt(w.address) === BigInt(item.address) && w.length === item.length && (item.captureId || item.attribution?.captureId || snap?.frame.captureId) === w.afterCaptureId);
    if (item.coverage === 'read-failed') {
      const translation = snap?.frame.translations?.find(t => t.translation?.linear === item.address);
      item.unavailableNote = translation?.translation?.fault?.kind === 'not-present' ? '页表检查显示该指令页尚未驻留；本停点的指令字节缺采。' : `本停点读取失败：${item.reason || '该窗口未记录'}`;
    }
  }
  renderHex();
}
function renderHex() {
  const item = memoryItems.find(m => m.id === selectedMemory);
  if (!item) { $('hexDump').textContent = '尚无内存采样'; $('memoryProvenance').textContent = ''; return; }
  $('memoryProvenance').textContent = item.note + (item.delta ? ` · ${item.delta.changedBytes}/${item.length} 字节发生净变化` : '');
  $('memoryProvenance').title = item.sourceNote || item.note;
  const bytes = (item.bytes || '').match(/.{2}/g) || [];
  const lines = [];
  for (let i = 0; i < bytes.length; i += 8) {
    const row = bytes.slice(i, i + 8);
    const ascii = row.map(b => { const n = parseInt(b, 16); return n >= 32 && n <= 126 ? String.fromCharCode(n) : '·'; }).join('');
    const styled = row.map((b, j) => item.delta?.changedOffsets.includes(i + j) ? `<span class="byte-changed" title="之前 ${esc(item.delta.beforeBytes.slice((i + j) * 2, (i + j) * 2 + 2))} → ${esc(b)}">${esc(b)}</span>` : esc(b)).join(' ');
    lines.push(`${(BigInt(item.address) + BigInt(i)).toString(16).padStart(8, '0')}  ${styled}${' '.repeat(Math.max(0, (8 - row.length) * 3))}  ${esc(ascii)}`);
  }
  $('hexDump').innerHTML = lines.join('\n') || esc(item.unavailableNote || item.reason || '该窗口字节缺采；可查看本帧其他已采样窗口。');
}
function renderTerminal(state, target) {
  const shown = lesson.terminalLines.filter((_, j) => lesson.plan.terminal[j] <= beat);
  const fresh = new Set(lesson.terminalLines.filter((_, j) => lesson.plan.terminal[j] === beat));
  const lines = [...lesson.terminalBefore.map(line => ({ line })), ...shown.map(line => ({ line, fresh: fresh.has(line) }))];
  const caret = current > steps.findIndex(s => s.id === 'login-shell') || (current === steps.findIndex(s => s.id === 'login-shell') && beat === lesson.plan.last);
  $('terminalOutput').innerHTML = lines.length ? lines.map(l => `<span class="${l.fresh ? 'line-new' : ''}">${esc(l.line)}</span>`).join('\n') + (caret ? '<span class="terminal-caret"></span>' : '') : '<span class="terminal-empty">终端尚未建立\nCPU 正在完成启动工作。</span>';
  $('terminalStatus').textContent = state.step.stageIndex >= 13 ? '等待输入 / idle' : state.step.stageIndex >= 12 ? '启动 shell' : '启动中';
  const snap = snapshotAt(current);
  const tasks = snap?.frame.os?.processes || [];
  const currentTask = snap?.frame.os?.current;
  $('processes').innerHTML = currentTask ? `<b>最近采样 current</b><br>PID ${currentTask.pid} · ${esc(currentTask.comm)}<br>${esc(currentTask.state)}${tasks.length ? `<br><b>${tasks.length} 个采样任务</b><br>${tasks.filter(t => [0, 1, 2].includes(t.pid) || t.comm === 'sh').map(t => `${t.pid} ${esc(t.comm)} · ${esc(t.state)}`).join('<br>')}` : ''}` : state.step.stageIndex >= 9 ? '<b>进程关系 · 源码示意</b><br>PID 0 → PID 1 (init)<br>PID 0 → PID 2 (kthreadd)' : '尚无 Linux 任务采样';
  document.querySelector('.terminal-panel').classList.toggle('cue-panel', target.terminal || fresh.size > 0);
  const output = $('terminalOutput'); output.scrollTop = output.scrollHeight;
}

/* ---------- lesson panel ---------- */

function renderLessonStatic(state) {
  const s = state.step;
  $('lessonStage').textContent = `${pad(s.stageIndex + 1)} · ${state.stage.title}`;
  $('stepNumber').textContent = `第 ${pad(current + 1)} / ${steps.length} 步`;
  $('lessonTitle').innerHTML = gloss(s.title);
  $('notesTitle').firstChild.textContent = annotate(s.title);
  $('notesStage').textContent = `${state.stage.title} · 第 ${current + 1} 步`;
  $('summary').innerHTML = gloss(s.summary);
  $('detail').innerHTML = gloss(s.detail);
  renderStartupFacts(state);
  $('evidenceBadge').className = `evidence-badge ${state.provenance.kind}`;
  $('evidenceBadge').textContent = state.provenance.label + (state.frame ? ` · ${({ entry: '操作入口', after: '执行后', before: '执行前', waiting: '等待停点' })[state.provenance.position] || '检查停点'}` : '');
  const sourceChanges = Object.entries(s.cpu.bits || {}).map(([id, value]) => {
    const f = flagDefinitions.find(f => f.id === id);
    return `<div class="change-row"><code>${esc(id.toUpperCase())} = ${value}</code><span>${esc(f?.zh || '')} · 源码条件</span></div>`;
  });
  const delta = state.sampleDelta;
  const measured = delta ? [`<p class="tiny">frame ${delta.fromFrameId} → ${delta.toFrameId} 的净变化；点击寄存器查看。</p>`, ...(delta.flags || []).map(f => `<div class="change-row"><code>${esc(f.register.toUpperCase())}.${esc(f.en)}</code><span>${f.before} → ${f.after} · ${esc(f.zh)}</span></div>`), ...delta.registers.map(r => `<div class="change-row"><code>${esc(r.id.toUpperCase())}</code><span>${esc(r.before)} → ${esc(r.after)}</span></div>`), ...(delta.segments || []).flatMap(s => s.fields.map(f => `<div class="change-row"><code>${esc(s.id.toUpperCase())}.${esc(f.field)}</code><span>${esc(f.before)} → ${esc(f.after)}</span></div>`))] : [];
  const observedMemory = state.memoryDelta ? [`<div class="change-row"><code class="memory-op">实测字节</code><span>frame ${state.memoryDelta.fromFrameId} → ${state.memoryDelta.toFrameId}，共同窗口中 ${state.memoryDelta.changedBytes} 字节发生净变化。${esc(state.memoryDelta.note)}</span></div>`] : [];
  const mem = s.memoryChanges.map(m => `<div class="change-row"><code class="memory-op">${esc(m.action.toUpperCase())}</code><span>${esc(memoryRegions.find(r => r.id === m.region)?.zh || m.region)} · ${gloss(m.text)}</span></div>`);
  $('changes').innerHTML = [...sourceChanges, ...observedMemory, ...measured, ...mem].join('') || '<div class="tiny">本步说明操作关系；数值证据仅来自已记录停点。</div>';
  $('codeKind').textContent = '教学简码 · 点下方看原文';
  $('code').innerHTML = s.code.split('\n').map((line, i) => `<span class="code-line" data-line="${i + 1}">${esc(line)}</span>`).join('');
  $('sourceRefs').innerHTML = s.sourceRefs.map((r, i) => `<button class="source-ref" data-source="${i}">${esc(r.symbol)} ↗<small>${esc(r.path)}:${r.line}</small></button>`).join('');
  const p = state.provenance;
  $('evidenceDetails').innerHTML = state.frame ? `<b>session ${esc(p.sessionId.slice(0, 8))} · frame ${p.frameId}</b><br>${esc(p.capturedAt || '历史捕获')}<br>${esc(p.note || 'GDB/MI 与 QEMU 观察扩展的同一停止点。')}${delta ? `<br>${esc(delta.note)}` : ''}` : `${esc(p.note)}<br>CPU 数值栏保留最近历史采样；本步标志位只显示已知条件。`;
  $('lyrics').innerHTML = lesson.cues.map((cue, i) => `<li data-beat="${i}"><span class="lyric-index">${i + 1}</span><span class="lyric-text">${gloss(cue.text)}</span></li>`).join('');
  $('beatDots').innerHTML = lesson.cues.map((_, i) => `<i data-beat="${i}"></i>`).join('');
}
function renderStartupFacts(state) {
  const facts = state.step.startupFacts || [];
  let html = facts.length ? `<table><tbody>${facts.map(f => `<tr><th>${gloss(f.label)}</th><td>${gloss(f.text)}</td></tr>`).join('')}</tbody></table>` : '';
  if (state.step.id === 'reset-vector' && state.frame) {
    const notes = {
      general: 'RDX 是本 qemu64 的 CPU 版本签名；其余本次为零，其他硬件须按对应采样结果确认。',
      execution: 'IP、FLAGS 由复位建立；线性 PC、CPL 是对该状态的解释。FLAGS[1]=1、IF=0。',
      control: 'CR0.PE=PG=0、CD=NW=ET=1；此时线性地址直接对应物理地址，CPU 处于实模式。',
      segments: '选择子初值；隐藏 base/limit/attributes 另列。',
      tables: 'base=0 和 limit=0xffff 是描述符表寄存器初值，表内容和有效入口需另行确认。',
      debug: 'DR6 的保留位、DR7 固定位导致非零；本次未启用硬件断点。',
      floating: 'FCW/MXCSR 建立异常屏蔽等控制；ST 原始位为零、标签为空，对应 8 个空浮点栈槽。',
      msr: '只列已采集值；未知字段保留缺采状态，各 MSR 初值按采样结果确认。',
    };
    html += '<h3>CPU 复位初值 · 本次实测</h3><p class="tiny">此表列复位后初始状态，比较起点为本次初始采样。相同值合并列出，未采样仍保留未知。</p><table><thead><tr><th>字段</th><th>初值</th></tr></thead><tbody>';
    for (const group of registerGroups) {
      const values = new Map();
      for (const field of group.items) {
        const raw = state.registers[field.id];
        const value = raw == null ? '未采样' : hex(raw);
        if (!values.has(value)) values.set(value, []);
        values.get(value).push(field.en.split(' / ')[0]);
      }
      html += `<tr><th colspan="2">${esc(group.zh)}<small>${esc(notes[group.id])}</small></th></tr>`;
      for (const [value, names] of values) html += `<tr><td>${esc(names.join(', '))}</td><td><code>${esc(value)}</code></td></tr>`;
    }
    html += '</tbody></table><h3>段缓存 · 本次实测</h3><table><tbody>';
    for (const [name, segment] of Object.entries(state.segments)) html += `<tr><th>${esc(name.toUpperCase())}</th><td><code>base=${esc(segment.base)}<br>limit=${esc(segment.limit)}<br>attr=${esc(segment.attributes)}</code></td></tr>`;
    html += '</tbody></table><h3>复位时内存里已有 / 尚未装入</h3><p class="tiny">ROM 字节已经由机器映射提供；RAM 样本名称仅标记观察地址，对象存在性需以对应结构采样确认。</p><table><tbody>';
    for (const item of state.memory.filter(m => m.label !== 'stack physical window')) {
      const bytes = item.bytes || item.hex;
      const status = bytes ? /^0+$/.test(bytes) ? '本窗口全为 00；尚无已装入对象' : `已有字节 ${bytes.slice(0, 10).match(/../g).join(' ')}…` : '未采样';
      html += `<tr><th><code>${esc(item.address)}</code><small>${item.length} B · ${esc(item.label)}</small></th><td>${esc(status)}</td></tr>`;
    }
    html += '</tbody></table><p class="tiny">CPU 取指来源为映射的 ROM 区域。固件随后建立工作数据、读取引导镜像；GRUB 随后加载 bzImage 和 initramfs。窗口外未采样，此处证据范围限于已采样窗口。</p>';
  }
  $('startupFacts').innerHTML = html;
}
function beatChangeChips(cpu, target) {
  const chips = [];
  for (const r of lesson.delta?.registers || []) if (cpu.flipped.has(r.id)) chips.push(`<span class="chip reg"><b>${gloss(({ linearPc: 'PC' })[r.id] || r.id.toUpperCase())}</b>${esc(r.before)} → ${esc(r.after)}</span>`);
  for (const s of lesson.delta?.segments || []) if (cpu.flipped.has(s.id)) for (const f of s.fields) chips.push(`<span class="chip reg"><b>${gloss(`${s.id.toUpperCase()}.${f.field}`)}</b>${esc(f.before)} → ${esc(f.after)}</span>`);
  for (const f of lesson.delta?.flags || []) if (cpu.flippedFlags.has(f.id)) chips.push(`<span class="chip flag"><b>${gloss(`${f.register.toUpperCase()}.${f.en}`)}</b>${f.before} → ${f.after}</span>`);
  lesson.step.memoryChanges.forEach((m, i) => { if (lesson.plan.memory[i] === beat) chips.push(`<span class="chip mem"><b>${esc(actionLabel(m.action))}</b>${esc(memoryRegions.find(r => r.id === m.region)?.zh || m.region)}</span>`); });
  const lines = lesson.plan.terminal.filter(b => b === beat).length;
  if (lines) chips.push(`<span class="chip tty"><b>终端</b>新增 ${lines} 行输出</span>`);
  const mentioned = [...[...target.registers].filter(id => !cpu.flipped.has(id)).map(id => allRegisters.find(r => r.id === id)?.en.split(' / ')[0] || id), ...[...target.flagIds].filter(id => !cpu.flippedFlags.has(id)).map(id => id.replace(/^(\w+)\./, (_, r) => `${r.toUpperCase()}.`)), ...[...target.components].map(id => components.find(c => c[0] === id)?.[1])].filter(Boolean);
  const limit = 6;
  const extra = chips.length > limit ? `<span class="chip more">另有 ${chips.length - limit} 项 · 见完整讲义</span>` : '';
  const shownChips = chips.slice(0, limit).join('') + extra;
  const mentions = [...new Set(mentioned)].slice(0, 8).map(name => `<span class="chip ref">${gloss(name)}</span>`).join('');
  return (shownChips || '<span class="chip none">这一句只做说明，状态不变</span>') + (mentions ? `<span class="chip-label">看这里</span>${mentions}` : '');
}
function renderLyrics(cpu, target) {
  const list = $('lyrics');
  for (const li of list.children) {
    const i = Number(li.dataset.beat);
    li.className = i < beat ? 'past' : i === beat ? 'current' : 'future';
  }
  for (const dot of $('beatDots').children) dot.className = Number(dot.dataset.beat) < beat ? 'past' : Number(dot.dataset.beat) === beat ? 'current' : '';
  const li = list.children[beat];
  if (li) list.scrollTo({ top: li.offsetTop - list.clientHeight / 2 + li.offsetHeight / 2, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('beatChanges').innerHTML = beatChangeChips(cpu, target);
  const hits = new Set(target.codeLines);
  for (const line of $('code').children) line.classList.toggle('code-hit', hits.has(Number(line.dataset.line)));
}

/* ---------- render & navigation ---------- */

function renderBeat(updateHash = true) {
  const state = lesson.state;
  const target = lesson.targets[beat] || { registers: new Set(), flagIds: new Set(), components: new Set(), regions: new Set(), terminal: false, bytes: false, codeLines: [] };
  const cpu = cpuAtBeat(state);
  document.body.dataset.beat = String(beat);
  renderRegisters(state, cpu, target);
  renderMachine(state, cpu, target);
  renderTerminal(state, target);
  renderLyrics(cpu, target);
  document.querySelector('.cpu-panel').classList.toggle('cue-panel', target.registers.size > 0 || target.flagIds.size > 0 || cpu.flipped.size > 0);
  $('positionLabel').textContent = annotate(`${state.stage.title} · ${state.step.title}`);
  $('progressLabel').textContent = `第 ${pad(current + 1)} / ${steps.length} 步 · 第 ${beat + 1} / ${lesson.cues.length} 句`;
  $('prevBtn').disabled = current === 0 && beat === 0;
  $('nextBtn').disabled = current === steps.length - 1 && beat === lesson.plan.last;
  if (updateHash) history.replaceState(null, '', `#${state.step.id}${beat ? `@${beat + 1}` : ''}`);
}
function render(index, beatIndex = 0, updateHash = true) {
  current = Math.max(0, Math.min(steps.length - 1, index));
  lesson = buildLesson(current);
  beat = Math.max(0, Math.min(lesson.plan.last, beatIndex));
  const state = lesson.state;
  document.body.dataset.step = state.step.id;
  document.documentElement.style.setProperty('--accent', state.stage.color);
  renderLessonStatic(state);
  renderMemory();
  $('seek').value = String(current);
  $('prevStepBtn').disabled = current === 0; $('nextStepBtn').disabled = current === steps.length - 1;
  document.querySelectorAll('.stage-button').forEach((b, i) => { b.classList.toggle('active', i === state.step.stageIndex); b.classList.toggle('past', i < state.step.stageIndex); b.setAttribute('aria-current', String(i === state.step.stageIndex)); });
  document.querySelector('.stage-button.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  document.title = `${state.step.title} · Linux 启动全景`;
  if ($('outlineDialog').open) renderOutline($('outlineSearch').value);
  renderBeat(updateHash);
}
function setBeat(index, { fromClock = false } = {}) {
  const next = Math.max(0, Math.min(lesson.plan.last, index));
  if (next === beat) return;
  beat = next;
  renderBeat();
  if (!fromClock) syncClockToBeat();
}
function renderOutline(query = '') {
  const search = query.trim().toLowerCase();
  $('outlineList').innerHTML = stages.map((stage, stageIndex) => {
    const items = steps.filter(s => s.stageIndex === stageIndex && (!search || `${s.title} ${s.summary} ${s.detail} ${s.code} ${stage.title} ${stage.en}`.toLowerCase().includes(search)));
    return items.length ? `<section class="outline-stage"><h3>${pad(stageIndex + 1)} ${esc(stage.title)}</h3>${items.map(s => `<button class="outline-item ${current === s.index ? 'active' : ''}" data-step="${s.index}"><span class="number">${pad(s.index + 1)}</span><span>${gloss(s.title)}</span><span class="beat-count">${splitCues(s.narration).length} 句</span>${s.evidenceKey ? '<span class="sample-dot" title="真实历史停点">●</span>' : ''}</button>`).join('')}</section>` : '';
  }).join('') || '<p class="tiny">教学步骤匹配结果为空。</p>';
}

/* ---------- playback clock ---------- */

function clearPlaybackTimer() { clearTimeout(timer); timer = null; cancelAnimationFrame(frameRequest); frameRequest = 0; }
function updatePlayButton() {
  $('playBtn').textContent = playing ? 'Ⅱ 暂停' : '▶ 连续播放';
  document.body.classList.toggle('is-playing', playing);
  $('playState').textContent = playing ? '正在讲解 · 可随时逐句' : (current === steps.length - 1 && beat === lesson.plan.last ? '已到达终端 · 可回看' : '已暂停 · ← → 逐句 · PgUp/PgDn 换步');
}
const silentDuration = () => lesson.step.duration * 1000 / speed;
function silentStarts() { return estimateStarts(lesson.cues, silentDuration() / 1000, 0, 0); }
const speaking = () => ['playing', 'loading'].includes(currentSpeech.status);
const silentPlaying = () => playing && !$('narrateToggle').checked;
function tick() {
  frameRequest = 0;
  if (silentPlaying()) {
    const elapsed = silentElapsed + performance.now() - silentStarted;
    if (elapsed >= silentDuration()) { advance(); return; }
    setBeat(cueAt(silentStarts(), elapsed / 1000), { fromClock: true });
  } else if (currentSpeech.source === 'audio' && currentSpeech.status === 'playing') {
    const at = speech.getPosition();
    if (at) setBeat(cueAt(beatStarts(at.duration), at.position), { fromClock: true });
  }
  if (playing || speaking()) frameRequest = requestAnimationFrame(tick);
}
function startClock() { cancelAnimationFrame(frameRequest); frameRequest = requestAnimationFrame(tick); }
function syncClockToBeat() {
  if (silentPlaying()) { silentElapsed = silentStarts()[beat] * 1000; silentStarted = performance.now(); return; }
  if (!speaking()) return;
  if (currentSpeech.source === 'audio') {
    const at = speech.getPosition();
    speech.seek(beatStarts(at?.duration)[beat]);
  } else { const auto = playing; playbackGeneration++; speech.stop(); void speakStep(auto); }
}
const speech = window.PanoramaSpeech.create({
  onState(state) {
    currentSpeech = state;
    const status = { idle: '旁白按当前句同步', loading: '正在准备旁白…', playing: state.source === 'audio' ? '中文神经网络配音 · 播放中' : '浏览器中文朗读中', paused: '旁白已暂停', ended: '本步旁白结束', error: state.error?.message || '旁白暂不可用' };
    $('speechStatus').textContent = status[state.status] || '';
    $('speakBtn').textContent = state.status === 'playing' ? 'Ⅱ 暂停旁白' : state.status === 'paused' ? '▶ 继续旁白' : '◖)) 朗读';
    if (state.status === 'error' && playing && endAfterSpeech) {
      playing = false; clearPlaybackTimer(); playbackGeneration++; endAfterSpeech = false; updatePlayButton();
      $('playState').textContent = '语音未能播放 · 点击朗读重试，或关闭随播放朗读';
    }
  },
  onBoundary({ id, charIndex }) {
    if (id !== lesson.step.id) return;
    const at = charIndex + speechOffset;
    let index = 0;
    lesson.cues.forEach((cue, i) => { if (at >= cue.start) index = i; });
    setBeat(index, { fromClock: true });
  },
  onVoices: renderVoices,
});
function renderVoices(voices) {
  const old = $('voiceSelect').value;
  $('voiceSelect').innerHTML = '<option value="">默认中文声线</option>' + voices.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  if (voices.some(v => v.voiceURI === old)) $('voiceSelect').value = old;
}
async function speakStep(auto = false) {
  const token = playbackGeneration;
  const index = current;
  await audioReady;
  if (token !== playbackGeneration || index !== current || auto && !playing) return;
  endAfterSpeech = auto;
  const step = steps[current];
  const text = step.narration || `${step.title}。${step.summary}${step.detail}`;
  const cue = lesson.cues[beat];
  speechOffset = cue?.start || 0;
  const words = narratorWords[step.id];
  const measured = narratorCues[step.id];
  const exact = Array.isArray(measured) && measured.length === lesson.cues.length
    ? beatStarts() : words && startsFromWords(lesson.cues, text, words);
  const startFraction = beat && !exact ? estimateStarts(lesson.cues, 1, 0.01, 0.03)[beat] : 0;
  const pending = speech.play({ id: step.id, text: text.slice(speechOffset), startAt: exact ? exact[beat] : undefined, startFraction, rate: speed });
  startClock();
  const result = await pending;
  if (auto && token === playbackGeneration && playing && result.status === 'ended') {
    endAfterSpeech = false;
    setBeat(lesson.plan.last, { fromClock: true });
    timer = setTimeout(() => advance(), 700 / speed);
  }
}
function startCurrent() {
  clearPlaybackTimer();
  if ($('narrateToggle').checked) void speakStep(true);
  else { silentElapsed = silentStarts()[beat] * 1000; silentStarted = performance.now(); startClock(); }
}
function advance() {
  if (!playing) return;
  if (current >= steps.length - 1) { setBeat(lesson.plan.last, { fromClock: true }); pause(); return; }
  playbackGeneration++; render(current + 1); startCurrent();
}
function pause() {
  if (!playing) return;
  playing = false;
  if (!$('narrateToggle').checked) silentElapsed += performance.now() - silentStarted;
  clearPlaybackTimer();
  speechResume = ['playing', 'loading'].includes(currentSpeech.status);
  if (speechResume) speech.pause();
  updatePlayButton();
}
function play() {
  if (playing) { pause(); return; }
  if (current === steps.length - 1 && beat === lesson.plan.last) { speech.stop(); render(0); speechResume = false; }
  playing = true; updatePlayButton();
  if (speechResume && currentSpeech.status === 'paused' && $('narrateToggle').checked) { speechResume = false; speech.resume(); startClock(); }
  else if (!$('narrateToggle').checked && silentElapsed > 0) { silentStarted = performance.now(); startClock(); }
  else startCurrent();
}
function go(index, beatIndex = 0) {
  playing = false; clearPlaybackTimer(); playbackGeneration++; speechResume = false; endAfterSpeech = false; silentElapsed = 0; speech.stop(); render(index, beatIndex); updatePlayButton();
}
function stepBeat(direction) {
  const target = beat + direction;
  if (target >= 0 && target <= lesson.plan.last) {
    if (!playing && !speaking()) { speech.stop(); speechResume = false; silentElapsed = 0; }
    setBeat(target);
    updatePlayButton();
    return;
  }
  const nextStep = current + direction;
  if (nextStep < 0 || nextStep >= steps.length) return;
  if (playing) { playbackGeneration++; speech.stop(); render(nextStep, direction > 0 ? 0 : Infinity); startCurrent(); }
  else go(nextStep, direction > 0 ? 0 : Infinity);
}

/* ---------- wiring ---------- */

$('stageTrack').innerHTML = stages.map((s, i) => `<button class="stage-button" data-stage="${i}" title="${esc(`${s.title} / ${s.en}`)}"><small>${pad(i + 1)} / ${esc(s.en.split(' / ')[0])}</small>${esc(s.title)}</button>`).join('');
$('microTicks').innerHTML = steps.map(s => `<i class="${s.evidenceKey ? 'checkpoint' : ''}"></i>`).join('');
$('seek').max = String(steps.length - 1);
$('outlineCount').textContent = `${stages.length} 个阶段 · ${steps.length} 个步骤 · ${steps.reduce((n, s) => n + splitCues(s.narration).length, 0)} 句逐句解说 · ${steps.filter(s => s.evidenceKey).length} 个实测停点`;
$('stageTrack').addEventListener('click', e => { const b = e.target.closest('[data-stage]'); if (b) go(steps.findIndex(s => s.stageIndex === Number(b.dataset.stage))); });
$('registers').addEventListener('click', e => {
  const toggle = e.target.closest('[data-group-toggle]');
  if (toggle) { const id = toggle.dataset.groupToggle; groupOverride.set(id, toggle.getAttribute('aria-expanded') !== 'true'); renderBeat(false); return; }
  const b = e.target.closest('[data-register]'); if (b) registerDetail(b.dataset.register);
});
for (const id of ['rflags', 'modeFlags']) $(id).addEventListener('click', e => { const b = e.target.closest('[data-flag]'); if (b) { const f = getStepState(current).flags.find(f => f.id === b.dataset.flag); inspect(`${f.register.toUpperCase()}.${f.en} · ${f.zh}`, flagTable([f])); } });
$('allFlagsBtn').onclick = () => inspect('全部状态位与控制位 / Flags & control bits', `<p>本步已知位来自历史采样或源码条件；问号表示证据缺省。保留位按架构定义展示。</p>${flagTable(getStepState(current).flags)}`);
$('ramGrid').addEventListener('click', e => {
  const b = e.target.closest('[data-address]'); if (!b) return;
  selectedRegion = b.dataset.region || null;
  renderBeat(false);
});
$('lowMap').addEventListener('click', e => {
  const b = e.target.closest('[data-region]'); if (!b) return;
  selectedRegion = b.dataset.region;
  renderBeat(false);
  const sample = memoryItems.find(m => m.region === selectedRegion);
  if (sample) { selectedMemory = sample.id; $('memorySelect').value = selectedMemory; renderHex(); }
});
$('lyrics').addEventListener('click', e => { const li = e.target.closest('[data-beat]'); if (li) setBeat(Number(li.dataset.beat)); });
$('memorySelect').onchange = e => { selectedMemory = e.target.value; renderHex(); };
$('nextBtn').onclick = () => stepBeat(1); $('prevBtn').onclick = () => stepBeat(-1);
$('nextStepBtn').onclick = () => go(current + 1); $('prevStepBtn').onclick = () => go(current - 1);
$('restartBtn').onclick = () => go(0); $('playBtn').onclick = play; $('seek').oninput = e => go(Number(e.target.value));
$('notesBtn').onclick = () => openDialog('notesDialog');
$('outlineBtn').onclick = () => { renderOutline(); openDialog('outlineDialog'); $('outlineSearch').focus(); };
$('outlineSearch').oninput = e => renderOutline(e.target.value);
$('outlineList').onclick = e => { const b = e.target.closest('[data-step]'); if (b) { go(Number(b.dataset.step)); $('outlineDialog').close(); } };
$('fullscreenBtn').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { $('playState').textContent = '浏览器未允许全屏'; } };
$('helpBtn').onclick = () => inspect('怎样跟着这台机器学', `<h3>一句一小步</h3><p>每个启动步骤拆成若干句解说。播放时字幕随配音逐句推进；暂停时按 <b>→ / ←</b> 逐句前进后退，<b>PageDown / PageUp</b> 跳到下一步 / 上一步，点击右侧任意一句可直接跳到那里。空格播放 / 暂停，F 全屏，O 目录。</p><h3>组件跟着这句话变</h3><table><tr><th>显示</th><th>含义</th></tr><tr><td>发光边框</td><td>当前这句话正在讲的寄存器、标志位、部件或内存区域。</td></tr><tr><td>虚线闪烁</td><td>这一步里稍后会讲到的变化：数值仍是变化前的值。</td></tr><tr><td>金色实线 + “原 …”</td><td>已经发生的变化，下方小字是变化前的值。</td></tr><tr><td>“这一句”卡片</td><td>本句让哪些值从什么变成什么、读写了哪块内存。</td></tr></table><h3>读懂证据</h3><table><tr><th>显示</th><th>含义</th></tr><tr><td>绿色 / 历史采样</td><td>真实 QEMU 停点；可查看 session、frame 和采集依据。</td></tr><tr><td>金色 / 源码推导</td><td>该段代码能够确定的条件；证据来源为源码推导。</td></tr><tr><td>未采样 / ?</td><td>该字段的本步值缺采。</td></tr></table><p>寄存器数值的变化是相邻两个真实停点之间的净变化；逐句呈现是讲解顺序，用来把每处变化对到对应的一句话上。完整文字、复位初值表和证据见“完整讲义”。</p><h3>实验范围</h3><p>${machine.boundaries.map(esc).join('<br>')}</p><p>${esc(machine.provenance)}</p>`);
$('sourceRefs').onclick = async e => {
  const b = e.target.closest('[data-source]'); if (!b) return;
  const ref = steps[current].sourceRefs[Number(b.dataset.source)];
  try {
    sourceCodePromise ||= fetch('data/source-code.json').then(r => { if (!r.ok) throw Error('源码片段尚未加载'); return r.json(); });
    const data = await sourceCodePromise;
    const entry = data[`${ref.path}:${ref.line}`] || data.excerpts?.[`${ref.path}:${ref.line}`];
    if (!entry?.available) throw Error('该源码片段尚未导出');
    inspect(ref.symbol, `<p><code>${esc(ref.path)}:${ref.line}</code></p><p>下方是对应构建源码的原文，教学简码另作删节与解释。</p><pre>${entry.lines.map((line, i) => `${String(entry.startLine + i).padStart(4)}  ${typeof line === 'string' ? esc(line) : esc(line.text ?? line.content ?? '')}`).join('\n')}</pre>`);
  } catch (error) { sourceCodePromise = null; inspect(ref.symbol, `<p>${esc(error.message)}。</p><p><code>${esc(ref.path)}:${ref.line}</code></p>`); }
};
$('speakBtn').onclick = () => {
  if (currentSpeech.status === 'playing' || currentSpeech.status === 'loading') { if (playing) pause(); else speech.pause(); }
  else if (currentSpeech.status === 'paused') { if (speechResume) play(); else { speech.resume(); startClock(); } }
  else void speakStep(false);
};
$('narrateToggle').onchange = () => { playbackGeneration++; speechResume = false; speech.stop(); clearPlaybackTimer(); if (playing) startCurrent(); };
$('speedSelect').onchange = e => { speed = Number(e.target.value); speech.setRate(speed); if (playing) { playbackGeneration++; speech.stop(); startCurrent(); } };
$('voiceSettingsBtn').onclick = () => { renderVoices(speech.getVoices()); openDialog('voiceDialog'); };
$('voiceSource').onchange = e => { speech.setSource(e.target.value); speechResume = false; };
$('voiceSelect').onchange = e => speech.setVoice(e.target.value);
$('narratorSelect').onchange = e => {
  if (playing) pause();
  playbackGeneration++; speechResume = false; speech.stop();
  if (e.target.value === 'custom' && customAudioMap) { speech.setAudioMap(customAudioMap.audioMap); narratorWords = customAudioMap.words; narratorCues = customAudioMap.cues; $('audioInfo').textContent = `自定义声线 · ${Object.keys(customAudioMap.audioMap).length} 个步骤`; } else audioReady = loadNarrator(e.target.value);
};
$('audioManifest').onchange = async e => {
  try {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 4 * 1024 * 1024) throw Error('清单超过 4 MiB');
    const parsed = JSON.parse(await file.text()); const map = parsed.audioMap || parsed;
    const ids = new Set(steps.map(s => s.id));
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw Error('清单需要 audioMap 对象');
    const entries = Object.entries(map).filter(([id]) => ids.has(id));
    if (!entries.length) throw Error('没有与本页步骤 ID 对应的音频');
    for (const [, value] of entries) { const url = new URL(typeof value === 'string' ? value : value.src, document.baseURI); if (!['https:', 'http:', 'blob:', 'data:'].includes(url.protocol) || url.protocol === 'data:' && !url.href.startsWith('data:audio/')) throw Error('清单包含无效音频地址'); }
    voiceGeneration++; playbackGeneration++; speechResume = false; speech.stop();
    customAudioMap = { audioMap: Object.fromEntries(entries), words: wordsOf(parsed), cues: cuesOf(parsed) }; speech.setAudioMap(customAudioMap.audioMap); narratorWords = customAudioMap.words; narratorCues = customAudioMap.cues;
    $('narratorSelect').querySelector('[value=custom]').disabled = false; $('narratorSelect').value = 'custom';
    $('audioInfo').textContent = `自定义声线 · ${entries.length} 个步骤`;
    $('voiceMessage').textContent = `已导入 ${entries.length} 个步骤的音频映射。相对地址以本页面目录为准。`;
  } catch (error) { $('voiceMessage').textContent = `导入失败：${error.message}`; }
};
for (const dialog of document.querySelectorAll('dialog')) { dialog.querySelector('[data-close]').onclick = () => dialog.close(); dialog.addEventListener('click', e => { if (e.target === dialog) { const rect = dialog.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close(); } }); }
window.addEventListener('hashchange', () => { const p = hashPosition(); go(p.index, p.beat); });
window.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]') || e.target.closest('input,select,textarea') || e.altKey || e.metaKey || e.ctrlKey) return;
  if (e.key === 'ArrowRight' && e.shiftKey || e.key === 'PageDown') { e.preventDefault(); go(current + 1); }
  else if (e.key === 'ArrowLeft' && e.shiftKey || e.key === 'PageUp') { e.preventDefault(); go(current - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepBeat(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); stepBeat(-1); }
  else if (e.key === ' ' && !e.target.closest('button,a')) { e.preventDefault(); play(); }
  else if (e.key === 'Home') { e.preventDefault(); go(0); }
  else if (e.key === 'End') { e.preventDefault(); go(steps.length - 1); }
  else if (e.key.toLowerCase() === 'f') $('fullscreenBtn').click();
  else if (e.key.toLowerCase() === 'o') $('outlineBtn').click();
});
window.addEventListener('pagehide', () => { clearPlaybackTimer(); speech.destroy(); });
{ const p = hashPosition(); render(p.index, p.beat); }
updatePlayButton(); renderVoices(speech.getVoices());
function wordsOf(manifest) {
  return Object.fromEntries((manifest.entries || []).filter(e => e.id && Array.isArray(e.words)).map(e => [e.id, e.words]));
}
function cuesOf(manifest) {
  return Object.fromEntries((manifest.entries || []).filter(e => e.id && Array.isArray(e.cueStarts) && e.cueStarts.length).map(e => [e.id, e.cueStarts]));
}
async function loadNarrator(key) {
  const serial = ++voiceGeneration;
  speech.setAudioMap({});
  narratorWords = {};
  narratorCues = {};
  $('audioInfo').textContent = '正在加载所选配音…';
  try {
    const response = await fetch(narratorPaths[key] || narratorPaths.xiaoyi);
    if (!response.ok) throw Error('旁白文件不可用');
    const manifest = await response.json();
    if (serial !== voiceGeneration) return;
    speech.setAudioMap(manifest.audioMap || {});
    narratorWords = wordsOf(manifest);
    narratorCues = cuesOf(manifest);
    $('audioInfo').textContent = `${Object.keys(manifest.audioMap || {}).length} 个步骤已配音 · ${manifest.voice || '中文神经网络声线'}${Object.keys(narratorCues).length ? ' · 句间实测同步，句内估算' : Object.keys(narratorWords).length ? ' · 字幕逐字对齐' : ''}。可切换声线或导入自己的音频。`;
  } catch {
    if (serial !== voiceGeneration) return;
    if (key !== 'xiaoyi') {
      $('narratorSelect').value = 'xiaoyi';
      return loadNarrator('xiaoyi');
    }
    $('audioInfo').textContent = '当前使用浏览器中文朗读。也可导入自定义音频清单，或用项目脚本生成逐步旁白。';
  }
}
$('narratorSelect').querySelector('[value=fish]').disabled = !AVAILABLE_NARRATORS.includes('fish');
$('narratorSelect').querySelector('[value=fire]').disabled = !AVAILABLE_NARRATORS.includes('fire');
$('narratorSelect').value = DEFAULT_NARRATOR;
audioReady = loadNarrator(DEFAULT_NARRATOR);
