#!/usr/bin/env node
/* Build docs/linux-kernel-architecture.html from data.js + engine.js + style.css + page.template.html.
 *
 * Every source reference in data.js is symbolic and gets resolved against the local tree
 * src/linux-6.12.112, so line numbers on the page always match the tag:
 *   'kernel/sched/core.c:try_to_wake_up'      function / DEFINE_IDTENTRY / SYSCALL_DEFINE / asm SYM_* label
 *   'include/linux/sched.h:struct task_struct' struct, union or enum body
 *   'kernel/fork.c:#L100-120'                  literal lines (checked to exist)
 *   'kernel/fork.c'                            whole file
 * An unresolved reference stops the build.
 * Usage: node build.mjs            (writes the page and prints a summary)
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { annotate } from './annotations.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const SRC = path.join(ROOT, 'src/linux-6.12.112')
const OUT = path.join(ROOT, 'docs/linux-kernel-architecture.html')
const TAG = 'v6.12.112'
const REPO = `https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/`

const fileCache = new Map()
function lines(file) {
  if (!fileCache.has(file)) {
    const p = path.join(SRC, file)
    if (!fs.existsSync(p)) throw new Error(`no such file: ${file}`)
    fileCache.set(file, fs.readFileSync(p, 'utf8').split('\n'))
  }
  return fileCache.get(file)
}

/* from a line index, find the matching closing brace of the first "{" */
function braceEnd(ls, from) {
  let depth = 0, seen = false
  for (let i = from; i < ls.length; i++) {
    const code = ls[i].replace(/\/\/.*$/, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
    for (const ch of code) {
      if (ch === '{') { depth++; seen = true }
      else if (ch === '}') { depth--; if (seen && depth === 0) return i }
    }
    if (!seen && /;\s*$/.test(code) && i > from) return -1
  }
  return -1
}

function resolveSymbol(file, sym) {
  const ls = lines(file)
  const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (/^(struct|union|enum) /.test(sym)) {
    const re = new RegExp(`^${esc}\\s*(\\{|$)`)
    const i = ls.findIndex((l, k) => re.test(l) && (l.includes('{') || /^\s*\{/.test(ls[k + 1] || '')))
    if (i < 0) return null
    return [i + 1, braceEnd(ls, i) + 1]
  }
  if (file.endsWith('.S')) {
    const re = new RegExp(`^(SYM_[A-Z_]+_START[A-Z_]*\\(${esc}\\b|${esc}:)`)
    const i = ls.findIndex((l) => re.test(l))
    if (i < 0) return null
    const endRe = new RegExp(`^SYM_[A-Z_]+_END\\(${esc}\\)`)
    let j = ls.findIndex((l, k) => k > i && endRe.test(l))
    return [i + 1, j < 0 ? i + 1 : j + 1]
  }
  const macro = new RegExp(`^(DEFINE_IDTENTRY[A-Z_]*|SYSCALL_DEFINE\\d|COMPAT_SYSCALL_DEFINE\\d)\\(${esc}\\b`)
  const plain = new RegExp(`^(?:[A-Za-z_][^;=]*[\\s*])?${esc}\\s*\\(`)
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]
    if (!(macro.test(l) || plain.test(l))) continue
    if (/^\s/.test(l) || /^#/.test(l)) continue
    /* skip prototypes: the first ";" or "{" after the name decides */
    let isDef = false
    for (let k = i; k < Math.min(ls.length, i + 12); k++) {
      const t = ls[k].replace(/\/\*.*?\*\//g, '')
      const a = t.indexOf('{'), b = t.indexOf(';')
      if (a >= 0 && (b < 0 || a < b)) { isDef = true; break }
      if (b >= 0) break
    }
    if (!isDef) continue
    let start = i
    if (new RegExp(`^${esc}\\s*\\(`).test(l) && i > 0 && /^[A-Za-z_]/.test(ls[i - 1]) && !/[;}]\s*$/.test(ls[i - 1])) start = i - 1
    const end = braceEnd(ls, i)
    if (end < 0) continue
    return [start + 1, end + 1]
  }
  return null
}

const resolved = new Map()
const failures = []
function resolveRef(ref) {
  if (resolved.has(ref)) return resolved.get(ref)
  const m = /^([^:]+?)(?::(.+))?$/.exec(ref)
  const file = m[1], what = m[2]
  let out = null
  try {
    const ls = lines(file)
    if (!what) out = { file, a: 0, b: 0 }
    else if (/^#L\d+(-\d+)?$/.test(what)) {
      const [a, b] = what.slice(2).split('-').map(Number)
      if (a > ls.length || (b || a) > ls.length) throw new Error('line out of range')
      out = { file, a, b: b || a }
    } else {
      const r = resolveSymbol(file, what)
      if (r) out = { file, sym: what, a: r[0], b: r[1] }
    }
  } catch (e) { failures.push(`${ref}: ${e.message}`); return null }
  if (!out) failures.push(`${ref}: symbol not found`)
  resolved.set(ref, out)
  return out
}

/* walk the data tree; any string value under a key named src/srcs/at, or any "ref:" string is a source ref */
function collect(node, refs = new Set()) {
  if (Array.isArray(node)) node.forEach((x) => collect(x, refs))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'src' || k === 'srcs' || k === 'at') {
        for (const r of [v].flat(2)) if (typeof r === 'string' && r.includes('/')) refs.add(r)
      } else if (k === 'objs') {
        for (const o of v) if (typeof o[2] === 'string') refs.add(o[2])
      } else collect(v, refs)
    }
  } else if (typeof node === 'string') {
    for (const m of node.matchAll(/\{\{src:([^}|]+)(?:\|[^}]*)?\}\}/g)) refs.add(m[1])
    for (const m of node.matchAll(/data-src="([^"]+)"/g)) refs.add(m[1])
  }
  return refs
}

