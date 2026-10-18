#!/usr/bin/env node
/* Build docs/linux-kernel-animation.html: an animated, self-contained player for the three stories.
 * Reuses data.js, story-*.js and lessons.js unchanged. Source line ranges are read from the
 * already-built docs/linux-kernel-architecture.html (window.KSRC.table); without it the player
 * shows file paths only.
 * Usage: node anim.build.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const OUT = path.join(ROOT, 'docs/linux-kernel-animation.html')
const MAIN = path.join(ROOT, 'docs/linux-kernel-architecture.html')
const DATA_FILES = ['data.js', 'story-boot.js', 'story-cmd.js', 'story-tick.js', 'lessons.js', 'machine.js']
const ENGINE_FILES = ['anim-machine.js', 'anim.js', 'deep.js']
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8')

const ctx = { window: {} }
vm.createContext(ctx)
for (const f of DATA_FILES) vm.runInContext(read(f), ctx, { filename: f })
const D = ctx.window.KDATA, LES = ctx.window.KLESSONS, KM = ctx.window.KMACHINE

const failures = []
const nodeIds = new Set(D.nodes.map((n) => n.id))
const PORTS = new Set(['cpu', 'apic', 'ioapic', 'kbd', 'virtio', 'disk', 'vga'])
const PHYS = new Set(['p.mmio', 'p.free', 'p.anon', 'p.pc', 'p.kstk', 'p.slab', 'p.pgt', 'p.vq', 'p.kern', 'p.bz', 'p.vga', 'p.low', 'p.ivt', 'p.ebda', 'p.bios'])
for (const st of D.stories) {
  if (LES?.[st.id]?.length !== st.steps.length) failures.push(`lessons mismatch: ${st.id}`)
  if (!KM.init[st.id]) failures.push(`machine: no init state for ${st.id}`)
  if (KM.ops[st.id]?.length !== st.steps.length) failures.push(`machine: ops mismatch for ${st.id}`)
  st.steps.forEach((s, i) => {
    if (!D.contexts[s.ctx]) failures.push(`${st.id}:${i + 1} unknown ctx ${s.ctx}`)
    if (!s.calls?.length) failures.push(`${st.id}:${i + 1} no calls`)
    for (const c of s.calls) if (!nodeIds.has(c.n)) failures.push(`${st.id}:${i + 1} unknown node ${c.n}`)
    for (const op of KM.ops[st.id]?.[i] || []) {
      if ((op.at ?? 0) >= s.calls.length) failures.push(`machine ${st.id}:${i + 1} at=${op.at} beyond ${s.calls.length} calls`)
      for (const [a, b] of op.x || []) for (const p of [a, b]) if (!PORTS.has(p) && !PHYS.has(p)) failures.push(`machine ${st.id}:${i + 1} unknown port ${p}`)
      for (const id of Object.keys(op.mem || {})) if (!PHYS.has(id)) failures.push(`machine ${st.id}:${i + 1} unknown region ${id}`)
      for (const [, p] of op.va || []) if (!PHYS.has(p)) failures.push(`machine ${st.id}:${i + 1} unknown va target ${p}`)
    }
  })
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}

const refs = new Set(D.stories.flatMap((st) => st.steps.flatMap((s) => s.calls.map((c) => c.src).filter(Boolean))))
const table = {}
if (fs.existsSync(MAIN)) {
  const html = fs.readFileSync(MAIN, 'utf8')
  const a = html.indexOf('window.KSRC=')
  const b = html.indexOf(';\n', a)
  if (a < 0 || b < 0) throw new Error('window.KSRC not found in ' + MAIN)
  const all = JSON.parse(html.slice(a + 'window.KSRC='.length, b)).table
  for (const r of refs) if (all[r]) table[r] = all[r]
} else console.warn('warning: main page not built, line numbers omitted')

const DEEP_FILE = 'deep-data.js'
const SRC_ROOT = path.join(ROOT, 'src/linux-6.12.112')
vm.runInContext(read(DEEP_FILE), ctx, { filename: DEEP_FILE })
const srcCache = new Map()
const deepFailures = []
const srcLines = (file) => {
  if (!srcCache.has(file)) {
    const p = path.join(SRC_ROOT, file)
    if (!fs.existsSync(p)) deepFailures.push(`deep: source not found ${file}`)
    srcCache.set(file, fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n') : [])
  }
  return srcCache.get(file)
}
const cut = (r) => {
  const L = srcLines(r.file)
  if (!(r.from >= 1 && r.to >= r.from && r.to <= L.length)) deepFailures.push(`deep: bad range ${r.file}:${r.from}-${r.to}`)
  for (const k of Object.keys(r.notes || {})) if (+k < r.from || +k > r.to) deepFailures.push(`deep: note ${k} outside ${r.file}:${r.from}-${r.to}`)
  const lines = []
  for (let n = r.from; n <= r.to; n++) lines.push({ n, text: (L[n - 1] ?? '').replace(/\t/g, '        ').replace(/\s+$/, ''), note: r.notes?.[n] || '' })
  return { file: r.file, from: r.from, to: r.to, lines }
}
const deepOut = JSON.parse(JSON.stringify(ctx.window.KDEEP))
for (const sec of deepOut.boot) sec.ranges = sec.ranges.map(cut)
deepOut.memory.ranges = deepOut.memory.ranges.map(cut)
for (const sw of deepOut.switching) for (const st of sw.steps) if (st.lines) st.lines = cut(st.lines)
for (const it of deepOut.regs.items) it.boot = it.boot.map(cut)
if (deepFailures.length) {
  console.error(deepFailures.join('\n'))
  process.exit(1)
}

const json = (x) => JSON.stringify(x).replace(/</g, '\\u003c')
const parts = {
  '/*STYLE*/': read('anim.css'),
  '/*DATA*/': `window.KANIM_REF=${json(table)};\nwindow.KDEEP=${json(deepOut)};\n` + DATA_FILES.map(read).join('\n;\n'),
  '/*ENGINE*/': ENGINE_FILES.map(read).join('\n;\n'),
}
for (const key of ['/*DATA*/', '/*ENGINE*/']) new vm.Script(parts[key], { filename: key })
let page = read('anim.template.html')
for (const [k, v] of Object.entries(parts)) {
  if (page.split(k).length !== 2) throw new Error(`template must contain ${k} exactly once`)
  page = page.replace(k, () => v.replace(/<\/script/gi, '<\\/script'))
}
fs.writeFileSync(OUT, page)
const steps = D.stories.reduce((n, s) => n + s.steps.length, 0)
const calls = D.stories.reduce((n, s) => n + s.steps.reduce((m, x) => m + x.calls.length, 0), 0)
console.log(`wrote ${path.relative(ROOT, OUT)} (${Buffer.byteLength(page).toLocaleString()} bytes) · ${D.stories.length} stories · ${steps} steps · ${calls} calls · ${Object.keys(table).length}/${refs.size} line ranges`)
