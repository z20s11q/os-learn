/* Animated player for the stories in KDATA: a machine view (KMV: registers, bits, memory, devices,
   bus transfers) and a sequence-diagram view (?view=seq) driven by the same timeline.
   Everything visible is a pure function of the timeline clock T (ms), so playback, scrubbing
   and frame-by-frame recording (?record=1, window.__anim.render) share one code path. */
(() => {
  const D = window.KDATA, LES = window.KLESSONS || {}, REF = window.KANIM_REF || {}, MV = window.KMV
  const MAIN = 'linux-kernel-architecture.html'
  const Q = new URLSearchParams(location.search), RECORD = Q.has('record')
  let VIEW = Q.get('view') === 'seq' ? 'seq' : 'mach'
  const $ = (s, r = document) => r.querySelector(s)
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2)
  const NODE = new Map(D.nodes.map((n) => [n.id, n]))
  const SHORT = {
    user: '用户进程', boot: '引导/init', sysc: '系统调用', exc: '异常入口', irq: '中断', proc: '进程', sched: '调度器',
    time: '时钟', softirq: '软中断', mm: '地址空间', alloc: '页分配', wq: '工作队列', rcu: 'RCU', vfs: 'VFS', pcache: '页缓存',
    tty: 'TTY', vt: 'VT', ext4: 'ext4', blk: '块层', input: '输入', wbdev: '后台线程', vblk: 'virtio-blk', kbdrv: 'i8042',
    apic: 'APIC', disk: '磁盘', kbd: '键盘', screen: '显存',
  }
  const STATE = { N: '新建', R: '可运行', S: '浅睡', D: '深睡', Z: '僵尸', X: '已回收' }
  const mix = (hex, w) => {
    const n = parseInt(hex.slice(1), 16)
    return `rgb(${[n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * w))})`
  }
  const zoneOf = (id) => D.zones[NODE.get(id).zone]
  const zc = (id) => mix(zoneOf(id)[1], 0.3)
  const cc = (c) => mix(D.contexts[c][2], 0.25)
  const srcText = (ref) => {
    if (!ref) return ''
    const r = REF[ref]
    return r && r[1] ? `${r[0]}:${r[1]}${r[2] > r[1] ? '-' + r[2] : ''}` : ref
  }
  const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

  /* timeline (ms at 1×); a hop lasts long enough for its bus transfers and hardware narration */
  const T_ENTER = 1000, T_HOP = 900, T_TRAVEL = 620, T_OUTRO = 6000, T_XFER0 = 300, T_XFER = 950
  const holdOf = (s) => clamp(s.text.length * 30 + (s.why ? s.why.length * 18 : 0), 4000, 11000)
  const introOf = (st) => clamp(st.intro.length * 38, 6000, 14000)
  const hopOf = (sn) => {
    const mt = sn.xs.length ? T_XFER0 + sn.xs.length * T_XFER : 0
    return { mt, dur: Math.max(T_HOP, Math.max(T_TRAVEL, mt) + (sn.say ? clamp(sn.say.length * 42, 2600, 9000) : 300)) }
  }

  function prepare(st) {
    const used = new Set(st.steps.flatMap((s) => s.calls.map((c) => c.n)))
    const lanes = D.nodes.filter((n) => used.has(n.id)).map((n) => n.id)
    const mm = MV.prepare(st)
    const calls = [], segs = [], stepT = [], holdT = []
    let t = 0, prevN = null
    const push = (o, d) => { segs.push({ ...o, t0: t, t1: t + d }); t += d }
    push({ type: 'intro' }, introOf(st))
    st.steps.forEach((s, i) => {
      stepT.push(t)
      const base = calls.length
      push({ type: 'enter', step: i, base }, T_ENTER)
      s.calls.forEach((c, j) => {
        const h = hopOf(mm.snaps[calls.length])
        calls.push({ ...c, step: i, j, g: calls.length, from: prevN ?? c.n, handoff: j === 0 && prevN != null })
        prevN = c.n
        push({ type: 'hop', step: i, base, j, mt: h.mt }, h.dur)
      })
      holdT.push(t)
      push({ type: 'hold', step: i, base }, holdOf(s))
    })
    const outroT = t
    push({ type: 'outro', step: st.steps.length - 1 }, T_OUTRO)
    return { st, lanes, calls, segs, stepT, holdT, outroT, dur: t, lessons: LES[st.id] || [], mm }
  }
  const MODELS = new Map(D.stories.map((st) => [st.id, prepare(st)]))

  function frameOf(M, T) {
    T = clamp(T, 0, M.dur - 1e-3)
    let lo = 0, hi = M.segs.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (M.segs[mid].t0 <= T) lo = mid; else hi = mid - 1 }
    const seg = M.segs[lo], p = (T - seg.t0) / (seg.t1 - seg.t0)
    const f = { T, seg, p, type: seg.type, step: seg.step ?? -1, g: -1, pt: 1, xp: 1, land: true }
    if (seg.type === 'enter') f.g = seg.base - 1
    else if (seg.type === 'hop') {
      const el = T - seg.t0
      f.g = seg.base + seg.j; f.pt = ease(clamp(el / T_TRAVEL, 0, 1))
      f.xp = seg.mt ? clamp(el / seg.mt, 0, 1) : 1
      f.land = el >= (seg.mt || T_TRAVEL * 0.6)
    }
    else if (seg.type === 'hold') f.g = seg.base + M.st.steps[seg.step].calls.length - 1
    else if (seg.type === 'outro') f.g = M.calls.length - 1
    if (f.step >= 0) {
      const a = M.stepT[f.step], b = M.stepT[f.step + 1] ?? M.outroT
      f.stepP = clamp((T - a) / (b - a), 0, 1)
    }
    return f
  }

  /* ---------- stage geometry ---------- */
  const G = { gutter: 250, row: 34, padTop: 16, padBot: 12, stateH: 32, gap: 6, minBand: 86 }
  let M = null, lastKey = '', camOff = 0, pinned = null

  function layout(width) {
    G.gutter = width < 1600 ? 190 : 250
    const laneW = clamp((width - G.gutter - 16) / M.lanes.length, 46, 150)
    const lx = new Map(M.lanes.map((id, k) => [id, G.gutter + laneW * (k + 0.5)]))
    let y = 10
    M.bands = M.st.steps.map((s) => {
      const top = y
      const h = Math.max(G.minBand, G.padTop + s.calls.length * G.row + G.padBot + (s.state?.length ? G.stateH : 0))
      y += h + G.gap
      return { top, h }
    })
    for (const c of M.calls) { c.y = M.bands[c.step].top + G.padTop + c.j * G.row + G.row / 2; c.x1 = lx.get(c.from); c.x2 = lx.get(c.n) }
    Object.assign(M, { laneW, lx, H: y + 60, W: width })
  }

  function geom(c) {
    const { x1, x2, y } = c
    if (x1 === x2) {
      const r = Math.min(26, M.laneW * 0.42)
      return { d: `M${x1} ${y - 12} C${x1 + r} ${y - 12} ${x1 + r} ${y} ${x1 + 11} ${y}`, head: `${x1 + 5},${y} ${x1 + 12},${y - 4} ${x1 + 12},${y + 4}`, lab: [x1 + r + 6, y, 'start'] }
    }
    const dir = Math.sign(x2 - x1), xe = x2 - dir * 5
    let lab = dir > 0 ? [x2 + 9, y, 'start'] : [x2 - 9, y, 'end']
    const w = c.f.length * 7.6
    if (lab[2] === 'start' && lab[0] + w > M.W - 6) lab = [x2 - 9, y - 13, 'end']
    else if (lab[2] === 'end' && lab[0] - w < G.gutter) lab = [x2 + 9, y - 13, 'start']
    return { d: `M${x1} ${y} L${xe - dir * 6} ${y}`, head: `${xe},${y} ${xe - dir * 8},${y - 4.5} ${xe - dir * 8},${y + 4.5}`, lab }
  }

  function buildStage() {
    const view = $('#view')
    layout(view.clientWidth)
    $('#lanes').classList.toggle('narrow', M.laneW < 62)
    $('#lanes').innerHTML = `<div class="gut"><b>步骤</b><span>${M.st.steps.length} 步 · ${M.calls.length} 跳</span></div>` +
      M.lanes.map((id) => `<div class="lane" data-lane="${id}" style="left:${M.lx.get(id) - M.laneW / 2}px;width:${M.laneW - 4}px;--zc:${zc(id)}" title="${esc(NODE.get(id).name)}：${esc(NODE.get(id).code)}"><b>${esc(SHORT[id] || NODE.get(id).name)}</b>${M.laneW >= 66 ? `<small>${esc(zoneOf(id)[0])}</small>` : ''}</div>`).join('')
    const W = M.W, out = []
    out.push(`<svg width="${W}" height="${M.H}" viewBox="0 0 ${W} ${M.H}"><defs><filter id="glow" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`)
    M.st.steps.forEach((s, i) => {
      const b = M.bands[i]
      out.push(`<rect class="band" data-step="${i}" x="0" y="${b.top}" width="${W}" height="${b.h}" style="--c:${cc(s.ctx)}"/><rect class="ctxbar" x="0" y="${b.top}" width="4" height="${b.h}" fill="${cc(s.ctx)}"/><line class="bandline" x1="${G.gutter - 8}" x2="${W}" y1="${b.top + b.h + G.gap / 2}" y2="${b.top + b.h + G.gap / 2}"/>`)
    })
    for (const id of M.lanes) out.push(`<line class="life" x1="${M.lx.get(id)}" x2="${M.lx.get(id)}" y1="0" y2="${M.H}" stroke="${zc(id)}"/>`)
    for (const c of M.calls) {
      const g = geom(c), col = c.handoff ? cc(M.st.steps[c.step].ctx) : zc(c.n)
      c.d = g.d
      out.push(`<g class="call ghost${c.handoff ? ' handoff' : ''}" data-g="${c.g}"><rect class="bar" x="${c.x2 - 5}" y="${c.y - G.row / 2 + 3}" width="10" height="${G.row - 6}" rx="2" fill="${zc(c.n)}"/>` +
        `<path class="arrow" d="${g.d}" stroke="${col}"/><polygon class="head" points="${g.head}" fill="${col}"/>` +
        `<circle class="dot" cx="${c.x2}" cy="${c.y}" r="4.5" fill="${zc(c.n)}"/>` +
        `<text x="${g.lab[0]}" y="${g.lab[1]}" text-anchor="${g.lab[2]}" dominant-baseline="central">${esc(c.f)}</text></g>`)
    }
    out.push(`<path id="prog" d="M0 0"/><g id="packet" filter="url(#glow)"><circle class="p0" r="11"/><circle class="p1" r="5.5"/></g></svg>`)
    M.st.steps.forEach((s, i) => {
      const b = M.bands[i], c = cc(s.ctx)
      out.push(`<div class="gl" data-step="${i}" style="top:${b.top + 10}px;width:${G.gutter - 26}px;--c:${c}"><span class="num">${i + 1}</span><span class="tt">${esc(s.t)}<span class="cx">${esc(D.contexts[s.ctx][0])} · ${esc(D.kinds[s.kind] || s.kind)}${s.side ? ' · 旁路' : ''}</span></span></div>`)
      if (s.state?.length) out.push(`<div class="sts" data-step="${i}" style="left:${G.gutter + 8}px;top:${b.top + b.h - G.stateH + 4}px">${s.state.map(stateChip).join('')}</div>`)
    })
    $('#body').innerHTML = out.join('')
    $('#body').style.height = M.H + 'px'
    for (const c of M.calls) {
      c.el = $(`#body .call[data-g="${c.g}"]`)
      c.len = c.el.querySelector('.arrow').getTotalLength()
      c._cls = 'ghost'
    }
    M.gl = [...document.querySelectorAll('#body .gl')]
    M.sts = new Map([...document.querySelectorAll('#body .sts')].map((e) => [+e.dataset.step, e]))
    M.bandEls = [...document.querySelectorAll('#body .band')]
    M.laneEls = new Map([...document.querySelectorAll('#lanes .lane')].map((e) => [e.dataset.lane, e]))
    buildTimeline()
    buildMap()
    lastKey = ''
  }

  const stateChip = ([who, a, b, note]) => `<span class="st"><b>${esc(who)}</b> <span class="${a}" title="${STATE[a]}">${a}</span>→<span class="${b}" title="${STATE[b]}">${b}</span> <span class="muted">${STATE[b]}${note ? ' · ' + esc(note) : ''}</span></span>`

  /* ---------- timeline strip ---------- */
  function buildTimeline() {
    const segs = [`<div style="flex:${M.stepT[0]};--c:#6b7280" title="导言">导言</div>`]
    M.st.steps.forEach((s, i) => {
      const d = (M.stepT[i + 1] ?? M.outroT) - M.stepT[i]
      segs.push(`<div data-step="${i}" style="flex:${d};--c:${cc(s.ctx)}" title="${i + 1}. ${esc(s.t)}（${esc(D.contexts[s.ctx][0])}）">${i + 1}</div>`)
    })
    segs.push(`<div style="flex:${T_OUTRO};--c:#6b7280" title="回顾">回顾</div>`)
    $('#tl-segs').innerHTML = segs.join('')
    M.tlEls = [...document.querySelectorAll('#tl-segs [data-step]')]
  }

  /* ---------- component map (12-column grid from data.js node.at) ---------- */
  const MAP = { cw: 62, rh: 32 }
  const mcenter = (id) => { const [r, c, s] = NODE.get(id).at; return [(c - 1 + s / 2) * MAP.cw, (r - 0.5) * MAP.rh] }
  function buildMap() {
    const W = 12 * MAP.cw, H = 8 * MAP.rh
    const out = [`<svg viewBox="-4 -4 ${W + 8} ${H + 8}" preserveAspectRatio="xMidYMid meet"><defs><marker id="mah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>`]
    for (const n of D.nodes) {
      const [r, c, s] = n.at
      out.push(`<g class="mn" data-id="${n.id}" style="--zc:${zc(n.id)}"><rect x="${(c - 1) * MAP.cw + 3}" y="${(r - 1) * MAP.rh + 3}" width="${s * MAP.cw - 6}" height="${MAP.rh - 6}" rx="6"/><text x="${(c - 1 + s / 2) * MAP.cw}" y="${(r - 0.5) * MAP.rh}">${esc(SHORT[n.id] || n.name)}</text></g>`)
    }
    out.push(`<g id="mhops" style="color:var(--ink2)"></g><path id="mprog" d="M0 0"/><g id="mpk" filter="url(#glow)"><circle r="10" opacity=".3" fill="var(--acc)"/><circle r="5" fill="var(--acc)"/></g></svg>`)
    $('#map').innerHTML = out.join('')
    M.mnodes = new Map([...document.querySelectorAll('#map .mn')].map((e) => [e.dataset.id, e]))
    M.mapStep = -2
  }
  function mapPath(a, b) {
    const [x1, y1] = mcenter(a), [x2, y2] = mcenter(b)
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1, k = 0.18
    return `M${x1} ${y1} Q${mx - dy * k} ${my + dx * k} ${x2} ${y2}`
  }
  function mapStep(i) {
    if (M.mapStep === i) return
    M.mapStep = i
    const calls = i >= 0 ? M.calls.filter((c) => c.step === i) : []
    const nodes = new Set(calls.map((c) => c.n))
    for (const [id, e] of M.mnodes) e.classList.toggle('step', nodes.has(id))
    M.mhops = calls.filter((c) => c.from !== c.n).map((c) => ({ g: c.g, d: mapPath(c.from, c.n), hand: c.handoff }))
    $('#mhops').innerHTML = M.mhops.map((h) => `<path class="mh${h.hand ? ' hand' : ''}" data-g="${h.g}" d="${h.d}" marker-end="url(#mah)"/>`).join('')
    M.mhopEls = new Map([...document.querySelectorAll('#mhops path')].map((e) => [+e.dataset.g, e]))
  }

  /* ---------- cards ---------- */
  let cardStep = -2, cardCall = '', capKey = '', sideKey = ''
  function stepCard(f) {
    const i = f.step
    if (cardStep === i) return
    cardStep = i
    const el = $('#card-step')
    if (i < 0) {
      el.innerHTML = `<div class="kick"><span class="tag">导言</span></div><h2>${esc(M.st.title)}</h2><p class="tx">${md(M.st.intro)}</p>`
      return
    }
    const s = M.st.steps[i], cx = D.contexts[s.ctx], c = cc(s.ctx)
    el.innerHTML = `<div class="kick">第 ${i + 1} / ${M.st.steps.length} 步 <span class="tag" style="--c:${c}">${esc(cx[0])}</span><span class="tag">${esc(D.kinds[s.kind] || s.kind)}</span>${s.side ? '<span class="tag" style="--c:#e3c26b">旁路</span>' : ''}</div>
      <h2>${esc(s.t)}</h2><p class="cxd" style="--c:${c}">执行上下文：${esc(cx[1])}</p>
      <p class="tx">${md(s.text)}</p>
      ${s.why ? `<div class="why"><b>为什么这样设计</b>${md(s.why)}</div>` : ''}
      ${s.state?.length ? `<div class="stl">${s.state.map(stateChip).join('')}</div>` : ''}
      <a class="lnk" href="${MAIN}#pano/${M.st.id}/${i + 1}" target="_blank" rel="noopener">在全景图里看本步源码、伪代码与数据 ↗</a>`
    el.scrollTop = 0
  }
  function callCard(f) {
    let g = f.g, pending = false
    if (f.type === 'enter') { g = f.seg.base; pending = true }
    if (f.type === 'intro') { g = 0; pending = true }
    const comp = pinned || M.calls[g]?.n
    const mach = VIEW === 'mach', sn = !pending && mach ? M.mm.snaps[g] : null
    const nx = sn ? sn.xs.length : 0
    const k = !nx ? -1 : f.land ? nx : Math.min(nx - 1, Math.floor(f.xp * nx))
    const key = `${g}|${pending}|${pinned}|${VIEW}|${k}`
    if (cardCall === key) return
    cardCall = key
    const c = M.calls[g], n = NODE.get(comp), z = zoneOf(comp), col = zc(comp)
    const les = c && M.lessons[c.step]
    const prin = les?.principle ? `<div class="prin"><b>本步机制</b>${md(les.principle)}</div>` : ''
    const head = c && !pinned ? `<div class="kick">${pending ? '即将调用' : '当前调用'} · 第 ${c.j + 1} / ${M.st.steps[c.step].calls.length} 跳 · ${esc(NODE.get(c.n).name)}</div>
      <div class="fnbox${pending ? ' pending' : ''}" style="--c:${zc(c.n)}"><div class="fn">${esc(c.f)}</div>${c.note ? `<div class="nt">${md(c.note)}</div>` : ''}${c.src ? `<div class="src">${esc(srcText(c.src))}</div>` : '<div class="src">按硬件事件或用户态动作展示</div>'}</div>` : `<div class="kick">组件说明（点击泳道头固定，再点一次取消）</div>`
    const compHtml = `<div class="comp" style="--c:${col}"><h3><i></i>${esc(n.name)}<small>${esc(z[0])}</small></h3><div class="cd">${esc(n.code)}</div><p>${md(n.text)}</p>
      ${n.objs?.length ? `<ul>${n.objs.map((o) => `<li><code>${esc(o[0])}</code> ${esc(o[1])}</li>`).join('')}</ul>` : ''}</div>`
    if (sn && !pinned) {
      const xl = nx ? `<ol class="xl">${sn.xs.map((x, i) => `<li class="${i < k ? 'done' : i === k ? 'cur' : ''}"><b>${esc(MV.portName(x[0]))} → ${esc(MV.portName(x[1]))}</b>${esc(x[2])}</li>`).join('')}</ol>` : ''
      $('#card-call').innerHTML = `${head}${xl}${sn.say ? `<div class="say"><b>硬件层面</b>${md(sn.say)}</div>` : compHtml}${prin}`
    } else $('#card-call').innerHTML = `${c && !pinned ? prin : ''}${head}${compHtml}`
  }
  function caption(f) {
    let key, html, col
    if (f.type === 'intro') { key = 'i'; col = 'var(--acc)'; html = `<span class="k">导言</span><b>${esc(M.st.title)}</b>` }
    else if (f.type === 'outro') { key = 'o'; col = 'var(--acc)'; html = `<span class="k">完成</span><b>${esc(M.st.short)}</b><span class="nt">共 ${M.st.steps.length} 步、${M.calls.length} 跳</span>` }
    else if (f.type === 'enter') {
      const s = M.st.steps[f.step]; key = 'e' + f.step; col = cc(s.ctx)
      html = `<span class="k">第 ${f.step + 1} 步</span><b style="font-family:var(--sans)">${esc(s.t)}</b><span class="z">${esc(D.contexts[s.ctx][0])}</span>`
    } else {
      const c = M.calls[f.g]; key = 'c' + f.g; col = zc(c.n)
      html = `<span class="k">${f.step + 1}.${c.j + 1}</span><b>${esc(c.f)}</b><span class="z">${esc(NODE.get(c.n).name)}</span>${c.note ? `<span class="nt">— ${md(c.note)}</span>` : ''}`
    }
    const el = $('#caption')
    if (capKey !== key) { capKey = key; el.innerHTML = html; el.style.setProperty('--c', col) }
    const t0 = f.type === 'hold' ? f.seg.t0 - 1000 : f.seg.t0
    el.style.opacity = clamp((f.T - t0) / 220, 0.35, 1)
  }

  /* ---------- overlays ---------- */
  function overlays(f) {
    const intro = $('#intro'), outro = $('#outro')
    let oi = 0, oo = 0
    if (f.type === 'intro') oi = clamp(((1 - f.p) * (f.seg.t1 - f.seg.t0)) / 500, 0, 1)
    if (f.type === 'outro') oo = clamp((f.p * T_OUTRO) / 500, 0, 1)
    intro.style.opacity = oi; intro.classList.toggle('live', oi > 0.5)
    outro.style.opacity = oo; outro.classList.toggle('live', oo > 0.5)
  }
  function buildOverlays() {
    const st = M.st, comps = M.lanes.length
    $('#intro').innerHTML = `<div class="ov"><div class="eb">流程 ${D.stories.indexOf(st) + 1} / ${D.stories.length} · ${esc(D.meta.kernel)}</div><h1>${esc(st.title)}</h1><p>${md(st.intro)}</p>
      <div class="meta"><span>${st.steps.length} 步</span><span>${M.calls.length} 次组件跳转</span><span>${M.mm.snaps.reduce((n, s) => n + s.xs.length, 0)} 次总线传输</span><span>${comps} 个组件出场</span><span>约 ${fmt(M.dur)}（1×）</span><span>${esc(D.meta.caseLine)}</span></div>
      ${VIEW === 'mach' ? `<p class="cav">${esc(MV.caveat)}</p>` : ''}
      <div class="btns"><button type="button" data-act="start">▶ 开始播放</button><button type="button" class="alt" data-act="step1">逐步看（停在第 1 步）</button></div></div>`
    const next = D.stories[(D.stories.indexOf(st) + 1) % D.stories.length]
    $('#outro').innerHTML = `<div class="ov"><div class="eb">回顾</div><h1>${esc(st.short)}：走完了</h1>
      <ol>${st.steps.map((s, i) => `<li data-go="${i}">${esc(s.t)}</li>`).join('')}</ol>
      <div class="btns"><button type="button" data-act="next">下一条流程：${esc(next.short)} ▶</button><button type="button" class="alt" data-act="replay">从头重播</button></div></div>`
  }

  /* ---------- per-frame render ---------- */
  function classify(f) {
    for (const c of M.calls) {
      const cls = c.g > f.g ? 'ghost' : c.g === f.g && f.pt < 1 ? 'cur' : c.step === f.step ? 'done' : 'past'
      if (c._cls !== cls) { c.el.setAttribute('class', `call ${cls}${c.handoff ? ' handoff' : ''}`); c._cls = cls }
    }
    M.bandEls.forEach((e, i) => e.classList.toggle('on', i === f.step))
    M.gl.forEach((e, i) => { e.classList.toggle('on', i === f.step); e.classList.toggle('done', i < f.step) })
    for (const [i, e] of M.sts) e.classList.toggle('show', i < f.step || (i === f.step && (f.type === 'hold' || f.type === 'outro')))
    M.tlEls.forEach((e, i) => e.classList.toggle('on', i === f.step))
    const inStep = new Set(f.step >= 0 ? M.st.steps[f.step].calls.map((c) => c.n) : [])
    for (const [id, e] of M.laneEls) e.classList.toggle('step', inStep.has(id))
    if (M.mhopEls) for (const [g, e] of M.mhopEls) e.classList.toggle('done', g < f.g || (g === f.g && f.pt >= 1))
  }

  function camera(f) {
    const vh = $('#view').clientHeight
    const focus = (i) => { const b = M.bands[i]; return b.h < vh * 0.82 ? b.top + b.h / 2 : null }
    let y
    if (f.type === 'intro') y = vh / 2
    else if (f.type === 'enter') {
      const prev = f.step > 0 ? (focus(f.step - 1) ?? M.calls[f.g].y) : vh / 2
      const to = focus(f.step) ?? M.bands[f.step].top + vh * 0.4
      y = prev + (to - prev) * ease(f.p)
    } else {
      const fc = focus(f.step)
      if (fc != null) y = fc
      else {
        const c = M.calls[f.g], prevY = c.j ? M.calls[f.g - 1].y : M.bands[f.step].top + vh * 0.4
        y = f.type === 'hop' ? prevY + (c.y - prevY) * f.pt : c.y
        y = Math.max(y, M.bands[f.step].top + vh * 0.4)
      }
    }
    const top = clamp(y - vh * 0.46 + camOff, 0, Math.max(0, M.H - vh))
    $('#body').style.transform = `translate3d(0,${-top}px,0)`
  }

  function render(T) {
    const f = frameOf(M, T)
    P.f = f
    const key = `${f.g}|${f.step}|${f.pt >= 1}|${f.type}`
    if (key !== lastKey) { lastKey = key; mapStep(f.step); classify(f) }
    const c = M.calls[f.g], pk = $('#packet'), prog = $('#prog')
    let active = null
    if (f.type === 'hop' && f.pt < 1) {
      const el = c.el.querySelector('.arrow')
      prog.setAttribute('d', c.d); prog.setAttribute('stroke', el.getAttribute('stroke'))
      prog.style.strokeDasharray = c.len; prog.style.strokeDashoffset = c.len * (1 - f.pt); prog.style.opacity = 1
      const pt = el.getPointAtLength(c.len * f.pt)
      pk.setAttribute('transform', `translate(${pt.x},${pt.y})`); pk.style.opacity = 1; pk.style.fill = zc(c.n)
      c.el.querySelector('text').style.opacity = clamp((f.pt - 0.55) / 0.45, 0, 1)
      active = f.pt > 0.5 ? c.n : c.from
    } else {
      prog.style.opacity = 0
      if (c) {
        c.el.querySelector('text').style.opacity = ''
        const pulse = f.type === 'hold' ? 0.75 + 0.25 * Math.sin(f.T / 260) : 1
        pk.setAttribute('transform', `translate(${c.x2},${c.y})`); pk.style.opacity = f.type === 'outro' ? 0 : pulse; pk.style.fill = zc(c.n)
        active = f.type === 'enter' ? null : c.n
      } else pk.style.opacity = 0
    }
    for (const [id, e] of M.laneEls) e.classList.toggle('on', id === active)
    for (const [id, e] of M.mnodes) e.classList.toggle('on', id === active)
    mapRender(f, c)
    camera(f)
    stepCard(f); callCard(f); caption(f); overlays(f); ctxPill(f)
    if (VIEW === 'mach') {
      MV.render(MEL, M.mm, f.g, f.land, f.xp, T)
      const mk = `${M.st.id}|${f.g}|${f.land}`
      if (sideKey !== mk) { sideKey = mk; $('#mstate').innerHTML = MV.sideCard(M.mm, f.g, f.land) }
    }
    const a = f.step >= 0 ? M.stepT[f.step] : 0
    $('#card-step').style.opacity = f.step >= 0 ? clamp((f.T - a) / 300, 0.2, 1) : 1
    if (P.playing || RECORD) autoScroll(f)
    $('#tl-prog').style.width = (T / M.dur) * 100 + '%'
    $('#tl-head').style.left = `calc(${(T / M.dur) * 100}% - 1px)`
    $('#clock').textContent = `${fmt(T)} / ${fmt(M.dur)}`
    $('#pos').textContent = f.type === 'intro' ? '导言' : f.type === 'outro' ? '回顾' : f.type === 'enter' ? `第 ${f.step + 1} 步` : `${f.step + 1}.${M.calls[f.g].j + 1} / ${M.st.steps[f.step].calls.length}`
  }

  function mapRender(f, c) {
    const prog = $('#mprog'), pk = $('#mpk')
    const h = f.type === 'hop' && f.pt < 1 && M.mhopEls?.get(f.g)
    if (h) {
      const len = h.getTotalLength()
      prog.setAttribute('d', h.getAttribute('d')); prog.style.strokeDasharray = len; prog.style.strokeDashoffset = len * (1 - f.pt); prog.style.opacity = 1
      const p = h.getPointAtLength(len * f.pt); pk.setAttribute('transform', `translate(${p.x},${p.y})`); pk.style.opacity = 1
    } else {
      prog.style.opacity = 0
      if (c && f.type !== 'outro' && f.type !== 'enter') { const [x, y] = mcenter(c.n); pk.setAttribute('transform', `translate(${x},${y})`); pk.style.opacity = 0.9 }
      else pk.style.opacity = 0
    }
  }

  function ctxPill(f) {
    const ctx = f.step >= 0 ? M.st.steps[f.step].ctx : null
    const key = ctx || '-'
    const el = $('#ctxpill')
    if (el.dataset.k === key) return
    el.dataset.k = key
    el.style.setProperty('--c', ctx ? cc(ctx) : 'var(--muted)')
    el.innerHTML = ctx ? `<i></i><span>CPU 执行上下文</span><b>${esc(D.contexts[ctx][0])}</b>` : '<i></i><span>CPU 执行上下文</span><b>—</b>'
    el.title = ctx ? D.contexts[ctx][1] : ''
  }

  function autoScroll(f) {
    const el = $('#card-step'), max = el.scrollHeight - el.clientHeight
    if (max <= 2 || f.step < 0) return
    el.scrollTop = max * ease(clamp((f.stepP - 0.25) / 0.6, 0, 1))
  }

  /* ---------- playback ---------- */
  const P = { playing: false, speed: 1, T: 0, last: 0, f: null, stopAt: null }
  function setPlaying(on) {
    P.playing = on
    if (!on) P.stopAt = null
    $('#b-play').textContent = on ? '❚❚' : '▶'
    if (on) { camOff = 0; P.last = performance.now(); requestAnimationFrame(tick) }
  }
  function tick(now) {
    if (!P.playing) return
    let T = P.T + (now - P.last) * P.speed
    P.last = now
    const f0 = frameOf(M, P.T)
    if (P.stopAt != null && T >= P.stopAt) { P.T = P.stopAt; P.stopAt = null; render(P.T); setPlaying(false); return }
    if ($('#b-steppause').checked && f0.type === 'hold' && T >= f0.seg.t1 - 1) { T = f0.seg.t1 - 1; P.T = T; render(T); setPlaying(false); return }
    if (T >= M.dur - 1) { P.T = M.dur - 1; render(P.T); setPlaying(false); return }
    P.T = T
    render(T)
    requestAnimationFrame(tick)
  }
  function seek(T, play) {
    P.T = clamp(T, 0, M.dur - 1); camOff = 0; P.stopAt = null
    render(P.T)
    if (play != null) setPlaying(play)
    syncHash()
  }
  const curStep = () => { const f = frameOf(M, P.T); return f.type === 'intro' ? -1 : f.type === 'outro' ? M.st.steps.length : f.step }
  const gotoStep = (i) => gotoCall(firstCall(clamp(i, 0, M.st.steps.length - 1)))
  /* stepping never plays: it jumps to the landed state at the end of a hop */
  function gotoCall(g) {
    setPlaying(false)
    if (g >= M.calls.length) return seek(M.outroT + 600, false)
    if (g < 0) return seek(0, false)
    const c = M.calls[g]
    seek(M.segs.find((s) => s.type === 'hop' && s.step === c.step && s.j === c.j).t1 - 1, false)
  }
  const firstCall = (i) => M.calls.findIndex((c) => c.step === i)
  const hopSegOf = (g) => (g < 0 || g >= M.calls.length ? null : M.segs.find((s) => s.type === 'hop' && s.step === M.calls[g].step && s.j === M.calls[g].j))
  /* 小步递进：跳到下（上）一跳的起点播放，播完这一段自动停下；播放中途按「小步 ›」直接进入下一跳 */
  function stepCall(d) {
    const f = frameOf(M, P.T)
    let g = f.g + d
    if (f.type === 'hop' && !f.land) g = d > 0 ? f.g + 1 : f.g - 1
    if (f.type === 'outro' && d < 0) g = M.calls.length - 1
    const hop = hopSegOf(g)
    if (!hop) return gotoCall(g)
    seek(hop.t0, false)
    P.stopAt = hop.t1 - 1
    setPlaying(true)
  }
  function stepBig(d) {
    const f = frameOf(M, P.T)
    if (d > 0) {
      const i = f.type === 'intro' ? 0 : f.type === 'outro' ? M.st.steps.length : f.step + 1
      return i >= M.st.steps.length ? gotoCall(M.calls.length) : gotoCall(firstCall(i))
    }
    if (f.type === 'intro') return gotoCall(-1)
    if (f.type === 'outro') return gotoCall(firstCall(M.st.steps.length - 1))
    const atStart = f.type === 'enter' || (f.g === firstCall(f.step) && f.land)
    gotoCall(atStart ? (f.step > 0 ? firstCall(f.step - 1) : -1) : firstCall(f.step))
  }
  function syncHash(i = curStep()) {
    if (RECORD) return
    const h = `#${M.st.id}${i >= 0 && i < M.st.steps.length ? '/' + (i + 1) : ''}`
    if (location.hash !== h) history.replaceState(null, '', h)
  }

  function setStory(id, opts = {}) {
    M = MODELS.get(id)
    cardStep = -2; cardCall = ''; capKey = ''; sideKey = ''; MEL._key = ''; pinned = null; $('#ctxpill').dataset.k = ''
    document.querySelectorAll('#stories button').forEach((b) => b.classList.toggle('on', b.dataset.id === id))
    buildStage(); buildOverlays()
    if (opts.step != null) gotoStep(opts.step)
    else seek(0, false)
    if (opts.play) seek(M.stepT[0], true)
  }

  function setView(v) {
    VIEW = v
    document.body.classList.toggle('mach', v === 'mach')
    $('#b-view').textContent = v === 'mach' ? '时序图视图' : '机器视图'
    cardCall = ''; sideKey = ''; MEL._key = ''
    requestAnimationFrame(() => { buildStage(); buildOverlays(); lastKey = ''; render(P.T) })
  }

  /* ---------- wiring ---------- */
  const MEL = MV.build($('#mach'))
  document.body.classList.toggle('mach', VIEW === 'mach')
  $('#b-view').textContent = VIEW === 'mach' ? '时序图视图' : '机器视图'
  $('#b-view').onclick = () => setView(VIEW === 'mach' ? 'seq' : 'mach')
  $('#stories').innerHTML = D.stories.map((s, k) => `<button type="button" data-id="${s.id}" title="${esc(s.title)}（${k + 1}）">${esc(s.short)}<small>${s.steps.length} 步 · ${fmt(MODELS.get(s.id).dur)}</small></button>`).join('')
  $('#stories').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { setPlaying(false); setStory(b.dataset.id) } })
  $('#b-play').onclick = () => {
    const f = frameOf(M, P.T)
    if (P.playing) return setPlaying(false)
    if (f.type === 'intro') return seek(M.stepT[0], true)
    if (f.type === 'outro' || P.T >= M.dur - 2) return seek(M.stepT[0], true)
    setPlaying(true)
  }
  $('#b-next').onclick = () => stepBig(1)
  $('#b-prev').onclick = () => stepBig(-1)
  $('#b-cnext').onclick = () => stepCall(1)
  $('#b-cprev').onclick = () => stepCall(-1)
  $('#b-speed').onchange = (e) => { P.speed = +e.target.value }
  $('#b-theme').onclick = () => { const r = document.documentElement; r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark' }
  $('#b-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())
  const tl = $('#tl')
  const tlSeek = (e) => { const r = tl.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * M.dur) }
  tl.addEventListener('pointerdown', (e) => { const was = P.playing; setPlaying(false); tlSeek(e); tl.setPointerCapture(e.pointerId); tl.onpointermove = tlSeek; tl.onpointerup = () => { tl.onpointermove = null; if (was) setPlaying(true) } })
  $('#body').addEventListener('click', (e) => {
    const g = e.target.closest('.gl'); if (g) return gotoStep(+g.dataset.step)
    const c = e.target.closest('.call'); if (c) { const k = M.calls[+c.dataset.g]; const j = M.segs.findIndex((s) => s.type === 'hop' && s.step === k.step && s.j === k.j); setPlaying(false); seek(M.segs[j].t1 - 1) }
  })
  $('#lanes').addEventListener('click', (e) => { const l = e.target.closest('.lane'); if (!l) return; pinned = pinned === l.dataset.lane ? null : l.dataset.lane; cardCall = ''; render(P.T) })
  $('#view').addEventListener('wheel', (e) => { if (P.playing) return; e.preventDefault(); camOff += e.deltaY; render(P.T) }, { passive: false })
  for (const id of ['intro', 'outro']) $('#' + id).addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act, go = e.target.closest('[data-go]')?.dataset.go
    if (go != null) return gotoStep(+go)
    if (a === 'start' || a === 'replay') seek(M.stepT[0], true)
    else if (a === 'step1') gotoStep(0)
    else if (a === 'next') setStory(D.stories[(D.stories.indexOf(M.st) + 1) % D.stories.length].id, { play: false })
  })
  addEventListener('keydown', (e) => {
    if (e.target.closest('input,select,textarea')) return
    if (e.key === ' ') { e.preventDefault(); $('#b-play').click() }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? stepCall(1) : $('#b-next').click() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? stepCall(-1) : $('#b-prev').click() }
    else if (e.key === '.') stepCall(1)
    else if (e.key === ',') stepCall(-1)
    else if (/^[1-9]$/.test(e.key) && D.stories[+e.key - 1]) { setPlaying(false); setStory(D.stories[+e.key - 1].id) }
    else if (e.key === 'f' || e.key === 'F') $('#b-full').click()
    else if (e.key === 'v' || e.key === 'V') $('#b-view').click()
    else if (e.key === '+' || e.key === '=') { const s = $('#b-speed'); s.selectedIndex = Math.min(s.options.length - 1, s.selectedIndex + 1); s.onchange({ target: s }) }
    else if (e.key === '-') { const s = $('#b-speed'); s.selectedIndex = Math.max(0, s.selectedIndex - 1); s.onchange({ target: s }) }
  })
  let rt = 0
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { buildStage(); lastKey = ''; render(P.T) }, 120) })

  if (RECORD) document.body.classList.add('record')
  if (Q.get('theme')) document.documentElement.dataset.theme = Q.get('theme')
  const h = /^#(\w+)(?:\/(\d+))?$/.exec(location.hash)
  const sid = Q.get('story') || (h && MODELS.has(h[1]) ? h[1] : D.stories[1]?.id || D.stories[0].id)
  setStory(MODELS.has(sid) ? sid : D.stories[0].id, { step: !RECORD && h?.[2] ? Number(h[2]) - 1 : null })
  const hopSeg = (step, j) => { const s = M.segs.find((x) => x.type === 'hop' && x.step === step && x.j === j); return s && [s.t0, s.t1, s.mt] }
  window.__anim = { get dur() { return M.dur }, render: (T) => { P.T = T; render(T) }, setStory: (id) => setStory(id), hop: hopSeg, stories: D.stories.map((s) => s.id) }
})()