const DATA_FILES = ['data.js', 'story-boot.js', 'story-cmd.js', 'story-tick.js', 'lessons.js', 'teaching-notes.js']
const ctx = { window: {} }
vm.createContext(ctx)
for (const f of DATA_FILES) vm.runInContext(fs.readFileSync(path.join(HERE, f), 'utf8'), ctx, { filename: f })
const DATA = ctx.window.KDATA
if (!DATA) throw new Error('data.js must set window.KDATA')
DATA.lessons = ctx.window.KLESSONS
for (const [id, lessons] of Object.entries(DATA.lessons)) lessons.forEach((lesson, i) => {
  const notes = ctx.window.KTEACHING_NOTES?.[id]?.[i]
  if (notes?.length !== lesson.pseudo.split("\n").length || notes.some(x => !x.trim())) throw new Error("teaching line annotations mismatch: " + id + ":" + (i + 1))
  lesson.lineNotes = notes
})

const refs = collect(DATA)
collect(fs.readFileSync(path.join(HERE, 'page.template.html'), 'utf8'), refs)
const table = {}
for (const r of refs) {
  const v = resolveRef(r)
  if (v) table[r] = [v.file, v.a, v.b]
}

/* Embed exact local source for call refs, not reconstructed code. */
const snippets = {}
for (const st of DATA.stories) {
  const lessons = DATA.lessons?.[st.id]
  if (lessons?.length !== st.steps.length) failures.push('lesson coverage mismatch: ' + st.id)
  st.steps.forEach((s, i) => {
    const lesson = lessons?.[i]
    if (!lesson?.pseudo || !lesson?.principle || !lesson?.reads?.length) failures.push('missing lesson: ' + st.id + ':' + (i + 1))
    if (!s.calls.some(c => c.f === lesson?.focus && c.src)) failures.push('lesson focus not in calls: ' + st.id + ':' + (i + 1))
    for (const c of s.calls) {
      if (!c.src || snippets[c.src]) continue
      const r = resolved.get(c.src)
      if (!r || !r.a || r.b < r.a) { failures.push('call needs source range: ' + c.src); continue }
      snippets[c.src] = { file: r.file, a: r.a, b: r.b, lines: lines(r.file).slice(r.a - 1, r.b) }
    }
  })
}

const callNotes = {}
for (const st of DATA.stories) for (const step of st.steps) for (const c of step.calls) if (c.src && c.note) callNotes[c.src] = c.note
const catalog = JSON.parse(fs.readFileSync(path.join(HERE, "annotation-catalog.json"), "utf8"))
const { annotations, glossary, stats: annotationStats } = annotate(snippets, catalog, callNotes)
for (const [ref, d] of Object.entries(snippets)) {
  if (annotations[ref]?.length !== d.lines.length || annotations[ref].some(n => !n.text || n.symbols.some(id => !glossary[id]))) failures.push("source line annotations mismatch: " + ref)
}

/* consistency checks between stories and components */
const nodeIds = new Set(DATA.nodes.map((n) => n.id))
for (const st of DATA.stories) {
  st.steps.forEach((s, i) => {
    for (const c of s.calls ?? []) if (!nodeIds.has(c.n)) failures.push(`story ${st.id} step ${i + 1}: unknown node "${c.n}"`)
    if (!s.calls?.length) failures.push(`story ${st.id} step ${i + 1}: no calls`)
    if (s.ctx && !DATA.contexts[s.ctx]) failures.push(`story ${st.id} step ${i + 1}: unknown ctx "${s.ctx}"`)
  })
}
for (const e of DATA.overview.edges) for (const k of [e[0], e[1]]) if (!DATA.overview.nodes.some((n) => n.id === k)) failures.push(`overview edge to unknown "${k}"`)
for (const n of DATA.overview.nodes) if (n.comp && !nodeIds.has(n.comp)) failures.push(`overview node ${n.id}: unknown comp ${n.comp}`)

