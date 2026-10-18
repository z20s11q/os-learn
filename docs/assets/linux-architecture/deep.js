/* Deep-dive view: real source lines (with notes), virtual/physical memory maps, a page-walk
 * calculator and user<->kernel switch steps. Data comes from window.KDEEP (deep-data.js), whose
 * code lines were cut from src/ at build time. Pure rendering; no effect on the timeline player. */
(() => {
  const D = window.KDEEP
  if (!D) return
  const $ = (s, r = document) => r.querySelector(s)
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')
  const hex = (x, w = 16) => '0x' + x.toString(16).padStart(w, '0')
  const parseHex = (s) => { try { return BigInt(String(s).trim()) } catch { return null } }

  const codeBlock = (cut) => {
    if (!cut || !cut.lines?.length) return ''
    const rows = cut.lines.map((l) => `<div class="cl${l.note ? ' hit' : ''}"><span class="ln">${l.n}</span><pre class="cx">${esc(l.text) || ' '}</pre>${l.note ? `<span class="nt">${md(l.note)}</span>` : ''}</div>`).join('')
    return `<div class="codebox"><div class="cfile">${esc(cut.file)}:${cut.from}${cut.to !== cut.from ? '-' + cut.to : ''}</div>${rows}</div>`
  }

  function bootHtml() {
    return `<p class="lead">下面每一段都是 Linux 6.12.112 源码的真实行，构建时按行号从 src/ 截取，左侧是行号，带注释的行会高亮，右侧是作用说明。</p>` +
      D.boot.map((sec, i) => `<section class="sec"><h3><span class="no">${i + 1}</span>${esc(sec.title)}</h3>
        <div class="why"><b>为什么需要这一步</b>${md(sec.why)}</div>
        ${sec.ranges.map(codeBlock).join('')}</section>`).join('')
  }

  function memoryMapHtml() {
    const m = D.memory
    const regions = m.regions.map((r) => `<div class="reg" style="--c:${r.color}"><i></i><div><b>${esc(r.name)}</b><code>${esc(r.range)}</code><span>${esc(r.who)}</span></div></div>`).join('')
    const phys = m.physical.map((p) => `<div class="pr"><b>${esc(p.name)}</b><span>${esc(p.desc)}</span></div>`).join('')
    return `<p class="lead">${esc(m.note)}</p>
      <div class="mm2">
        <div class="mmcol"><h4>虚存（虚拟地址，每个进程看到的）</h4>${regions}</div>
        <div class="mmcol"><h4>实存（物理地址，RAM 上的真实位置）</h4>${phys}
          <h4>地址换算规则</h4><ul class="rules">${m.rules.map((r) => `<li>${md(r)}</li>`).join('')}</ul></div>
      </div>
      <div class="calc"><h4>地址换算演示</h4>
        <div class="row"><label>直接映射：物理地址 pa</label><input id="pa" value="0x1234000"><button id="pa-go">计算</button></div>
        <div class="out" id="pa-out"></div>
        <div class="row"><label>页表遍历：虚拟地址 va</label><input id="va" value="${esc(D.walkSamples[0].va)}"><button id="va-go">拆分</button></div>
        <div class="chips">${D.walkSamples.map((s) => `<button class="smp" data-va="${esc(s.va)}">${esc(s.label)}</button>`).join('')}</div>
        <div class="out" id="va-out"></div>
      </div>`
  }

  function regsHtml() {
    const R = D.regs
    return `<p class="lead">${md(R.intro)}</p>` + R.items.map((it, i) => `<section class="sec"><h3><span class="no">${i + 1}</span>${esc(it.name)}：${esc(it.full)}</h3>
        <div class="why"><b>作用</b>${md(it.role)}</div>
        <table class="walk"><thead><tr><th>位</th><th>名称</th><th>含义</th></tr></thead><tbody>${it.bits.map((b) => `<tr><td>${b[0]}</td><td>${esc(b[1])}</td><td>${md(b[2])}</td></tr>`).join('')}</tbody></table>
        <h4 style="margin:12px 0 4px;font-size:14px">boot 与内核初始化中的设置点</h4>
        ${it.boot.map(codeBlock).join('')}
        <div class="why"><b>在地址翻译、syscall、中断、缺页中的作用</b>${md(it.effect)}</div></section>`).join('')
  }

  function walk(vaStr) {
    const va = parseHex(vaStr)
    if (va === null || va < 0n || va >= 1n << 64n) return `<div class="err">请输入合法的 64 位十六进制地址，例如 0xffffffff81000000</div>`
    const canon = va >> 47n
    if (!(canon === 0n || canon === 0x1ffffn)) return `<div class="err">${hex(va)} 的第 63–47 位需全为 0 或全为 1 才满足规范地址要求；此值访问会产生 #GP。</div>`
    const idx = [
      ['PML4', 47, 39], ['PDPT', 38, 30], ['PD', 29, 21], ['PT', 20, 12],
    ].map(([n, hi, lo]) => ({ n, hi, lo, v: (va >> BigInt(lo)) & 0x1ffn }))
    const off = va & 0xfffn
    const rows = idx.map((x) => `<tr><td>${x.n}</td><td>第 ${x.hi}–${x.lo} 位</td><td>${x.v.toString()}</td><td>${hex(x.v * 8n, 3)}</td></tr>`).join('')
    return `<table class="walk"><thead><tr><th>级</th><th>位段</th><th>索引（十进制）</th><th>表内偏移（×8 字节 PTE）</th></tr></thead><tbody>${rows}
      <tr><td>页内偏移</td><td>第 11–0 位</td><td>${off.toString()}</td><td>${hex(off, 3)}</td></tr></tbody></table>
      <p class="tip">CR3 指向 PML4 的物理地址。CPU 依次用上面 4 个索引读取页表项，得到的物理页基址加上页内偏移 ${hex(off, 3)}，就是最终的物理地址。</p>`
  }

  function directOut(paStr) {
    const pa = parseHex(paStr)
    if (pa === null || pa < 0n) return `<div class="err">请输入合法的物理地址。</div>`
    const base = 0xffff888000000000n
    const kbase = 0xffffffff80000000n
    return `<div>直接映射 va = page_offset_base + pa = <code>${hex(base + pa)}</code>（内核用 kmalloc/alloc_pages 返回的就是这类地址）</div>
      <div>内核镜像映射 va = __START_KERNEL_map + pa = <code>${hex(kbase + pa)}</code>（仅对内核镜像所在物理区间有效）</div>`
  }

  let swIdx = { 0: 0, 1: 0 }
  function switchHtml() {
    return `<p class="lead">选择一个流程，逐步查看 CPU 在特权级、CR3、栈、GS 之间的切换。下方代码是每一步对应的真实源码行。</p>
      <div class="swtabs">${D.switching.map((s, i) => `<button data-sw="${i}" class="${i === 0 ? 'on' : ''}">${esc(s.name)}</button>`).join('')}</div>
      <div id="sw-body"></div>`
  }
  function swRender(i) {
    const sw = D.switching[i]
    const k = swIdx[i] || 0
    const st = sw.steps[k]
    const ring = st.ring === 3 ? '用户态 ring 3' : '内核态 ring 0'
    const cells = [['特权级', ring, st.ring === 3 ? '#4cc597' : '#e07a5a'], ['CR3（页表）', st.cr3, '#5aa7e0'], ['RSP（栈）', st.rsp, '#e3c26b'], ['GS 基址', st.gs, '#c59ae0']]
      .map(([a, b, c]) => `<div class="cell" style="--c:${c}"><small>${esc(a)}</small><b>${esc(b)}</b></div>`).join('')
    const dots = sw.steps.map((_, j) => `<button class="dot${j === k ? ' on' : ''}" data-swstep="${j}">${j + 1}</button>`).join('')
    const code = st.lines ? codeBlock(st.lines) : (st.src ? `<div class="src">${esc(st.src)}</div>` : '<div class="src">按硬件动作展示</div>')
    return `<div class="dots">${dots}</div>
      <div class="cells">${cells}</div>
      <div class="swwhat"><b>第 ${k + 1} / ${sw.steps.length} 步</b>${md(st.what)}</div>
      ${code}
      <div class="swnav"><button data-swprev>‹ 上一步</button><button data-swnext>下一步 ›</button></div>`
  }

  function bind(root) {
    root.addEventListener('click', (e) => {
      const t = e.target
      if (t.id === 'pa-go') $('#pa-out').innerHTML = directOut($('#pa').value)
      if (t.id === 'va-go') $('#va-out').innerHTML = walk($('#va').value)
      if (t.classList.contains('smp')) { $('#va').value = t.dataset.va; $('#va-out').innerHTML = walk(t.dataset.va) }
      if (t.dataset.sw !== undefined) {
        const i = +t.dataset.sw
        root.querySelectorAll('[data-sw]').forEach((b) => b.classList.toggle('on', b === t))
        $('#sw-body').dataset.sw = i
        $('#sw-body').innerHTML = swRender(i)
      }
      const sb = $('#sw-body'), si = +(sb.dataset.sw || 0)
      if (t.dataset.swstep !== undefined) { swIdx[si] = +t.dataset.swstep; sb.innerHTML = swRender(si) }
      if (t.hasAttribute && t.hasAttribute('data-swprev')) { swIdx[si] = Math.max(0, (swIdx[si] || 0) - 1); sb.innerHTML = swRender(si) }
      if (t.hasAttribute && t.hasAttribute('data-swnext')) { swIdx[si] = Math.min(D.switching[si].steps.length - 1, (swIdx[si] || 0) + 1); sb.innerHTML = swRender(si) }
    })
  }

  function build() {
    const root = $('#deep')
    if (!root) return
    root.innerHTML = `<div class="deep-wrap">
      <h2>代码与内存：开机源码、虚实地址、用户态与内核态</h2>
      <div class="tabs">
        <button class="tab on" data-tab="boot">开机源码</button>
        <button class="tab" data-tab="memory">虚存与实存</button>
        <button class="tab" data-tab="switch">用户态 ⇄ 内核态</button>
        <button class="tab" data-tab="regs">控制寄存器与标志位</button>
      </div>
      <div class="pane on" data-pane="boot">${bootHtml()}</div>
      <div class="pane" data-pane="memory">${memoryMapHtml()}</div>
      <div class="pane" data-pane="switch">${switchHtml()}</div>
      <div class="pane" data-pane="regs">${regsHtml()}</div>
    </div>`
    root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b))
      root.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('on', p.dataset.pane === b.dataset.tab))
    }))
    bind(root)
    $('#va-out').innerHTML = walk(D.walkSamples[0].va)
    $('#pa-out').innerHTML = directOut('0x1234000')
    $('#sw-body').dataset.sw = 0
    $('#sw-body').innerHTML = swRender(0)
  }

  const toggle = (on) => {
    document.body.classList.toggle('deep-on', on)
    const btn = $('#b-deep')
    if (btn) btn.textContent = on ? '返回动画' : '代码与内存'
    if (on) window.scrollTo(0, 0)
  }
  build()
  const btn = $('#b-deep')
  if (btn) btn.addEventListener('click', () => toggle(!document.body.classList.contains('deep-on')))
  if (location.hash === '#deep') toggle(true)
  window.__deep = { toggle }
})()
