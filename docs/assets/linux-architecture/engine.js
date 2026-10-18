/* Page engine: overview, step-by-step panorama (sequence + component wires + inspector),
   cross-cut matrices, task state machine, code index. Data: window.KDATA, window.KSRC. */
(() => {
  'use strict'
  const D = window.KDATA, S = window.KSRC, HASH0 = location.hash
  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => [...r.querySelectorAll(s)]
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const NODE = new Map(D.nodes.map((n) => [n.id, n]))
  const ZONE = D.zones, CTX = D.contexts
  const zc = (id) => ZONE[NODE.get(id)?.zone]?.[1] ?? '#888'
  const STORY = new Map(D.stories.map((s) => [s.id, s]))

  /* ---------- source links ---------- */
  function srcInfo(ref) {
    const r = S.table[ref]
    if (!r) return null
    const [file, a, b] = r
    return { file, a, b, href: `${S.repo}${file}?h=${S.tag}${a ? `#n${a}` : ''}`, text: `${file.split('/').pop()}${a ? `:${a}${b > a ? `-${b}` : ''}` : ''}`, full: `${file}${a ? `:${a}${b > a ? `-${b}` : ''}` : ''}` }
  }
  function srcLink(ref, label) {
    const i = srcInfo(ref)
    if (!i) return ''
    return `<a class="src" href="${i.href}" target="_blank" rel="noopener" title="${esc(i.full)} @ ${S.tag}">${esc(label ?? i.text)}</a>`
  }
  const fmt = (s) => esc(s)
    .replace(/\{\{src:([^}|]+)(?:\|([^}]*))?\}\}/g, (_, r, l) => srcLink(r, l))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
  function fillTemplateSrc() {
    for (const el of $$('[data-fmt]')) el.innerHTML = fmt(el.textContent)
    for (const a of $$('a.src[data-src]')) {
      const i = srcInfo(a.dataset.src)
      if (!i) continue
      a.href = i.href; a.target = '_blank'; a.rel = 'noopener'; a.title = `${i.full} @ ${S.tag}`
      if (!a.textContent.trim()) a.textContent = i.text
    }
  }

  /* ---------- JSON with field docs ---------- */
  function fieldDoc(k) {
    const key = k.replace(/\[.*?\]/g, '').split('.').pop()
    return D.fields[key] ?? D.fields[k] ?? ''
  }
  function jsonHtml(v, ind = 0) {
    const pad = '  '.repeat(ind)
    if (v === null) return '<span class="z">null</span>'
    if (typeof v === 'boolean') return `<span class="b">${v}</span>`
    if (typeof v === 'number') return `<span class="n">${v}</span>`
    if (typeof v === 'string') return `<span class="s">"${esc(v)}"</span>`
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x !== 'object' || x === null) && JSON.stringify(v).length < 70) return `[${v.map((x) => jsonHtml(x)).join(', ')}]`
      return `[\n${v.map((x) => `${pad}  ${jsonHtml(x, ind + 1)}`).join(',\n')}\n${pad}]`
    }
    const ents = Object.entries(v)
    return `{\n${ents.map(([k, x]) => {
      const doc = fieldDoc(k)
      return `${pad}  <span class="k${doc ? ' doc' : ''}"${doc ? ` title="${esc(doc)}"` : ''}>"${esc(k)}"</span>: ${jsonHtml(x, ind + 1)}`
    }).join(',\n')}\n${pad}}`
  }

  /* ---------- theme & toc ---------- */
  function initChrome() {
    const btn = $('#theme')
    const set = (t) => { document.documentElement.dataset.theme = t; try { localStorage.setItem('ka-theme', t) } catch {} }
    let saved = null
    try { saved = localStorage.getItem('ka-theme') } catch {}
    set(saved ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
    btn?.addEventListener('click', () => { set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))) })
    const links = $$('.toc a[href^="#"]')
    const io = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) for (const a of links) a.classList.toggle('on', a.getAttribute('href') === `#${e.target.id}`)
    }, { rootMargin: '-45% 0px -50% 0px' })
    for (const a of links) { const t = document.getElementById(a.getAttribute('href').slice(1)); if (t) io.observe(t) }
  }

  /* ---------- where a component appears ---------- */
  const appear = (nid) => D.stories.map((st) => ({ st, idx: st.steps.map((s, i) => s.calls.some((c) => c.n === nid) ? i : -1).filter((i) => i >= 0) })).filter((x) => x.idx.length)
  function appearHtml(nid) {
    const list = appear(nid)
    if (!list.length) return '<p class="muted">此组件位于三条流程的展示范围之外。</p>'
    return list.map(({ st, idx }) => `<div class="ap-row"><span class="ap-st">${esc(st.short)}</span>${idx.map((i) => `<button type="button" class="stepchip" data-go="${st.id}:${i}" title="${esc(st.steps[i].t)}">${i + 1}</button>`).join('')}</div>`).join('')
  }
  function objsHtml(n) {
    if (!n.objs?.length) return ''
    return `<h4>关键对象</h4><table class="kv">${n.objs.map(([name, d, r]) => `<tr><td><code>${esc(name)}</code></td><td>${esc(d)}</td><td>${r ? srcLink(r) : ''}</td></tr>`).join('')}</table>`
  }
  function compDetail(nid, extra = '') {
    const n = NODE.get(nid)
    return `<div class="kick" style="--zc:${zc(nid)}"><i></i>${esc(ZONE[n.zone][0])}</div><h3>${esc(n.name)}</h3><code class="pcode">${esc(n.code)}</code>
      <p>${fmt(n.text)}</p>${objsHtml(n)}<h4>源码</h4><div class="srcs">${n.src.map((r) => srcLink(r)).join('')}</div>
      <h4>出现在哪些步骤</h4>${appearHtml(nid)}${extra}`
  }

  /* ---------- overview ---------- */
  function initOverview() {
    const O = D.overview, box = $('#ov-canvas'), cap = $('#ov-caption')
    if (!box) return
    const byId = new Map(O.nodes.map((n) => [n.id, n]))
    const W = 1200, H = 760
    const anchor = (a, b) => {
      const ac = [a.x + a.w / 2, a.y + a.h / 2], bc = [b.x + b.w / 2, b.y + b.h / 2]
      const dx = bc[0] - ac[0], dy = bc[1] - ac[1]
      if (Math.abs(dy) > Math.abs(dx) * 0.45 && (b.y >= a.y + a.h || a.y >= b.y + b.h)) {
        const down = dy > 0
        return [[ac[0] + Math.max(-a.w / 3, Math.min(a.w / 3, dx / 4)), down ? a.y + a.h : a.y], [bc[0] - Math.max(-b.w / 3, Math.min(b.w / 3, dx / 4)), down ? b.y : b.y + b.h], 'v']
      }
      const right = dx > 0
      return [[right ? a.x + a.w : a.x, ac[1] + Math.max(-a.h / 3, Math.min(a.h / 3, dy / 6))], [right ? b.x : b.x + b.w, bc[1] - Math.max(-b.h / 3, Math.min(b.h / 3, dy / 6))], 'h']
    }
    let edges = ''
    const rounded = (pts, r = 8) => {
      let d = `M${pts[0][0]},${pts[0][1]}`
      for (let k = 1; k < pts.length - 1; k++) {
        const [px, py] = pts[k - 1], [cx, cy] = pts[k], [nx, ny] = pts[k + 1]
        const l1 = Math.hypot(cx - px, cy - py), l2 = Math.hypot(nx - cx, ny - cy), rr = Math.min(r, l1 / 2, l2 / 2)
        d += ` L${cx - ((cx - px) / l1) * rr},${cy - ((cy - py) / l1) * rr} Q${cx},${cy} ${cx + ((nx - cx) / l2) * rr},${cy + ((ny - cy) / l2) * rr}`
      }
      return d + ` L${pts.at(-1)[0]},${pts.at(-1)[1]}`
    }
    O.edges.forEach(([f, t, label, style, pts, lab], i) => {
      const a = byId.get(f), b = byId.get(t)
      let d, lx, ly, anc = 'middle'
      if (pts) {
        d = rounded(pts)
        if (lab) { [lx, ly] = lab; anc = { s: 'start', m: 'middle', e: 'end' }[lab[2] ?? 'm'] }
      } else {
        const [[x1, y1], [x2, y2], dir] = anchor(a, b)
        d = dir === 'v' ? `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}` : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`
        lx = (x1 + x2) / 2; ly = (y1 + y2) / 2 - 4
      }
      edges += `<g class="ov-e ${style}" data-e="${i}" data-from="${f}" data-to="${t}"><title>${esc(`${a.t} → ${b.t}${label ? `：${label}` : ''}`)}</title><path class="hit" d="${d}"/><path d="${d}" marker-end="url(#ov-arrow-${style})"/>${label && lx != null ? `<text x="${lx}" y="${ly}" style="text-anchor:${anc}">${esc(label)}</text>` : ''}</g>`
    })
    const layers = O.layers.map(([name, x, y, h, c]) => `<g class="ov-layer"><rect x="${x}" y="${y}" width="${W - 40}" height="${h}" rx="10" style="--lc:${c}"/><text x="${x + 12}" y="${y + 20}" style="fill:${c}">${esc(name)}</text></g>`).join('')
    const nodes = O.nodes.map((n) => `<g class="ov-n" tabindex="0" data-node-id="${n.id}" data-comp="${n.comp}" style="--zc:${zc(n.comp)}"><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8"/><rect class="bar" x="${n.x}" y="${n.y}" width="5" height="${n.h}" rx="2"/><text class="t" x="${n.x + n.w / 2}" y="${n.y + n.h / 2 - 3}">${esc(n.t)}</text><text class="s" x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 15}">${esc(n.s)}</text></g>`).join('')
    const marker = (k) => `<marker id="ov-arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="mk ${k}"/></marker>`
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Linux 内核分层总图"><defs>${['main', 'side', 'irq'].map(marker).join('')}</defs>${layers}<g>${edges}</g><g>${nodes}</g></svg>`
    function select(id) {
      const n = byId.get(id)
      for (const g of $$('.ov-n', box)) g.classList.toggle('sel', g.dataset.nodeId === id)
      for (const g of $$('.ov-e', box)) { const hot = g.dataset.from === id || g.dataset.to === id; g.classList.toggle('hot', hot); if (hot) g.parentNode.appendChild(g) }
      box.classList.add('focus')
      const ins = O.edges.filter((e) => e[1] === id).map((e) => byId.get(e[0]).t), outs = O.edges.filter((e) => e[0] === id).map((e) => byId.get(e[1]).t)
      cap.innerHTML = compDetail(n.comp, `<h4>连线</h4><table class="kv"><tr><td>上游</td><td>${esc(ins.join('、') || '—')}</td></tr><tr><td>下游</td><td>${esc(outs.join('、') || '—')}</td></tr></table><div class="jump"><button type="button" data-comp-go="${n.comp}">在全景图里看这个组件</button></div>`)
    }
    box.addEventListener('click', (e) => { const g = e.target.closest('.ov-n'); if (g) select(g.dataset.nodeId) })
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const g = e.target.closest('.ov-n'); if (g) select(g.dataset.nodeId) } })
    select('o-sched')
  }

  /* ---------- panorama ---------- */
  const P = { story: D.stories[0], step: 0, sub: -1, comp: null, timer: null, codeMode: 'both', fullCode: false, codeNotes: true }
  const edgesOf = (s, prevLast) => {
    const out = []
    let prev = prevLast
    s.calls.forEach((c, i) => { if (prev && prev !== c.n) out.push({ from: prev, to: c.n, i }); prev = c.n })
    return out
  }
  const lastNode = (st, i) => (i > 0 ? st.steps[i - 1].calls.at(-1).n : null)
  function storyEdges(st) {
    const m = new Map()
    st.steps.forEach((s, i) => { for (const e of edgesOf(s, lastNode(st, i))) { const k = `${e.from}>${e.to}`; m.set(k, (m.get(k) ?? 0) + 1) } })
    return m
  }
  const lanesOf = (st) => { const used = new Set(st.steps.flatMap((s) => s.calls.map((c) => c.n))); return D.nodes.filter((n) => used.has(n.id)).map((n) => n.id) }

  function initPano() {
    const root = $('#pano')
    if (!root) return
    root.innerHTML = `<div class="pano-tabs" role="tablist">${D.stories.map((s) => `<button type="button" role="tab" data-story="${s.id}"><b>${esc(s.short)}</b><span>${s.steps.length} 步 · ${s.steps.reduce((n, x) => n + x.calls.length, 0)} 次调用</span></button>`).join('')}</div>
      <p class="pano-intro" id="pano-intro"></p>
      <div class="pano-strip" id="pano-strip"></div>
      <div class="pano-main">
        <section class="seq-wrap"><div class="view-h"><b>时序图</b><span>每一列是一个组件，每一段是一步；箭头是控制流从一个组件到另一个组件。点任意一行跳到那一步。</span></div>
          <div class="seq-head" id="seq-head"></div><div class="seq-body" id="seq-body"></div></section>
        <aside class="pano-panel" id="pano-panel" aria-live="polite"></aside>
      </div>
      <div class="comp-main">
        <section class="grid-wrap"><div class="view-h"><b>组件图</b><span>亮起的是当前步骤经过的组件；带编号的粗线是这一步的控制流，按编号依次发生。灰线是这条流程其它步骤用过的连线。点卡片看组件。</span></div>
          <div class="grid-canvas" id="grid-canvas"><svg class="wires" id="wires" aria-hidden="true"></svg><div class="cgrid">${D.nodes.map((n) => `<article class="card" data-card="${n.id}" style="grid-row:${n.at[0]};grid-column:${n.at[1]} / span ${n.at[2]};--zc:${zc(n.id)}" tabindex="0"><header><span class="cz">${esc(ZONE[n.zone][0])}</span><span class="ccount"></span></header><h4>${esc(n.name)}</h4><code>${esc(n.code)}</code></article>`).join('')}</div></div>
          <div class="legend">${Object.values(ZONE).map(([name, c]) => `<span><i style="background:${c}"></i>${esc(name)}</span>`).join('')}</div></section>
        <aside class="comp-panel" id="comp-panel" aria-live="polite"></aside>
      </div>`
    root.addEventListener('click', onClick)
    $('#seq-body').addEventListener('scroll', () => { $('#seq-head').scrollLeft = $('#seq-body').scrollLeft })
    $('#grid-canvas').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) { P.comp = c.dataset.card; renderComp(); drawWires() } })
    $('#grid-canvas').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const c = e.target.closest('.card'); if (c) { P.comp = c.dataset.card; renderComp(); drawWires() } } })
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input,textarea,button,a,pre') || getSelection()?.toString() || e.altKey || e.metaKey || e.ctrlKey) return
      const r = $('#pano').getBoundingClientRect()
      if (r.bottom < 0 || r.top > innerHeight) return
      if (e.key === 'ArrowRight' || e.key === 'j') { go(P.step + 1); e.preventDefault() }
      if (e.key === 'ArrowLeft' || e.key === 'k') { go(P.step - 1); e.preventDefault() }
    })
    let rz
    window.addEventListener('resize', () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(drawWires) })
    new ResizeObserver(() => drawWires()).observe($('#grid-canvas'))
    setStory(P.story.id, 0)
  }

  function onClick(e) {
    const mode = e.target.closest('[data-code-mode]')
    if (mode) { P.codeMode = mode.dataset.codeMode; renderImplementation(); return }
    const full = e.target.closest('[data-code-full]')
    if (full) { P.fullCode = !P.fullCode; renderImplementation(); return }
    const notes = e.target.closest('[data-code-notes]')
    if (notes) { P.codeNotes = !P.codeNotes; renderImplementation(); return }
    const copy = e.target.closest('[data-code-copy]')
    if (copy) { copyImplementation(copy); return }
    if (e.target.closest('a.src')) return
    const t = e.target.closest('[data-story],[data-step],[data-sub],[data-nav],[data-play]')
    if (!t) return
    if (t.dataset.story) setStory(t.dataset.story, 0)
    else if (t.dataset.step) go(Number(t.dataset.step), t.dataset.sc !== undefined ? Number(t.dataset.sc) : -1)
    else if (t.dataset.sub) { P.sub = P.sub === Number(t.dataset.sub) ? -1 : Number(t.dataset.sub); P.comp = P.sub >= 0 ? P.story.steps[P.step].calls[P.sub].n : P.comp; P.fullCode = false; render(false); const pane = $('#implementation'); const panel = $('#pano-panel'); panel.scrollTop += pane.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12 }
    else if (t.dataset.nav) go(P.step + Number(t.dataset.nav))
    else if (t.dataset.play) togglePlay()
  }
  function togglePlay() {
    if (P.timer) { clearInterval(P.timer); P.timer = null }
    else { if (P.step >= P.story.steps.length - 1) go(0); P.timer = setInterval(() => { if (P.step >= P.story.steps.length - 1) togglePlay(); else go(P.step + 1) }, 3200) }
    const b = $('[data-play]'); if (b) b.textContent = P.timer ? '暂停' : '自动播放'
  }
  function setStory(id, step) {
    P.story = STORY.get(id); P.step = -1
    for (const b of $$('[data-story]')) b.setAttribute('aria-selected', String(b.dataset.story === id))
    $('#pano-intro').innerHTML = fmt(P.story.intro)
    $('#pano-strip').innerHTML = P.story.steps.map((s, i) => `<button type="button" class="strip-b k-${s.kind}${s.side ? ' side' : ''}" data-step="${i}" title="${esc(s.t)}"><i>${i + 1}</i><span>${esc(s.t)}</span><em style="--cc:${CTX[s.ctx][2]}">${esc(CTX[s.ctx][0])}</em></button>`).join('')
    const cnt = new Map()
    for (const s of P.story.steps) for (const c of s.calls) cnt.set(c.n, (cnt.get(c.n) ?? 0) + 1)
    for (const c of $$('.card')) { const n = cnt.get(c.dataset.card) ?? 0; c.classList.toggle('unused', !n); $('.ccount', c).textContent = n ? `${n} 次` : '' }
    drawSeq()
    go(step, -1, true)
  }
  function go(i, sub = -1, force) {
    const n = P.story.steps.length
    i = Math.max(0, Math.min(n - 1, i))
    if (i === P.step && sub === P.sub && !force) return
    const changed = i !== P.step
    P.step = i; P.sub = sub; P.fullCode = false
    if (sub >= 0) P.comp = P.story.steps[i].calls[sub].n
    else if (changed || !P.comp) P.comp = P.story.steps[i].calls.find((c) => c.n !== 'user')?.n ?? P.story.steps[i].calls[0].n
    render(changed)
    try { history.replaceState(null, '', `#pano/${P.story.id}/${i + 1}`) } catch {}
  }

  /* sequence diagram */
  const SEQ = { laneW: 70, labelW: 190, rowH: 19, headH: 46, bandPad: 24 }
  let seqRows = []
  function drawSeq() {
    const st = P.story, lanes = lanesOf(st), lx = new Map(lanes.map((id, k) => [id, SEQ.labelW + SEQ.laneW * k + SEQ.laneW / 2]))
    const W = SEQ.labelW + SEQ.laneW * lanes.length + 20
    $('#seq-head').innerHTML = `<div style="width:${W}px;position:relative;height:${SEQ.headH}px">${lanes.map((id) => `<div class="lane-h" style="left:${lx.get(id) - SEQ.laneW / 2 + 2}px;width:${SEQ.laneW - 4}px;--zc:${zc(id)}" data-lane="${id}">${esc(NODE.get(id).name)}</div>`).join('')}</div>`
    let y = 8, body = '', bands = ''
    seqRows = []
    st.steps.forEach((s, i) => {
      const top = y
      y += SEQ.bandPad
      let prev = lastNode(st, i)
      s.calls.forEach((c, k) => {
        const x2 = lx.get(c.n), cy = y + SEQ.rowH / 2
        if (prev && prev !== c.n) {
          const x1 = lx.get(prev), dir = x2 > x1 ? 1 : -1, lab = Math.min(x1, x2) + Math.abs(x2 - x1) / 2
          body += `<g class="sq-a${k === 0 ? ' carry' : ''}" data-step="${i}" data-sc="${k}" data-si="${i}:${k}"><line x1="${x1}" y1="${cy}" x2="${x2 - dir * 5}" y2="${cy}"/><path d="M${x2},${cy} l${-dir * 7},-4 v8 z"/><text x="${lab}" y="${cy - 3}">${esc(c.f)}</text></g>`
        } else {
          body += `<g class="sq-s" data-step="${i}" data-sc="${k}" data-si="${i}:${k}"><circle cx="${x2}" cy="${cy}" r="3.5"/><text x="${x2 + 8}" y="${cy + 3.5}">${esc(c.f)}</text></g>`
        }
        prev = c.n; y += SEQ.rowH
      })
      y += 8
      bands += `<g class="sq-band" data-step="${i}" data-band="${i}"><rect x="2" y="${top}" width="${W - 4}" height="${y - top - 2}" rx="6"/><text class="sq-n" x="12" y="${top + 16}">${i + 1}</text><text class="sq-t" x="34" y="${top + 16}">${esc(s.t.length > 26 ? s.t.slice(0, 25) + '…' : s.t)}</text><text class="sq-c" x="34" y="${top + 31}" style="fill:${CTX[s.ctx][2]}">${esc(CTX[s.ctx][0])}</text></g>`
      seqRows.push([top, y])
    })
    const lifelines = lanes.map((id) => `<line class="life" x1="${lx.get(id)}" y1="0" x2="${lx.get(id)}" y2="${y}" style="stroke:${zc(id)}"/>`).join('')
    $('#seq-body').innerHTML = `<svg width="${W}" height="${y + 6}" class="seq">${bands}${lifelines}${body}</svg>`
  }

  function render(scroll) {
    const st = P.story, s = st.steps[P.step], N = st.steps.length
    for (const b of $$('.strip-b')) { const k = Number(b.dataset.step); b.classList.toggle('on', k === P.step); b.classList.toggle('done', k < P.step) }
    $('.strip-b.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    for (const g of $$('.sq-band')) g.classList.toggle('on', Number(g.dataset.band) === P.step)
    for (const g of $$('[data-si]')) { const [a, b] = g.dataset.si.split(':').map(Number); g.classList.toggle('on', a === P.step); g.classList.toggle('cur', a === P.step && b === P.sub) }
    const used = new Set(s.calls.map((c) => c.n))
    for (const h of $$('.lane-h')) h.classList.toggle('on', used.has(h.dataset.lane))
    if (scroll) {
      const body = $('#seq-body'), [top, bot] = seqRows[P.step]
      if (top < body.scrollTop || bot > body.scrollTop + body.clientHeight) body.scrollTo({ top: Math.max(0, top - 40), behavior: 'smooth' })
      const ls = lanesOf(st), xs = [...used].map((id) => SEQ.labelW + SEQ.laneW * (ls.indexOf(id) + 0.5))
      const x0 = Math.min(...xs) - SEQ.laneW, x1 = Math.max(...xs) + SEQ.laneW, vw = body.clientWidth - SEQ.labelW
      if (x0 - SEQ.labelW < body.scrollLeft || x1 > body.scrollLeft + body.clientWidth) body.scrollTo({ left: Math.max(0, x1 - x0 > vw ? x0 - SEQ.labelW : x0 - SEQ.labelW - (vw - (x1 - x0)) / 2), behavior: 'smooth' })
    }
    const c = CTX[s.ctx]
    const states = (s.state ?? []).map(([who, a, b, note]) => `<li><b>${esc(who)}</b><span class="st st-${a}">${stName(a)}</span>→<span class="st st-${b}">${stName(b)}</span>${note ? `<em>${esc(note)}</em>` : ''}</li>`).join('')
    $('#pano-panel').innerHTML = `<div class="pp-nav"><button type="button" data-nav="-1" ${P.step === 0 ? 'disabled' : ''}>← 上一步</button><span class="pp-kicker">第 ${P.step + 1} / ${N} 步 · ${esc(D.kinds[s.kind])}</span><button type="button" data-nav="1" ${P.step === N - 1 ? 'disabled' : ''}>下一步 →</button></div>
      <h3>${esc(s.t)}</h3>
      <div class="ctx" style="--cc:${c[2]}"><b>${esc(c[0])}</b><span>${esc(c[1])}</span></div>
      ${s.side ? '<div class="side-note">旁路：只在特定条件下出现</div>' : ''}
      <p class="pp-text">${fmt(s.text)}</p>
      ${states ? `<h4>状态变化</h4><ul class="states">${states}</ul>` : ''}
      <h4>调用链 <small>点函数查看源码与原理，并在组件图上定位</small></h4>
      <ol class="calls">${s.calls.map((x, k) => `<li class="${k === P.sub ? 'cur' : ''}" data-sub="${k}" style="--zc:${zc(x.n)}"><span class="cn">${k + 1}</span><button type="button" class="call-function" aria-pressed="${k === P.sub}" title="查看此小步骤的实现">${esc(x.f)}</button><span class="chip">${esc(NODE.get(x.n).name)}</span>${x.note ? `<span class="note">${esc(x.note)}</span>` : ''}${x.src ? srcLink(x.src) : ''}</li>`).join('')}</ol>
      <div id="implementation"></div>
      ${s.data ? `<h4>数据 ${s.dataNote ? `<small>${esc(s.dataNote)}</small>` : '<small>示意值，字段名与源码一致；悬停字段名看含义</small>'}</h4><pre class="json">${jsonHtml(s.data)}</pre>` : ''}
      ${s.why ? `<div class="why"><b>为什么这样设计</b><p>${fmt(s.why)}</p></div>` : ''}
      <div class="pp-foot"><button type="button" data-play="1">${P.timer ? '暂停' : '自动播放'}</button><span>键盘 ← → 也可以翻步</span></div>`
    renderImplementation()
    renderComp()
    drawWires()
  }

  /* ---------- implementation reader ---------- */
  const CODE_FOCUS = {
    tty_flip_buffer_push: 'tty_flip_buffer_commit', n_tty_receive_handle_newline: 'set_bit',
    wait_woken: 'set_current_state', resched_curr: 'if (cpu ==',
    try_to_wake_up: 'if (!ttwu_state_match', context_switch: 'if (!next->mm)',
    __schedule: 'next = pick_next_task', pick_eevdf: 'while (node)',
    update_deadline: 'se->deadline =', n_tty_receive_char: 'if (L_ECHO',
    n_tty_read: 'wait_woken', filemap_fault: 'if (!folio)',
    filemap_get_pages: 'page_cache_sync_ra', wp_page_copy: 'pte_same',
    copy_page_range: 'is_cow_mapping', filemap_map_pages: 'do {',
    filemap_read: 'filemap_get_pages', virtio_queue_rq: 'virtblk_add_req',
    folio_end_read: 'if (likely(success))', lookup_fast: '__d_lookup_rcu',
    fd_install: 'rcu_assign_pointer', handle_softirqs: 'while (pending)',
    do_idle: 'while (!need_resched())', tick_nohz_idle_stop_tick: 'tick_nohz_next_event',
    do_initcall_level: 'for (fn =', rest_init: 'user_mode_thread',
    exec_mmap: 'tsk->mm = mm', exit_notify: 'EXIT_ZOMBIE',
    wait_task_zombie: 'cmpxchg', balance_pgdat: 'do {',
    process_output_block: 'case', delayed_work_timer_fn: '__queue_work',
  }
  function codeTokens(line) {
    const re = /(\/\/.*|\/\*.*?\*\/|\/\*.*|^\s*\*.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:if|else|for|while|do|return|switch|case|break|continue|goto|struct|static|void|int|bool|unsigned|long|const|sizeof|enum|union)\b|\b(?:0x[\da-fA-F]+|\d+)\b|\b[A-Za-z_]\w*(?=\s*\())/g
    let out = '', last = 0
    for (const m of line.matchAll(re)) {
      out += esc(line.slice(last, m.index))
      const token = m[0], kind = /^(\s*\*|\/\/|\/\*)/.test(token) ? 'comment' : /^["']/.test(token) ? 'string' : /^(?:0x|\d)/.test(token) ? 'number' : /\(/.test(line.slice(m.index + token.length).trimStart()[0] ?? '') ? 'fn' : 'keyword'
      out += '<span class="ct-' + kind + '">' + esc(token) + '</span>'
      last = m.index + token.length
    }
    return out + esc(line.slice(last))
  }
  function codeRows(ls, start, indices, marks = [], notes = []) {
    let previous = -1
    return indices.map(i => {
      const gap = previous >= 0 && i > previous + 1 ? '<span class="code-gap">⋯ 省略 ' + (i - previous - 1) + ' 行；可展开完整定义 ⋯</span>' : ''
      previous = i
      const hot = marks.some(x => x && ls[i].includes(x))
      const note = P.codeNotes && notes[i] ? lineNote(notes[i], start + i) : ''
      return gap + '<span class="annotated-row" data-source-line="' + (start + i) + '"><span class="code-line' + (hot ? ' code-hot' : '') + '"><span class="line-no">' + (start + i) + '</span><span class="line-code">' + codeTokens(ls[i]) + '</span></span>' + note + '</span>'
    }).join('')
  }
  function lineNote(note, number) {
    if (typeof note === 'string') return '<span class="line-note"><span class="note-action">// 第' + number + '行：' + esc(note) + '</span></span>'
    const symbols = note.symbols.map(id => {
      const g = S.glossary[id]
      const loc = g.file ? '<a class="note-definition" href="' + esc(S.repo + g.file + '?h=' + S.tag + '#n' + g.line) + '" target="_blank" rel="noopener noreferrer">本地版本定义 ' + esc(g.file + ':' + g.line) + '</a>' : ''
      return '<span class="note-symbol"><code>' + esc(g.name) + '</code><em>' + esc(g.kind) + '</em> ' + esc(g.meaning) + (g.decl ? '<span class="note-decl">声明：<code>' + esc(g.decl) + '</code> ' + loc + '</span>' : loc) + (g.doc ? '<details class="note-doc"><summary>原作者接口说明</summary><span>' + esc(g.doc) + '</span></details>' : '') + '</span>'
    }).join('')
    return '<span class="line-note"><span class="note-action">// 第' + number + '行：' + esc(note.text) + '</span>' + symbols + '</span>'
  }
  function annotatedCopy(lines, notes) {
    return lines.map((line, i) => {
      const note = notes[i]
      const text = typeof note === 'string' ? note : note.text + note.symbols.map(id => { const g = S.glossary[id]; return '\n' + g.name + '（' + g.kind + '）：' + g.meaning + (g.decl ? ' 声明：' + g.decl : '') }).join('')
      return line + '\n' + text.split('\n').map(x => '// ' + x).join('\n')
    }).join('\n')
  }
  function activeImplementation() {
    const s = P.story.steps[P.step], lesson = D.lessons[P.story.id][P.step]
    const c = P.sub >= 0 ? s.calls[P.sub] : s.calls.find(x => x.f === lesson.focus)
    return { s, lesson, c, snippet: c.src ? S.snippets[c.src] : null }
  }
  function renderImplementation() {
    const el = $('#implementation')
    if (!el) return
    const { s, lesson, c, snippet } = activeImplementation()
    const modes = [['both', '对照阅读'], ['pseudo', '教学伪代码'], ['source', '真实源码']]
    let real = ''
    if (snippet) {
      const ls = snippet.lines, symbol = c.src.split(':').at(-1)
      const nextCall = s.calls[s.calls.indexOf(c) + 1]?.f
      const mark = CODE_FOCUS[symbol] ?? (nextCall && ls.some(x => x.includes(nextCall)) ? nextCall : null)
      const found = mark ? ls.findIndex(x => x.includes(mark)) : -1
      const center = found < 0 ? 16 : found
      const idx = P.fullCode || ls.length <= 64 ? ls.map((_, i) => i) : [...new Set([...ls.slice(0, 7).map((_, i) => i), ...ls.slice(Math.max(7, center - 5), Math.min(ls.length, Math.max(7, center - 5) + 28)).map((_, i) => Math.max(7, center - 5) + i)])].sort((a, b) => a - b)
      const last = idx.at(-1), tail = last < ls.length - 1 ? '<span class="code-gap">⋯ 后续 ' + (ls.length - last - 1) + ' 行未显示；可展开完整定义 ⋯</span>' : ''
      const local = S.localRoot + '/' + snippet.file + '#L' + snippet.a + '-L' + snippet.b
      real = '<section class="source-reading" aria-label="真实源码"><div class="reader-head"><b>真实源码 · ' + esc(S.tag) + '</b><span class="reader-copy"><button type="button" data-code-copy="annotated-source">复制含注释</button><button type="button" data-code-copy="source">复制原文</button></span></div><p class="reader-caption">' + (P.sub < 0 ? '本步代表函数：' : '当前小步骤：') + '<code>' + esc(c.f) + '</code> · ' + ls.length + ' 行</p><div class="reader-src">' + srcLink(c.src, snippet.file + ':' + snippet.a + '-' + snippet.b) + '<a class="src" href="' + esc(local) + '" title="在本地源码编辑器定位；网页预览请使用上游链接">本地定位</a></div><p class="reader-caption">' + esc(c.note || '结合本步说明与下方代码阅读。') + '</p><pre class="impl-code" aria-label="' + esc(c.f) + '的真实代码">' + codeRows(ls, snippet.a, idx, [mark, nextCall], S.annotations[c.src]) + tail + '</pre>' + (ls.length > 64 ? '<button type="button" class="code-expand" data-code-full="1" aria-expanded="' + P.fullCode + '">' + (P.fullCode ? '收起为关键片段' : '展开完整定义（' + ls.length + ' 行）') + '</button>' : '') + '<p class="reader-caption">上方是本地内核原文和真实行号，下方 // 是独立生成的教学讲解。讲解结合人工机制说明与本地声明提取，命名阅读和定位待确认的符号会明确标注；精确C类型和宏展开需由编译器分析。高亮标出阅读重点，实际执行分支需以运行时记录确认。</p></section>'
    } else {
      real = '<section class="source-reading"><div class="reader-head"><b>' + esc(c.f) + '：事件 / 用户态阶段</b></div><p>本阶段按硬件事件或用户态动作展示。' + esc(c.note || '') + '</p><p class="reader-caption">相邻内核调用提供真实实现引用；本步伪代码解释阶段间的因果关系。</p></section>'
    }
    const pseudo = '<section class="pseudo-reading" aria-label="教学伪代码"><div class="reader-head"><b>教学伪代码 · 整步机制</b><span class="reader-copy"><button type="button" data-code-copy="annotated-pseudo">复制含注释</button><button type="button" data-code-copy="pseudo">复制伪代码</button></span></div><p class="reader-caption">本段是为阅读算法编写的简化机制模型；可执行实现见真实源码。异步通知、设备事件与函数调用分别发生在对应执行上下文。</p><pre class="impl-code pseudo-code">' + codeRows(lesson.pseudo.split('\n'), 1, lesson.pseudo.split('\n').map((_, i) => i), [], lesson.lineNotes) + '</pre><div class="principle"><b>核心原理</b><p>' + esc(lesson.principle) + '</p></div><h4>读代码时抓住这两点</h4><ol class="reading-points">' + lesson.reads.map(x => '<li>' + esc(x) + '</li>').join('') + '</ol></section>'
    el.innerHTML = '<div class="implementation"><h4>实现原理 <small>伪代码看机制，源码看细节</small></h4><div class="reader-modes" role="group" aria-label="代码阅读模式">' + modes.map(([id, name]) => '<button type="button" data-code-mode="' + id + '" aria-pressed="' + (id === P.codeMode) + '">' + name + '</button>').join('') + '</div><div class="annotation-tools"><button type="button" data-code-notes="1" aria-pressed="' + P.codeNotes + '">' + (P.codeNotes ? '逐行讲解：已开启' : '逐行讲解：已关闭') + '</button><span>每行看操作，再看本行函数、变量和宏；汇编说明操作数、寄存器及启动原因。</span></div>' + (P.codeMode !== 'source' ? pseudo : '') + (P.codeMode !== 'pseudo' ? real : '') + '</div>'
  }
  async function copyImplementation(button) {
    const { lesson, snippet, c } = activeImplementation()
    const mode = button.dataset.codeCopy
    const text = mode === "annotated-pseudo" ? annotatedCopy(lesson.pseudo.split("\n"), lesson.lineNotes) : mode === "annotated-source" ? (snippet && annotatedCopy(snippet.lines, S.annotations[c.src])) : mode === "pseudo" ? lesson.pseudo : snippet?.lines.join("\n")
    if (!text) return
    const label = button.textContent
    try { await navigator.clipboard.writeText(text); button.textContent = '已复制' }
    catch { button.textContent = '浏览器禁止复制，请选中代码复制' }
    setTimeout(() => { if (button.isConnected) button.textContent = label }, 1800)
  }

  const ST = { N: '新建', R: '可运行', S: '浅睡', D: '深睡', Z: '僵尸', X: '已回收' }
  const stName = (k) => ST[k] ?? k

  function renderComp() {
    const id = P.comp
    for (const c of $$('.card')) c.classList.toggle('sel', c.dataset.card === id)
    if (!id) return
    const s = P.story.steps[P.step], here = s.calls.map((c, k) => [c, k]).filter(([c]) => c.n === id)
    const extra = here.length ? `<h4>在当前这一步</h4><ol class="calls mini">${here.map(([c, k]) => `<li data-sub="${k}" style="--zc:${zc(id)}"><span class="cn">${k + 1}</span><code>${esc(c.f)}</code>${c.src ? srcLink(c.src) : ''}</li>`).join('')}</ol>` : '<p class="muted">本步展示其他组件的执行。</p>'
    $('#comp-panel').innerHTML = compDetail(id, extra)
  }

  function drawWires() {
    const canvas = $('#grid-canvas'), svg = $('#wires')
    if (!canvas || !P.story) return
    const cr = canvas.getBoundingClientRect()
    svg.setAttribute('width', cr.width); svg.setAttribute('height', cr.height)
    const box = new Map($$('.card', canvas).map((c) => { const r = c.getBoundingClientRect(); return [c.dataset.card, { x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height }] }))
    const s = P.story.steps[P.step]
    const act = edgesOf(s, lastNode(P.story, P.step))
    const all = storyEdges(P.story)
    const used = new Set(s.calls.map((c) => c.n))
    for (const c of $$('.card', canvas)) { c.classList.toggle('on', used.has(c.dataset.card)); c.classList.toggle('cur', P.sub >= 0 && s.calls[P.sub].n === c.dataset.card) }
    const clip = (b, x, y, tx, ty) => {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = tx - cx, dy = ty - cy
      const k = Math.min(Math.abs(b.w / 2 / (dx || 1e-6)), Math.abs(b.h / 2 / (dy || 1e-6)))
      return [cx + dx * k, cy + dy * k]
    }
    const path = (a, b, bend) => {
      const A = box.get(a), B = box.get(b)
      const ac = [A.x + A.w / 2, A.y + A.h / 2], bc = [B.x + B.w / 2, B.y + B.h / 2]
      const mx = (ac[0] + bc[0]) / 2, my = (ac[1] + bc[1]) / 2, len = Math.hypot(bc[0] - ac[0], bc[1] - ac[1]) || 1
      const nx = -(bc[1] - ac[1]) / len, ny = (bc[0] - ac[0]) / len
      const qx = mx + nx * bend, qy = my + ny * bend
      const p1 = clip(A, ...ac, qx, qy), p2 = clip(B, ...bc, qx, qy)
      return { d: `M${p1[0]},${p1[1]} Q${qx},${qy} ${p2[0]},${p2[1]}`, mid: [(p1[0] + 2 * qx + p2[0]) / 4, (p1[1] + 2 * qy + p2[1]) / 4] }
    }
    let out = `<defs><marker id="w-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker><marker id="w-ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>`
    const actKeys = new Set(act.map((e) => `${e.from}>${e.to}`))
    for (const [k] of all) {
      if (actKeys.has(k)) continue
      const [a, b] = k.split('>'), p = path(a, b, all.has(`${b}>${a}`) ? 14 : 0)
      const focus = P.comp && (a === P.comp || b === P.comp)
      out += `<path class="w-bg${focus ? ' focus' : ''}" d="${p.d}" marker-end="url(#w-ar2)"/>`
    }
    const seen = new Map()
    act.forEach((e, k) => {
      const key = `${e.from}>${e.to}`, rep = seen.get(key) ?? 0
      seen.set(key, rep + 1)
      const bend = (all.has(`${e.to}>${e.from}`) ? 14 : 0) + rep * 10
      const p = path(e.from, e.to, bend)
      const cur = P.sub >= 0 && e.i === P.sub
      out += `<g class="w-act${cur ? ' cur' : ''}" style="--zc:${zc(e.to)}"><path d="${p.d}" marker-end="url(#w-ar)"/><circle cx="${p.mid[0]}" cy="${p.mid[1]}" r="9"/><text x="${p.mid[0]}" y="${p.mid[1] + 3.5}">${k + 1}</text><title>${esc(`${k + 1}. ${NODE.get(e.from).name} → ${NODE.get(e.to).name}：${P.story.steps[P.step].calls[e.i].f}`)}</title></g>`
    })
    svg.innerHTML = out
  }

  /* ---------- cross-cut matrices ---------- */
  function initLens() {
    const a = $('#lens-ctx'), b = $('#lens-comp')
    if (a) {
      a.innerHTML = `<table class="matrix"><thead><tr><th>执行上下文</th>${D.stories.map((s) => `<th>${esc(s.short)}</th>`).join('')}</tr></thead><tbody>${Object.entries(CTX).map(([id, [name, desc, color]]) => `<tr><td class="mh" style="--cc:${color}"><b>${esc(name)}</b><span>${esc(desc)}</span></td>${D.stories.map((st) => `<td>${st.steps.map((s, i) => s.ctx === id ? `<button type="button" class="stepchip" data-go="${st.id}:${i}" title="${esc(s.t)}" style="--cc:${color}">${i + 1}</button>` : '').join('')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    }
    if (b) {
      const cnt = (st, id) => st.steps.reduce((n, s) => n + s.calls.filter((c) => c.n === id).length, 0)
      const max = Math.max(...D.nodes.flatMap((n) => D.stories.map((st) => cnt(st, n.id))))
      b.innerHTML = `<table class="matrix heat"><thead><tr><th>组件</th>${D.stories.map((s) => `<th>${esc(s.short)}</th>`).join('')}<th>合计</th></tr></thead><tbody>${D.nodes.map((n) => {
        const row = D.stories.map((st) => cnt(st, n.id)), total = row.reduce((x, y) => x + y, 0)
        return `<tr><td class="mh" style="--cc:${zc(n.id)}"><b>${esc(n.name)}</b><span>${esc(n.code)}</span></td>${row.map((v, k) => {
          const st = D.stories[k], first = st.steps.findIndex((s) => s.calls.some((c) => c.n === n.id))
          return `<td>${v ? `<button type="button" class="heatcell" data-go="${st.id}:${first}" data-goc="${n.id}" style="--h:${(0.12 + 0.75 * v / max).toFixed(2)};--cc:${zc(n.id)}" title="${esc(`${st.short}：${v} 次调用，从第 ${first + 1} 步开始`)}">${v}</button>` : '<span class="nil">·</span>'}</td>`
        }).join('')}<td class="tot">${total}</td></tr>`
      }).join('')}</tbody></table>`
    }
  }

  /* ---------- task state machine ---------- */
  function initStates() {
    const box = $('#state-svg'), list = $('#state-list')
    if (!box) return
    const pos = { N: [90, 170], R: [330, 170], S: [600, 44], D: [600, 300], Z: [820, 170], X: [1030, 170] }
    const desc = { N: 'copy_process 刚建好，还没入队', R: 'TASK_RUNNING：在运行队列上，或正在 CPU 上跑', S: 'TASK_INTERRUPTIBLE：等事件，信号能叫醒', D: 'TASK_UNINTERRUPTIBLE / KILLABLE：等 I/O，只有完成或致命信号能叫醒', Z: 'EXIT_ZOMBIE：资源已释放，留着退出码等父进程', X: 'EXIT_DEAD：release_task 回收' }
    const tr = new Map()
    for (const st of D.stories) st.steps.forEach((s, i) => { for (const [who, a, b, note] of s.state ?? []) { if (a === b) continue; const k = `${a}>${b}`; if (!tr.has(k)) tr.set(k, []); tr.get(k).push({ st, i, who, note }) } })
    const fixed = [['N', 'R', 'wake_up_new_task'], ['R', 'S', 'wait_woken / schedule'], ['S', 'R', 'try_to_wake_up'], ['R', 'D', 'folio_wait_bit_common'], ['D', 'R', '完成中断唤醒'], ['R', 'Z', 'exit_notify'], ['Z', 'X', 'release_task']]
    const arc = (a, b) => {
      const [x1, y1] = pos[a], [x2, y2] = pos[b], dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy)
      const ux = dx / len, uy = dy / len, r = 46, bend = tr.has(`${b}>${a}`) || fixed.some(([p, q]) => p === b && q === a) ? 48 : 0
      const sx = x1 + ux * r, sy = y1 + uy * r, ex = x2 - ux * r, ey = y2 - uy * r
      const qx = (sx + ex) / 2 - uy * bend, qy = (sy + ey) / 2 + ux * bend
      return { d: `M${sx},${sy} Q${qx},${qy} ${ex},${ey}`, mx: (sx + 2 * qx + ex) / 4, my: (sy + 2 * qy + ey) / 4, nx: bend ? -uy : 0, ny: bend ? ux : 0, len, sx, ex }
    }
    let edges = ''
    for (const [a, b, fn] of fixed) {
      const k = `${a}>${b}`, n = tr.get(k)?.length ?? 0, p = arc(a, b)
      const far = !p.nx && p.len > 300, tx = far ? p.sx + (p.ex - p.sx) * 0.78 : p.mx
      const lx = p.nx ? p.mx + p.nx * 16 : tx, ly = p.nx ? p.my + p.ny * 16 + 4 : p.my - 6
      const cx = p.nx ? p.mx : tx, cy = p.nx ? p.my : p.my + 8
      edges += `<g class="se${n ? '' : ' none'}" data-tr="${k}"><path d="${p.d}" marker-end="url(#se-ar)"/><text x="${lx}" y="${ly}" text-anchor="${p.nx > 0.3 ? 'start' : p.nx < -0.3 ? 'end' : 'middle'}">${esc(fn)}</text>${n ? `<circle cx="${cx}" cy="${cy}" r="9"/><text class="cnt" x="${cx}" y="${cy + 3.5}">${n}</text>` : ''}</g>`
    }
    const nodes = Object.entries(pos).map(([k, [x, y]]) => `<g class="sn st-${k}"><circle cx="${x}" cy="${y}" r="44"/><text x="${x}" y="${y - 2}" class="big">${k}</text><text x="${x}" y="${y + 16}">${ST[k]}</text><title>${esc(desc[k])}</title></g>`).join('')
    box.innerHTML = `<svg viewBox="0 0 1120 352" role="img" aria-label="task 状态机"><defs><marker id="se-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>${edges}${nodes}</svg>`
    const show = (k) => {
      for (const g of $$('.se', box)) g.classList.toggle('sel', g.dataset.tr === k)
      const [a, b] = k.split('>'), rows = tr.get(k) ?? []
      list.innerHTML = `<h4>${stName(a)} → ${stName(b)} <small>${esc(desc[b])}</small></h4>` + (rows.length ? `<ul class="states">${rows.map((r) => `<li><b>${esc(r.who)}</b><button type="button" class="stepchip wide" data-go="${r.st.id}:${r.i}">${esc(r.st.short)} · 第 ${r.i + 1} 步</button><span>${esc(r.st.steps[r.i].t)}</span>${r.note ? `<em>${esc(r.note)}</em>` : ''}</li>`).join('')}</ul>` : '<p class="muted">此转换位于三条流程的展示范围之外。</p>')
    }
    box.addEventListener('click', (e) => { const g = e.target.closest('.se'); if (g) show(g.dataset.tr) })
    show('S>R')
  }

  /* ---------- code index ---------- */
  function initCode() {
    const el = $('#code-table'), q = $('#code-q')
    if (!el) return
    const rows = new Map()
    for (const st of D.stories) st.steps.forEach((s, i) => s.calls.forEach((c) => {
      if (!c.src) return
      if (!rows.has(c.src)) rows.set(c.src, { f: c.f, n: c.n, notes: new Set(), at: [] })
      const r = rows.get(c.src)
      if (c.note) r.notes.add(c.note)
      if (!r.at.some((x) => x[0] === st && x[1] === i)) r.at.push([st, i])
    }))
    const order = new Map(D.nodes.map((n, k) => [n.id, k]))
    const list = [...rows.entries()].sort((a, b) => order.get(a[1].n) - order.get(b[1].n) || a[1].f.localeCompare(b[1].f))
    const structs = D.nodes.flatMap((n) => (n.objs ?? []).map((o) => ({ n: n.id, o })))
    el.innerHTML = `<table class="code"><thead><tr><th>符号</th><th>组件</th><th>在流程里做什么</th><th>出现在</th><th>位置（${esc(S.tag)}）</th></tr></thead><tbody>${list.map(([ref, r]) => `<tr data-q="${esc(`${r.f} ${NODE.get(r.n).name} ${ref} ${[...r.notes].join(' ')}`.toLowerCase())}"><td><code>${esc(r.f)}</code></td><td><span class="chip" style="--zc:${zc(r.n)}">${esc(NODE.get(r.n).name)}</span></td><td class="wrap">${esc([...r.notes].slice(0, 2).join('；'))}</td><td>${r.at.map(([st, i]) => `<button type="button" class="stepchip" data-go="${st.id}:${i}" title="${esc(`${st.short} · ${st.steps[i].t}`)}">${esc(st.short.slice(0, 2))}${i + 1}</button>`).join('')}</td><td>${srcLink(ref)}</td></tr>`).join('')}
      ${structs.map(({ n, o }) => `<tr data-q="${esc(`${o[0]} ${o[1]} ${NODE.get(n).name}`.toLowerCase())}" class="struct"><td><code>${esc(o[0])}</code></td><td><span class="chip" style="--zc:${zc(n)}">${esc(NODE.get(n).name)}</span></td><td class="wrap">${esc(o[1])}</td><td></td><td>${o[2] ? srcLink(o[2]) : ''}</td></tr>`).join('')}</tbody></table>`
    $('#code-count').textContent = `${list.length} 个函数 · ${structs.length} 个结构`
    q?.addEventListener('input', () => { const v = q.value.trim().toLowerCase(); for (const tr of $$('tbody tr', el)) tr.hidden = v && !tr.dataset.q.includes(v) })
  }

  /* ---------- cross links ---------- */
  function initLinks() {
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-go]'), c = e.target.closest('[data-comp-go]')
      if (g) {
        const [sid, i] = g.dataset.go.split(':')
        if (P.timer) togglePlay()
        if (P.story.id !== sid) setStory(sid, Number(i)); else go(Number(i), -1, true)
        if (g.dataset.goc) { P.comp = g.dataset.goc; renderComp(); drawWires() }
        if (!g.closest('#pano')) $('#pano').scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else if (c) {
        const id = c.dataset.compGo, st = D.stories.find((s) => s.steps.some((x) => x.calls.some((y) => y.n === id)))
        if (st) { const i = st.steps.findIndex((x) => x.calls.some((y) => y.n === id)); setStory(st.id, i) }
        P.comp = id; renderComp(); drawWires()
        $('#comp-panel').scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    })
    const m = /^#pano\/(\w+)\/(\d+)$/.exec(HASH0)
    if (m && STORY.has(m[1])) { setStory(m[1], Number(m[2]) - 1); requestAnimationFrame(() => $('#pano').scrollIntoView()) }
    addEventListener('hashchange', () => { const h = /^#pano\/(\w+)\/(\d+)$/.exec(location.hash); if (h && STORY.has(h[1])) { if (P.story.id !== h[1]) setStory(h[1], Number(h[2]) - 1); else go(Number(h[2]) - 1, -1, true) } })
  }

  initChrome()
  fillTemplateSrc()
  initOverview()
  initPano()
  initLens()
  initStates()
  initCode()
  initLinks()
  window.KPAGE = { go: (sid, i) => { setStory(sid, i) }, state: P }
})()