/* overview geometry: wires must stay orthogonal, start/end on their own boxes, never cross another box;
   labels must not overlap boxes, other labels or other wires; subtitles must fit their box */
{
  const O = DATA.overview, box = new Map(O.nodes.map((n) => [n.id, n]))
  const tw = (s, latin, cjk) => [...s].reduce((w, ch) => w + (/[\u2e80-\uffff]/.test(ch) && !/[→·]/.test(ch) ? cjk : latin), 0)
  const inter = (a, b, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad
  const segBox = ([x1, y1], [x2, y2]) => ({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) })
  const onBorder = ([x, y], n) => (Math.abs(x - n.x) < 0.5 || Math.abs(x - n.x - n.w) < 0.5) ? y >= n.y && y <= n.y + n.h : (Math.abs(y - n.y) < 0.5 || Math.abs(y - n.y - n.h) < 0.5) && x >= n.x && x <= n.x + n.w
  for (const n of O.nodes) if (tw(n.s, 6.6, 11) > n.w - 14) failures.push(`overview ${n.id}: subtitle too wide for box`)
  const labels = [], segs = []
  O.edges.forEach(([f, t, label, , pts, lab], i) => {
    const tag = `overview edge ${f}->${t}`
    if (!pts) return failures.push(`${tag}: missing route`)
    if (!onBorder(pts[0], box.get(f))) failures.push(`${tag}: route does not start on ${f}`)
    if (!onBorder(pts.at(-1), box.get(t))) failures.push(`${tag}: route does not end on ${t}`)
    for (let k = 1; k < pts.length; k++) {
      const [a, b] = [pts[k - 1], pts[k]]
      if (a[0] !== b[0] && a[1] !== b[1]) failures.push(`${tag}: segment ${k} is not orthogonal`)
      const sb = segBox(a, b)
      for (const n of O.nodes) if (inter({ x: sb.x + 0.5, y: sb.y + 0.5, w: Math.max(0, sb.w - 1), h: Math.max(0, sb.h - 1) }, n, -0.01)) {
        const own = n.id === f || n.id === t
        if (!own || (k !== 1 && k !== pts.length - 1)) failures.push(`${tag}: segment ${k} crosses box ${n.id}`)
      }
      segs.push({ i, sb })
    }
    if (label && lab) {
      const w = tw(label, 5.9, 10.5) + 4, [x, y, an = 'm'] = lab
      const L = { i, label, x: an === 's' ? x - 2 : an === 'e' ? x - w + 2 : x - w / 2, y: y - 10, w, h: 13 }
      for (const n of O.nodes) if (inter(L, n, 1)) failures.push(`${tag}: label "${label}" overlaps box ${n.id}`)
      labels.push(L)
    } else if (label) failures.push(`${tag}: label without position`)
  })
  labels.forEach((a, k) => {
    for (const b of labels.slice(k + 1)) if (inter(a, b, 1)) failures.push(`overview labels overlap: "${a.label}" / "${b.label}"`)
    for (const s of segs) if (s.i !== a.i && inter(a, s.sb)) failures.push(`overview label "${a.label}" sits on wire of edge ${O.edges[s.i][0]}->${O.edges[s.i][1]}`)
  })
}

if (failures.length) {
  console.error(`unresolved (${failures.length}):\n  ` + failures.join('\n  '))
  process.exit(1)
}

const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8')
const json = (x) => JSON.stringify(x).replace(/</g, '\\u003c')
let page = read('page.template.html')
const parts = {
  '/*STYLE*/': read('style.css'),
  '/*DATA*/': `window.KSRC=${json({ repo: REPO, tag: TAG, table, snippets, annotations, glossary, annotationStats, localRoot: SRC })};\n` + DATA_FILES.map(read).join('\n;\n') + '\nwindow.KDATA.lessons = window.KLESSONS;\nfor (const [id, ls] of Object.entries(window.KDATA.lessons)) ls.forEach((x,i) => x.lineNotes = window.KTEACHING_NOTES[id][i]);',
  '/*ENGINE*/': read('engine.js'),
}
for (const key of ['/*DATA*/', '/*ENGINE*/']) new vm.Script(parts[key], { filename: key })
for (const [k, v] of Object.entries(parts)) {
  if (page.split(k).length !== 2) throw new Error(`template must contain ${k} exactly once`)
  page = page.replace(k, () => v.replace(/<\/script/gi, '<\\/script'))
}
fs.writeFileSync(OUT, page)
const steps = DATA.stories.reduce((n, s) => n + s.steps.length, 0)
const calls = DATA.stories.reduce((n, s) => n + s.steps.reduce((m, x) => m + x.calls.length, 0), 0)
console.log(`wrote ${path.relative(ROOT, OUT)} (${Buffer.byteLength(page).toLocaleString()} bytes) · ${refs.size} source refs resolved · ${DATA.stories.length} stories · ${steps} steps · ${calls} calls · ${Object.keys(snippets).length} exact source definitions · ${steps} teaching models · ${annotationStats.lines} source line notes · ${annotationStats.asmLines} assembly line notes`)
