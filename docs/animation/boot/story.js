import { ACTS } from './story-data.js';
import { CODE } from './story-code.js';
import { TIMING } from './story-timing.js';
import { annotateHtml } from '../panorama-glossary.js';

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gloss = s => annotateHtml(s, esc);
const norm = s => String(s).replace(/\s+/g, ' ').trim();
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = x => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - (1 - x) ** 3);
const params = new URLSearchParams(location.search);
const VIDEO = params.has('video');
if (VIDEO) document.body.classList.add('video');

/* ---------- timeline ---------- */
const OPS = [];
ACTS.forEach((act, ai) => act.ops.forEach((op, oi) => OPS.push({ ...op, act: ai, inAct: oi })));
const LEAD = 0.5;
OPS.forEach((op, i) => {
  const t = TIMING?.[i];
  op.audio = t?.file ? `boot/audio/${t.file}` : null;
  const est = Math.max(3.4, (op.tts || op.say).length * 0.21 + 1.1);
  op.dur = t ? Math.max(t.audio + 0.95, 2.8) : est;
  if (op.flow?.length > 1) op.dur = Math.max(op.dur, 2.2 + op.flow.length * 0.9);
  if (op.grow) op.dur = Math.max(op.dur, 1.6 + op.grow * 1.6);
});
let acc = LEAD;
for (const op of OPS) { op.start = acc; acc += op.dur; }
const TOTAL = acc + 1.2;
const actStart = ACTS.map((_, ai) => OPS.find(o => o.act === ai).start);

/* ---------- state ---------- */
const REGS = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp'];
const MB = 0x100000;
const ACT_VIEW = { primer: [0, 0x40000], kpt: 64 * MB, sched: 64 * MB, intro: 0x100000000, reset: 0x100000000, bios: MB, grub: MB, setup: MB, pm: MB, paging: 64 * MB, decomp: 64 * MB, khead: 64 * MB, startk: 512 * MB, init: 64 * MB, root: 64 * MB, shell: 64 * MB, key: 64 * MB };
const INIT = { view: 0x100000000, viewAct: -1, bytes: {}, mode: 'off', cpl: 0, regs: {}, rip: null, seg: {}, ctl: {}, if: null, mem: {}, memOrder: 0, vm: {}, paging: false, screen: { title: '显示器', lines: [] }, focus: null, code: null, insn: null };
function reduce(prev, op) {
  const s = op.reset ? { ...structuredClone(INIT), screen: structuredClone(prev.screen), view: prev.view, viewAct: prev.viewAct } : structuredClone(prev);
  if (op.reset) s.screen = { title: '显示器', lines: [] };
  for (const [at, hexs] of op.poke || []) hexs.split(/\s+/).forEach((b, i) => { s.bytes[at + i] = parseInt(b, 16); });
  if (op.mode) s.mode = op.mode;
  if (op.cpl != null) s.cpl = op.cpl;
  for (const [k, v] of Object.entries(op.set || {})) {
    if (k === 'rip') s.rip = v; else if (k === 'if') s.if = v; else if (REGS.includes(k)) s.regs[k] = v; else s.ctl[k] = v;
  }
  for (const [k, [sel, base]] of Object.entries(op.seg || {})) s.seg[k] = { sel, base };
  for (const id of op.memOff || []) { if (id === 'kernel') delete s.mem[id]; else if (s.mem[id]) s.mem[id].freed = true; }
  for (const r of op.mem || []) {
    for (const o of Object.values(s.mem)) {
      if (o.base || o.id === r.id || r.base || o.end <= r.start || r.end <= o.start) continue;
      const left = o.start < r.start ? { ...o, end: r.start } : null;
      const right = o.end > r.end ? { ...o, start: r.end } : null;
      delete s.mem[o.id];
      if (left) s.mem[o.id] = left;
      if (right) s.mem[left ? `${o.id}#2` : o.id] = { ...right, id: left ? `${o.id}#2` : o.id };
      for (const piece of [left, right]) if (piece && o.kind !== 'free' && !/剩余/.test(piece.label)) piece.label += '（剩余部分）';
    }
    s.mem[r.id] = { ...r, freed: false, order: s.mem[r.id]?.order ?? ++s.memOrder };
  }
  s.view = op.view ?? (op.act !== s.viewAct ? ACT_VIEW[ACTS[op.act].id] : s.view);
  s.viewAct = op.act;
  if (op.paging) s.paging = true;
  for (const id of op.vmOff || []) delete s.vm[id];
  for (const m of op.vm || []) s.vm[m.id] = m;
  if (op.screen) {
    if (op.screen.title) s.screen.title = op.screen.title;
    if (op.screen.set) s.screen.lines = [...op.screen.set];
    if (op.screen.add) s.screen.lines.push(...op.screen.add);
    if (op.screen.type) s.screen.lines[s.screen.lines.length - 1] += op.screen.type;
  }
  if (op.focus) s.focus = op.focus;
  else if (s.focus && s.focus.act !== op.act && !s.focus.title.startsWith('进程')) s.focus = null;
  if (op.focus) s.focus.act = op.act;
  if (op.code) s.code = { id: op.code, line: op.line };
  if (op.insn) s.insn = { text: op.insn, mean: op.mean || '' };
  else if (op.code && op.line) s.insn = { text: norm(op.line), mean: op.mean || '' };
  return s;
}
const STATES = [];
OPS.reduce((s, op) => { const n = reduce(s, op); STATES.push(n); return n; }, INIT);
const before = i => (i > 0 ? STATES[i - 1] : INIT);

/* ---------- numbers ---------- */
const big = v => (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? BigInt(v) : typeof v === 'bigint' ? v : typeof v === 'number' && Number.isFinite(v) ? BigInt(Math.trunc(v)) : null);
const hex = v => { const b = big(v); return b == null ? (v ?? '—') : '0x' + b.toString(16).toUpperCase(); };
const inRegion = v => (typeof v === 'string' && v.startsWith('in:') ? v.slice(3) : null);
function translate(s, addr) {
  const a = big(addr);
  if (a == null) return null;
  if (!s.paging) return a;
  for (const m of Object.values(s.vm)) {
    if (a >= m.v0 && a < m.v1) return m.kind === 'user' ? null : BigInt(m.p0) + (a - m.v0);
  }
  return null;
}
function physPc(s) {
  if (s.mode === 'off' || s.rip == null) return null;
  const rid = inRegion(s.rip);
  if (rid) { const r = s.mem[rid]; return r ? BigInt(Math.floor((r.start + r.end) / 2)) : null; }
  if (s.mode === 'real' || s.mode === 'prot16') { const b = big(s.seg.cs?.base); const r = big(s.rip); return b != null && r != null ? b + r : null; }
  return translate(s, s.rip);
}
function physSp(s) {
  const sp = big(s.regs.rsp);
  if (sp == null || s.mode === 'off') return null;
  if (s.mode === 'real' || s.mode === 'prot16') { const b = big(s.seg.ss?.base); return b != null ? b + sp : null; }
  return translate(s, sp);
}

/* ---------- static DOM ---------- */
const REG_ZH = { rax: '累加器', rbx: '基址', rcx: '计数', rdx: '数据', rsi: '源地址', rdi: '目的地址', rbp: '栈帧', rsp: '栈顶指针' };
const SEG_ZH = { cs: '代码段', ds: '数据段', ss: '栈段', es: '附加段' };
const CTL = [
  { id: 'cr0', zh: '模式开关', bits: [['PE', 0, '保护'], ['PG', 31, '分页'], ['CD', 30, '禁缓存']] },
  { id: 'cr3', zh: '页表在哪', bits: [] },
  { id: 'cr4', zh: '扩展功能', bits: [['PAE', 5, '64位分页前提']] },
  { id: 'efer', zh: '64 位开关', bits: [['LME', 8, '允许'], ['LMA', 10, '生效'], ['SCE', 0, '系统调用'], ['NXE', 11, '禁执行']] },
  { id: 'gdtr', zh: '段表 GDT 在哪', bits: [] },
  { id: 'idtr', zh: '中断表 IDT 在哪', bits: [] },
];
const UNITS = [['agu', '地址计算', 'AGU'], ['alu', '运算器', 'ALU'], ['mmu', '地址翻译', 'MMU'], ['irq', '中断', 'INT'], ['idle', '休眠', 'HLT']];
$('regs').innerHTML = REGS.map(r => `<div class="reg" data-anchor="reg.${r}" id="r-${r}"><div class="nm"><b></b><small></small></div><div class="v"></div></div>`).join('');
$('segs').innerHTML = Object.keys(SEG_ZH).map(r => `<div class="seg" data-anchor="seg.${r}" id="s-${r}"><div class="nm"><b>${r.toUpperCase()}</b><small>${SEG_ZH[r]}</small></div><div class="v"></div></div>`).join('');
$('ctls').innerHTML = CTL.map(c => `<div class="ctl" data-anchor="ctl.${c.id}" id="c-${c.id}"><div class="nm"><b>${c.id.toUpperCase()}</b><small>${c.zh}</small></div><div class="v"></div><div class="bits"></div></div>`).join('');
$('units').innerHTML = UNITS.map(([id, zh, en]) => `<div class="unit ${id}" data-anchor="${id}" id="u-${id}">${zh}<small>${en}</small></div>`).join('');
$('acts').innerHTML = ACTS.map((a, i) => `<li data-act="${i}"><small>${String(i).padStart(2, '0')}</small>${esc(a.title)}</li>`).join('');
$('ifPill').dataset.anchor = 'ctl.if';
$('modePill').dataset.anchor = 'mode';

const stage = $('stage');
function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;
}
addEventListener('resize', fit);
fit();

function anchorEl(name) {
  if (name === 'cpu') return document.querySelector('.panel.cpu');
  if (name === 'reg.rip') return document.querySelector('#fetch .term.ip') || $('fetch');
  return document.querySelector(`[data-anchor="${CSS.escape(name)}"]`);
}
function center(el) {
  let x = 0, y = 0, e = el;
  while (e && e !== stage) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
  return { x: x + el.offsetWidth / 2, y: y + el.offsetHeight / 2, l: x, r: x + el.offsetWidth, t: y, b: y + el.offsetHeight };
}

/* ---------- memory geometry ---------- */
const MEM = { x: 728, y: 120, top: 34, bottom: 760, vx0: 120, vx1: 176, px0: 276, px1: 346 };
let VLO = 0, VIEW = 0x100000000;
const span = v => (Array.isArray(v) ? v : [0, v]);
const py = a => { const f = (Number(a) - VLO) / (VIEW - VLO); return MEM.bottom - Math.max(-0.02, Math.min(f, 1.02)) * (MEM.bottom - MEM.top); };
function zoomWindow(a, b, p) {
  const [l0, h0] = span(a), [l1, h1] = span(b);
  if (p >= 1 || (l0 === l1 && h0 === h1)) return [l1, h1];
  const s0 = h0 - l0, s1 = h1 - l1, c0 = l0 + s0 / 2, c1 = l1 + s1 / 2;
  const bump = Math.log(Math.max(1, (Math.abs(c1 - c0) * 2.2) / Math.max(s0, s1)));
  const sz = Math.exp(Math.log(s0) + (Math.log(s1) - Math.log(s0)) * p + bump * Math.sin(Math.PI * p));
  const c = c0 + (c1 - c0) * p;
  const lo = Math.max(0, c - sz / 2);
  return [lo, lo + sz];
}
function fmtSize(n) {
  const u = [[2 ** 30, 'GB'], [2 ** 20, 'MB'], [2 ** 10, 'KB']];
  for (const [d, name] of u) if (n >= d) { const v = n / d; return `${Number.isInteger(v) ? v : v.toFixed(v < 10 ? 2 : 1).replace(/\.?0+$/, '')} ${name}`; }
  return `${n} B`;
}
const VB = [[0n, 0], [0x400000n, 0.05], [0x6a0000n, 0.12], [0x100000000n, 0.3], [0x7ffffffde000n, 0.33], [0x7ffffffff000n, 0.39], [0x800000000000n, 0.41], [0xffff800000000000n, 0.47],
  [0xffff888000000000n, 0.5], [0xffff888020000000n, 0.66], [0xffffffff80000000n, 0.75], [0xffffffff81000000n, 0.79], [0xffffffff82426000n, 0.9], [0x10000000000000000n, 1]];
function vfrac(a) {
  for (let i = 1; i < VB.length; i++) if (a <= VB[i][0]) { const [a0, f0] = VB[i - 1], [a1, f1] = VB[i]; return f0 + (f1 - f0) * Number(a - a0) / Number(a1 - a0); }
  return 1;
}
const vy = a => MEM.bottom - vfrac(a) * (MEM.bottom - MEM.top);
const KC = k => `var(--k-${k})`;
const memAnchor = (id, s, side) => {
  const r = s.mem[id];
  if (!r) return null;
  const y = (py(r.start) + py(r.end)) / 2;
  return { x: MEM.x + (side === 'right' ? MEM.px1 : MEM.px0), y: MEM.y + y };
};

/* ---------- per-frame render ---------- */
let codeId = null;
let lastCaptionOp = -1;

function locate(t) {
  let lo = 0, hi = OPS.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (OPS[mid].start <= t) lo = mid; else hi = mid - 1; }
  const op = OPS[lo];
  return { k: lo, op, local: Math.max(0, t - op.start) };
}
const FLOW = { t0: 0.35, gap: 0.85, dur: 1.3 };
function timingOf(op) {
  const n = op.flow?.length || 0;
  const commit = n ? FLOW.t0 + (n - 1) * FLOW.gap + FLOW.dur : 0.55;
  return { commit, glow: l => (l < commit ? 0 : 0.3 + 0.7 * Math.max(0, 1 - (l - commit) / 2.4)) };
}

function render(t) {
  const { k, op, local } = locate(t);
  const prev = before(k), cur = STATES[k];
  const tm = timingOf(op);
  const committed = local >= tm.commit;
  const S = committed ? cur : { ...cur, mode: prev.mode, cpl: prev.cpl, regs: prev.regs, rip: prev.rip, seg: prev.seg, ctl: prev.ctl, if: prev.if, paging: prev.paging, vm: prev.vm };
  const g = tm.glow(local);
  const hits = new Set(op.hit || []);
  for (const [i, f] of (op.flow || []).entries()) if (local > FLOW.t0 + i * FLOW.gap + FLOW.dur - 0.05) hits.add(f.to);

  renderTop(op, k, t);
  renderCpu(S, prev, cur, op, committed, g, hits, local);
  renderMemory(S, prev, cur, op, local, hits, g);
  renderCode(cur, prev, op, local);
  renderFocus(cur, prev, op, local);
  renderScreen(cur, prev, op, local);
  renderSpot(op);
  renderFlows(op, local, S);
}

function renderTop(op, k, t) {
  for (const li of $('acts').children) {
    const i = Number(li.dataset.act);
    li.className = i < op.act ? 'past' : i === op.act ? 'current' : '';
  }
  $('actChip').textContent = `第 ${op.act} 章 · ${ACTS[op.act].title}`;
  $('stepChip').textContent = `第 ${op.inAct + 1} / ${ACTS[op.act].ops.length} 步`;
  if (lastCaptionOp !== k) { $('caption').innerHTML = gloss(op.say); lastCaptionOp = k; }
  $('caption').style.opacity = String(clamp((t - op.start) / 0.25, 0.15, 1));
  $('progressBar').style.width = `${(t / TOTAL) * 100}%`;
  if (!VIDEO) $('seek').value = String(Math.round((t / TOTAL) * 1000));
}

function setGlow(el, on, g, cls = 'hit') {
  el.classList.toggle(cls, on);
  if (on) el.style.setProperty('--g', g.toFixed(3)); else el.style.removeProperty('--g');
}

function renderCpu(S, prev, cur, op, committed, g, hits, local) {
  const modeText = { off: '未通电', real: '实模式 · 16 位', prot16: '保护模式（过渡中）', prot: '保护模式 · 32 位', compat: '兼容模式 · 32 位', long: '长模式 · 64 位' }[S.mode];
  const modeCls = { off: '', real: 'real', prot16: 'prot', prot: 'prot', compat: 'prot', long: 'long' }[S.mode];
  $('modePill').className = `pill mode ${modeCls}`;
  $('modePill').textContent = modeText;
  setGlow($('modePill'), (committed && prev.mode !== cur.mode) || hits.has('mode') && committed, g, 'changed');
  const ring = S.mode === 'off' ? '—' : S.cpl === 3 ? '用户态 · Ring 3' : '内核态 · Ring 0';
  $('ringPill').className = `pill ring ${S.mode === 'off' ? '' : S.cpl === 3 ? 'user' : 'kernel'}`;
  $('ringPill').textContent = ring;
  setGlow($('ringPill'), committed && prev.cpl !== cur.cpl, g, 'changed');
  $('ifPill').className = `pill lamp ${S.if ? 'on' : ''}`;
  $('ifPill').innerHTML = `<i></i>中断${S.if == null ? '' : S.if ? '：开' : '：关'}`;
  setGlow($('ifPill'), (committed && prev.if !== cur.if) || hits.has('ctl.if'), g, prev.if !== cur.if ? 'changed' : 'hit');

  const wide = S.mode === 'long';
  const ipName = { off: 'IP', real: 'IP', prot16: 'IP', prot: 'EIP', compat: 'EIP', long: 'RIP' }[S.mode];
  const term = (label, value, cls = '') => `<div class="term ${cls}"><small>${label}</small><b>${value}</b></div>`;
  const opx = s => `<span class="op">${s}</span>`;
  let f;
  if (S.mode === 'off' || S.rip == null) f = '<span class="op" style="font-size:18px">CPU 还没有通电，什么都不执行</span>';
  else if (inRegion(S.rip)) { const r = S.mem[inRegion(S.rip)]; f = term(ipName + ' 指令指针', '变化中', 'ip') + opx('=') + term('物理地址', `${hex(r?.start)} – ${hex(r?.end - 1)} 之间`, 'out') + `<span class="op" style="font-size:15px">${esc(r?.label || '')}</span>`; }
  else if (S.mode === 'real' || S.mode === 'prot16') f = term('CS 段起点', hex(S.seg.cs?.base)) + opx('+') + term(ipName + ' 指令指针', hex(S.rip), 'ip') + opx('=') + term('物理地址', hex(physPc(S)), 'out');
  else if (!S.paging) f = term(ipName + ' 指令指针', hex(S.rip), 'ip') + opx('+') + term('段起点', '0x0') + opx('=') + term('物理地址', hex(physPc(S)), 'out');
  else { const p = physPc(S); f = term(ipName + '（虚拟地址）', hex(S.rip), 'ip') + opx('→') + term('MMU 查页表', '翻译', 'mmu') + opx('→') + term('物理地址', p == null ? '进程的某一页' : hex(p), 'out'); }
  $('fetch').innerHTML = f;
  const ripChanged = committed && prev.rip !== cur.rip;
  setGlow(document.querySelector('.box.fetch'), ripChanged || hits.has('fetch') || hits.has('reg.rip'), g, ripChanged ? 'changed' : 'hit');

  const arrive = op.flow?.some(f => f.to === 'insn') ? FLOW.t0 + FLOW.dur : 0;
  const insn = cur.insn && (op.insn || op.code) && local >= arrive ? cur.insn : null;
  $('insn').textContent = insn ? insn.text : '—';
  $('insnMean').textContent = insn ? insn.mean : '';
  setGlow(document.querySelector('.box.insn'), !!insn && local - arrive < 2.2, Math.max(0.25, 1 - (local - arrive) / 2.2), 'hit');

  for (const r of REGS) {
    const el = $(`r-${r}`);
    const small = S.mode === 'real' && (big(S.regs[r]) ?? 0n) <= 0xffffn;
    const name = S.mode === 'off' ? r.toUpperCase() : wide ? r.toUpperCase() : small ? r.slice(1).toUpperCase() : 'E' + r.slice(1).toUpperCase();
    const v = S.regs[r];
    const changed = committed && prev.regs[r] !== cur.regs[r];
    el.querySelector('b').textContent = name;
    el.querySelector('small').textContent = changed && prev.regs[r] != null && g > 0.32 ? `原 ${hex(prev.regs[r])}` : REG_ZH[r];
    const ve = el.querySelector('.v');
    const text = v == null ? '—' : hex(v);
    ve.textContent = text;
    ve.className = `v ${v == null ? 'none' : ''} ${text.length > 12 ? 'long' : ''}`;
    el.classList.remove('hit', 'changed');
    if (changed) setGlow(el, true, g, 'changed'); else setGlow(el, hits.has(`reg.${r}`), g || 0.8, 'hit');
  }
  for (const r of Object.keys(SEG_ZH)) {
    const el = $(`s-${r}`);
    const sg = S.seg[r];
    const changed = committed && JSON.stringify(prev.seg[r]) !== JSON.stringify(cur.seg[r]);
    el.querySelector('.v').innerHTML = sg ? `${hex(sg.sel)}<small>起点 ${hex(sg.base)}</small>` : '<span class="none">—</span>';
    el.classList.remove('hit', 'changed');
    if (changed) setGlow(el, true, g, 'changed'); else setGlow(el, hits.has(`seg.${r}`), g || 0.8, 'hit');
  }
  for (const c of CTL) {
    const el = $(`c-${c.id}`);
    const v = S.ctl[c.id];
    const changed = committed && prev.ctl[c.id] !== cur.ctl[c.id];
    const text = v == null ? '—' : hex(v);
    const ve = el.querySelector('.v');
    ve.textContent = text;
    ve.className = `v ${v == null ? 'none' : ''} ${text.length > 12 ? 'long' : ''}`;
    const b = big(v) ?? 0n;
    el.querySelector('.bits').innerHTML = c.bits.map(([n, bit, zh]) => `<span class="bit ${(b >> BigInt(bit)) & 1n ? 'on' : ''}">${n}<small>${zh}</small></span>`).join('');
    el.classList.remove('hit', 'changed');
    if (changed) setGlow(el, true, g, 'changed'); else setGlow(el, hits.has(`ctl.${c.id}`), g || 0.8, 'hit');
  }
  for (const [id] of UNITS) {
    const el = $(`u-${id}`);
    const active = op.unit === id && local > 0.2;
    el.classList.toggle('active', active);
    el.classList.toggle('on', id === 'mmu' && S.paging);
    if (hits.has(id)) el.classList.add('active');
  }
  for (const box of ['regs', 'ctl']) setGlow(document.querySelector(`[data-spot="${box}"]`), hits.has(box), 0.8, 'hit');
}

function renderMemory(S, prev, cur, op, local, hits, g) {
  const out = [];
  const W = 588;
  out.push('<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#1a2533"/><line x1="0" y1="0" x2="0" y2="7" stroke="#3a4b5e" stroke-width="3"/></pattern>'
    + '<pattern id="hole" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="10" height="10" fill="#0a0f15"/><line x1="0" y1="0" x2="0" y2="10" stroke="#18222e" stroke-width="4"/></pattern><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>');
  out.push(`<text x="${(MEM.vx0 + MEM.vx1) / 2}" y="20" text-anchor="middle" font-size="15" fill="#c9d6e3">虚拟地址</text>`);
  out.push(`<text x="${(MEM.px0 + MEM.px1) / 2}" y="20" text-anchor="middle" font-size="15" fill="#c9d6e3">物理地址</text>`);

  // zoom window: true linear scale 0 .. VIEW
  [VLO, VIEW] = zoomWindow(prev.view ?? cur.view, cur.view, ease((local - 0.1) / 1.2));
  const SPAN = VIEW - VLO;
  const RAM = 512 * MB;
  const ramTop = py(Math.min(RAM, VIEW));
  out.push(`<rect x="${MEM.px0}" y="${MEM.top}" width="${MEM.px1 - MEM.px0}" height="${MEM.bottom - MEM.top}" fill="#0b1219" stroke="#2c3e54"/>`);
  if (VIEW > RAM) {
    out.push(`<rect x="${MEM.px0 + 1}" y="${py(Math.min(VIEW, 0xfffc0000))}" width="${MEM.px1 - MEM.px0 - 2}" height="${ramTop - py(Math.min(VIEW, 0xfffc0000))}" fill="url(#hole)"/>`);
    out.push(`<text x="${(MEM.px0 + MEM.px1) / 2}" y="${(ramTop + py(Math.min(VIEW, 0xfffc0000))) / 2}" font-size="13" fill="#6f849a" text-anchor="middle" writing-mode="tb" letter-spacing="2">没有内存条（地址空洞）</text>`);
  }
  let step = 1;
  while (SPAN / step > 8) step *= 2;
  const hexTicks = VLO > 0 || SPAN <= 0x10000;
  for (let a = Math.ceil(VLO / step) * step; a <= VIEW * 1.0001; a += step) {
    const y = py(a);
    out.push(`<line x1="${MEM.px0 - 7}" y1="${y}" x2="${MEM.px1}" y2="${y}" stroke="#3a5068" stroke-width="1" opacity=".55"/>`);
    out.push(`<text x="${MEM.px0 - 10}" y="${y + 4}" font-size="11.5" class="mono" text-anchor="end" fill="#8ea2b8">${a === 0 ? '0' : hexTicks ? hex(a) : fmtSize(a)}</text>`);
  }
  if (VLO > 0) out.push(`<text x="${MEM.px1 + 2}" y="${MEM.bottom + 12}" font-size="11" fill="#8ea2b8">↓ 图外更低处还有内存</text>`);
  out.push(`<text x="${MEM.px0 - 10}" y="${MEM.bottom + 10}" font-size="10.5" text-anchor="end" fill="#5f7590">刻度 = 真实长度</text>`);
  const above = Object.values(cur.mem).filter(r => !r.base && r.start >= VIEW).sort((a, b) => a.start - b.start);
  if (above.length) out.push(`<text x="${W - 8}" y="20" text-anchor="end" font-size="12.5" fill="#ffd166">↑ 图外更高处：${esc(above[0].label.replace(/（.*$/, ''))}${above.length > 1 ? ` 等 ${above.length} 块` : ''}</text>`);
  else out.push(`<text x="${W - 8}" y="20" text-anchor="end" font-size="12.5" fill="#6f849a">↑ 地址越来越大</text>`);

  // regions
  const regions = Object.values(cur.mem).sort((a, b) => (a.base ? -1 : b.base ? 1 : a.order - b.order));
  const added = new Set((op.mem || []).map(r => r.id));
  const labels = [];
  for (const r of regions) {
    const isNew = added.has(r.id) && !prev.mem[r.id];
    const relabel = added.has(r.id) && prev.mem[r.id];
    const growDur = 0.9 * (op.grow || 0.8);
    const gr = isNew ? ease((local - 0.25) / growDur) : 1;
    if (gr <= 0) continue;
    if (r.start >= VIEW || r.end <= VLO) continue;
    const y1 = py(Math.max(r.start, VLO)), y0 = py(Math.min(r.end, VIEW));
    const yTop = y1 - (y1 - y0) * gr;
    const h = Math.max(r.base ? 0 : 2, y1 - yTop);
    const freed = r.freed && (prev.mem[r.id]?.freed || local > timingOf(op).commit);
    const hit = hits.has(`mem.${r.id}`) || (isNew && local < 2.4) || relabel && local < 2;
    const fill = r.base ? KC('blank') : freed ? 'url(#hatch)' : KC(r.kind);
    if (r.base) {
      out.push(`<rect x="${MEM.px0 + 1}" y="${yTop}" width="${MEM.px1 - MEM.px0 - 2}" height="${y1 - yTop}" style="fill:${fill}"/>`);
      if (VIEW > RAM * 1.2) labels.push({ y: ramTop + 10, name: r.label, addr: '0x0 起 · 512 MB', color: '#8ea2b8', x: MEM.px1 });
      continue;
    }
    out.push(`<rect x="${MEM.px0 + 1}" y="${yTop}" width="${MEM.px1 - MEM.px0 - 2}" height="${h}" style="fill:${fill}" opacity="${freed ? 0.9 : 0.95}" stroke="${hit ? '#7fe0ff' : '#05090d'}" stroke-width="${hit ? 2.5 : 1}" ${hit ? 'filter="url(#glow)"' : ''}/>`);
    if (h >= 6) out.push(`<line x1="${MEM.px0 + 1}" y1="${yTop}" x2="${MEM.px1 - 1}" y2="${yTop}" stroke="#ffffff" stroke-opacity=".35"/>`);
    if (gr > 0.3) labels.push({ y: (y1 + yTop) / 2, name: r.label + (freed ? ' · 已释放' : ''), addr: `${hex(r.start)} · ${fmtSize(r.end - r.start)}`, color: freed ? '#5f7388' : KC(r.kind), hit, freed, x: MEM.px1 - 1 });
  }
  if (SPAN <= 64) {
    const ch = (MEM.bottom - MEM.top) / SPAN;
    const [hl0, hlLen] = op.hl || [-1, 0];
    for (let a = Math.floor(VLO); a < VIEW; a++) {
      const yb = py(a), yt = py(a + 1);
      if (yt > MEM.bottom || yb < MEM.top) continue;
      const on = a >= hl0 && a < hl0 + hlLen;
      if (on) out.push(`<rect x="${MEM.px0 + 2}" y="${yt + 1}" width="${MEM.px1 - MEM.px0 - 4}" height="${ch - 2}" fill="#ffd166" opacity=".9" rx="2"/>`);
      out.push(`<line x1="${MEM.px0}" y1="${yb}" x2="${MEM.px1}" y2="${yb}" stroke="#05090d" stroke-width="1"/>`);
      const b = cur.bytes[a];
      if (ch >= 13 && b != null) out.push(`<text x="${(MEM.px0 + MEM.px1) / 2}" y="${(yb + yt) / 2 + 5}" font-size="${Math.min(15, ch * 0.62)}" class="mono" text-anchor="middle" fill="${on ? '#1a1205' : '#f3f7fb'}" font-weight="700">${b.toString(16).toUpperCase().padStart(2, '0')}</text>`);
    }
  }
  placeLabels(labels, MEM.top, MEM.bottom, 30);
  for (const l of labels) {
    const lx = MEM.px1 + 14;
    out.push(`<path d="M${l.x} ${l.y0} L${lx - 3} ${l.y}" stroke="${l.hit ? '#7fe0ff' : '#3a4d63'}" fill="none"/>`);
    out.push(`<text x="${lx}" y="${l.y - 1}" font-size="14" fill="${l.hit ? '#ffffff' : l.freed ? '#6d8196' : '#d6e2ee'}" font-weight="${l.hit ? 700 : 500}">${esc(l.name)}</text>`);
    out.push(`<text x="${lx}" y="${l.y + 13}" font-size="11" class="mono" fill="${l.freed ? '#4d6075' : '#7f95ab'}">${esc(l.addr)}</text>`);
    out.push(`<rect x="${lx - 9}" y="${l.y - 6}" width="5" height="12" rx="1" style="fill:${l.color}"/>`);
  }

  // virtual side
  const maps = Object.values(S.paging ? S.vm : {});
  if (!S.paging) {
    out.push(`<rect x="${MEM.vx0}" y="${MEM.top}" width="${MEM.vx1 - MEM.vx0}" height="${MEM.bottom - MEM.top}" fill="none" stroke="#2a3b4e" stroke-dasharray="5 5" rx="4"/>`);
    out.push(`<text x="${(MEM.vx0 + MEM.vx1) / 2}" y="${(MEM.top + MEM.bottom) / 2}" font-size="15" fill="#5f7590" text-anchor="middle" writing-mode="tb" letter-spacing="3">还没开启分页：CPU 用的地址就是物理地址</text>`);
  } else {
    out.push(`<rect x="${MEM.vx0}" y="${MEM.top}" width="${MEM.vx1 - MEM.vx0}" height="${MEM.bottom - MEM.top}" fill="#0f1822" stroke="#2c3e54" rx="3"/>`);
    const newMaps = new Set((op.vm || []).map(m => m.id));
    const vlabels = [];
    for (const m of maps) {
      const isNew = newMaps.has(m.id) && !prev.vm[m.id];
      const gr = isNew ? ease((local - tm0(op)) / 1.1) : 1;
      if (gr <= 0) continue;
      const vt = vy(m.v1), vb = vy(m.v0);
      const p0 = m.p0, p1 = m.p1 ?? (Number(m.p0) + Number(m.v1 - m.v0));
      if (p0 >= VIEW || p1 <= VLO) continue;
      const pt = py(Math.min(p1, VIEW)), pb = py(Math.max(p0, VLO));
      const hitM = hits.has('vm') && local < 3;
      out.push(`<path d="M${MEM.vx1} ${vt} L${MEM.vx1 + (MEM.px0 - MEM.vx1) * gr} ${vt + (pt - vt) * gr} L${MEM.vx1 + (MEM.px0 - MEM.vx1) * gr} ${vb + (pb - vb) * gr} L${MEM.vx1} ${vb} Z" style="fill:${KC(m.kind)}" opacity="${0.16 + (hitM ? 0.14 : 0)}" stroke="${KC(m.kind)}" stroke-opacity=".55"/>`);
      out.push(`<rect x="${MEM.vx0 + 3}" y="${vt}" width="${MEM.vx1 - MEM.vx0 - 6}" height="${Math.max(3, vb - vt)}" rx="2" style="fill:${KC(m.kind)}" opacity=".9" ${hitM ? 'stroke="#7fe0ff" stroke-width="2" filter="url(#glow)"' : ''}/>`);
      vlabels.push({ y: (vt + vb) / 2, name: m.label.replace(/ 0x[0-9A-F]+$/, ''), addr: '0x' + m.v0.toString(16).toUpperCase(), color: KC(m.kind), x: MEM.vx0 + 3, hit: hitM });
    }
    placeLabels(vlabels, MEM.top, MEM.bottom, 32);
    for (const l of vlabels) {
      out.push(`<path d="M${l.x} ${l.y0} L${MEM.vx0 - 6} ${l.y}" stroke="#3a4d63" fill="none"/>`);
      wrapText(l.name, 7).forEach((line, i, arr) => out.push(`<text x="${MEM.vx0 - 8}" y="${l.y - 3 - (arr.length - 1 - i) * 15}" font-size="13" text-anchor="end" fill="${l.hit ? '#fff' : '#cfdbe7'}">${esc(line)}</text>`));
      out.push(`<text x="${MEM.vx0 - 8}" y="${l.y + 11}" font-size="9.5" text-anchor="end" class="mono" fill="#7f95ab">${esc(l.addr)}</text>`);
    }
  }

  // pointers
  const ptrs = [];
  const pc = physPc(S);
  if (pc != null) ptrs.push({ a: pc, tag: '执行中', color: '#ffd166' });
  const sp = physSp(S);
  if (sp != null && S.mode !== 'off') ptrs.push({ a: sp, tag: '栈顶', color: '#7fe0ff' });
  const cr3 = big(S.ctl.cr3);
  if (S.paging && cr3) ptrs.push({ a: cr3, tag: 'CR3', color: '#f07b5b' });
  for (const p of ptrs) { if (Number(p.a) > VIEW) p.tag = '↑ ' + p.tag; else if (Number(p.a) < VLO) p.tag = '↓ ' + p.tag; }
  const placed = ptrs.map(p => ({ ...p, y: Math.min(MEM.bottom, Math.max(MEM.top, py(p.a))) })).sort((a, b) => a.y - b.y);
  const groups = [];
  for (const p of placed) { const g = groups.at(-1); if (g && p.y - g.at(-1).y < 18) g.push(p); else groups.push([p]); }
  for (const g of groups) {
    const mid = g.reduce((t, p) => t + p.y, 0) / g.length;
    g.forEach((p, i) => { p.ty = mid + (i - (g.length - 1) / 2) * 17; });
    const tw = Math.max(...g.map(p => p.tag.length * 13 + 8));
    out.push(`<rect x="${MEM.px0 - 26 - tw}" y="${g[0].ty - 10}" width="${tw + 4}" height="${17 * g.length + 3}" rx="5" fill="#0b131c" opacity=".88"/>`);
  }
  for (const p of placed) {
    out.push(`<path d="M${MEM.px0 - 2} ${p.y} l-10 -6 v12 z" fill="${p.color}"/>`);
    out.push(`<path d="M${MEM.px0 - 12} ${p.y} L${MEM.px0 - 22} ${p.ty}" stroke="${p.color}" opacity=".7"/>`);
    out.push(`<text x="${MEM.px0 - 26}" y="${p.ty + 4.5}" font-size="13" text-anchor="end" fill="${p.color}" font-weight="700">${p.tag}</text>`);
  }
  if (S.paging && S.rip) {
    const v = big(S.rip);
    if (v != null) { const y = vy(v); out.push(`<path d="M${MEM.vx1 + 2} ${y} l10 -6 v12 z" fill="#ffd166"/>`); }
  }
  $('memSvg').innerHTML = out.join('');
}
const tm0 = () => 0.3;
function assignLanes(regions) {
  const rs = regions.filter(r => !r.base);
  const inside = (a, b) => a.start >= b.start && a.end <= b.end;
  const over = (a, b) => a.start < b.end && b.start < a.end;
  const out = new Map();
  for (const r of rs) {
    const host = rs.find(o => o !== r && o.kind === 'free' && inside(r, o));
    out.set(r.id, { lane: 0, of: 1, inset: host ? 8 : 0, host: !!host });
  }
  const flat = rs.filter(r => !out.get(r.id).host && r.kind !== 'free');
  for (const r of flat) {
    const used = new Set(flat.filter(o => o !== r && over(r, o) && flat.indexOf(o) < flat.indexOf(r)).map(o => out.get(o.id).lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    out.get(r.id).lane = lane;
  }
  for (const r of flat) {
    const peers = flat.filter(o => o === r || over(r, o));
    out.get(r.id).of = Math.max(...peers.map(o => out.get(o.id).lane)) + 1;
  }
  return out;
}
function wrapText(s, n) {
  const out = [];
  let rest = s;
  while (rest.length > n && out.length < 1) { out.push(rest.slice(0, n)); rest = rest.slice(n); }
  out.push(rest);
  return out;
}
function placeLabels(list, top, bottom, gap) {
  list.sort((a, b) => a.y - b.y);
  for (const l of list) l.y0 = l.y;
  for (let i = 1; i < list.length; i++) list[i].y = Math.max(list[i].y, list[i - 1].y + gap);
  if (list.length && list.at(-1).y > bottom - 8) {
    list.at(-1).y = bottom - 8;
    for (let i = list.length - 2; i >= 0; i--) list[i].y = Math.min(list[i].y, list[i + 1].y - gap);
  }
  for (const l of list) l.y = Math.max(top + 8, l.y);
}

function highlightCode(t, asm) {
  let s = esc(t);
  if (asm) return s.replace(/(;.*$)/, '<span class="c">$1</span>');
  s = s.replace(/(\/\*.*?\*\/|\/\/.*$|(?<=\s)#\s.*$)/g, '<span class="c">$1</span>');
  s = s.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, '<span class="s">$1</span>');
  return s;
}
function lineIndex(code, line) {
  if (!line) return -1;
  return code.lines.findIndex(l => !l.gap && norm(l.t).includes(norm(line)));
}
function renderCode(cur, prev, op, local) {
  const c = cur.code;
  if (!c) { $('codeLines').innerHTML = '<div class="code-empty">CPU 还没开始执行任何代码</div>'; $('codeLines').style.transform = ''; $('codeFile').textContent = ''; $('codeLang').textContent = '—'; codeId = null; return; }
  const code = CODE[c.id];
  if (codeId !== c.id) {
    $('codeLines').innerHTML = code.lines.map(l => (l.gap ? '<div class="cl gap"><span class="n"></span><span class="t">    ⋯</span></div>' : `<div class="cl"><span class="n">${l.n}</span><span class="t">${highlightCode(l.t, code.file.endsWith('.asm')) || ' '}</span></div>`)).join('');
    $('codeFile').textContent = code.file;
    $('codeLang').textContent = code.lang;
    codeId = c.id;
  }
  const idx = lineIndex(code, c.line);
  const rows = $('codeLines').children;
  for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('cur', i === idx && !!op.code);
  const bodyH = 430 - 52;
  const target = Math.max(0, idx * 25 - bodyH * 0.38);
  let y = target;
  const pc = prev.code;
  if (pc && pc.id === c.id && op.code) {
    const pidx = lineIndex(code, pc.line);
    const from = Math.max(0, pidx * 25 - bodyH * 0.38);
    y = from + (target - from) * ease(local / 0.45);
  }
  const maxY = Math.max(0, rows.length * 25 + 12 - bodyH);
  $('codeLines').style.transform = `translateY(${-Math.min(y, maxY)}px)`;
}

function renderFocus(cur, prev, op, local) {
  const f = cur.focus;
  if (!f) { $('focusTitle').textContent = '数据结构'; $('focusBody').innerHTML = '<div class="focus-empty">需要时，这里会画出 CPU 正在用的表：内存地图、段表、页表、进程表……</div>'; return; }
  $('focusTitle').textContent = f.title;
  const fresh = op.focus === f && prev.focus !== f;
  if (f.kind === 'table') {
    const n = fresh && f.title.startsWith('e820') ? Math.ceil(local / 0.55) : f.rows.length;
    const hl = new Set(f.hl || []);
    $('focusBody').innerHTML = `<table><thead><tr>${f.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${f.rows.slice(0, n).map((r, i) => `<tr class="${hl.has(i) || /运行中/.test(r.at(-1)) ? 'hl' : ''}">${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  } else if (f.kind === 'cycle') {
    const steps = [['① 算地址', 'CS × 16 + IP'], ['② 取指令', '按地址读出字节'], ['③ 看懂', '译码：要做什么'], ['④ 执行', '改寄存器 / 内存，IP 前进']];
    $('focusBody').innerHTML = `<div class="pt">${steps.map(([b, sm], i) => `${i ? '<span class="ar">→</span>' : ''}<div class="lv ${f.at === 4 || i === f.at ? 'on' : ''}"><b>${b}</b><small>${sm}</small></div>`).join('')}<span class="ar">↺</span></div>`;
  } else if (f.kind === 'pt') {
    const lv = [['CR3', '页表起点'], ['PML4', '第 4 级 · 1 项'], ['PDPT', '第 3 级 · 4 项'], ['页目录 ×4', '2048 项 × 2 MB'], ['物理内存', '0 – 4 GB']];
    $('focusBody').innerHTML = `<div class="pt">${lv.map(([b, s], i) => `${i ? '<span class="ar">→</span>' : ''}<div class="lv ${i <= f.level + 1 || (i === 4 && f.level >= 3) ? 'on' : ''}"><b>${b}</b><small>${s}</small></div>`).join('')}</div>`;
  } else if (f.kind === 'walk') {
    const parts = [['PML4', f.idx[0]], ['PDPT', f.idx[1]], ['页目录', f.idx[2]], ['页内偏移', f.off]];
    const step = Math.floor(local / 0.6);
    $('focusBody').innerHTML = `<div class="walk"><div class="va">${parts.map(([n, v], i) => `<span class="${i < step ? 'on' : ''}"><small>${n} 第</small>${typeof v === 'number' ? v + ' 项' : v}</span>`).join('')}</div><div class="res">虚拟 ${hex(f.va)} → 物理 ${hex(f.pa)}${step >= 4 ? ' ✓' : ''}</div></div>`;
  }
}

function renderScreen(cur, prev, op, local) {
  $('screenTitle').textContent = cur.screen.title;
  const lines = [...cur.screen.lines];
  const pl = prev.screen.lines;
  let shown = lines;
  if (op.screen) {
    const reveal = clamp((local - 0.3) / 1.0);
    const keep = op.screen.set ? 0 : op.screen.type ? pl.length - 1 : pl.length;
    shown = lines.map((l, i) => {
      if (i < keep) return l;
      if (op.screen.type && i === lines.length - 1) return pl[i] + op.screen.type.slice(0, Math.ceil(reveal * op.screen.type.length));
      const span = lines.length - keep;
      const r = clamp(reveal * span - (i - keep));
      return l.slice(0, Math.ceil(r * l.length));
    });
  }
  const last = shown.slice(-8);
  $('screen').innerHTML = last.map(esc).join('\n') + (cur.screen.lines.length ? '<span class="cursor"></span>' : '');
}

function renderSpot(op) {
  const spot = op.spot;
  const els = document.querySelectorAll('[data-spot]');
  for (const el of els) {
    if (!spot) { el.classList.remove('dim'); continue; }
    const targets = spot.map(s => document.querySelector(`[data-spot="${s}"]`)).filter(Boolean);
    const related = targets.some(t => t === el || t.contains(el) || el.contains(t));
    el.classList.toggle('dim', !related);
  }
}

function renderFlows(op, local, S) {
  const out = [];
  for (const [i, f] of (op.flow || []).entries()) {
    const t0 = FLOW.t0 + i * FLOW.gap, dur = FLOW.dur;
    const p = (local - t0) / dur;
    if (p < -0.15 || p > 1.6) continue;
    const a = endpoint(f.from, f.to, S), b = endpoint(f.to, f.from, S);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const bothMem = f.from.startsWith('mem.') && f.to.startsWith('mem.');
    const c1 = bothMem ? { x: a.x - 90, y: a.y } : { x: a.x + dx * 0.45, y: a.y };
    const c2 = bothMem ? { x: b.x - 90, y: b.y } : { x: b.x - dx * 0.45, y: b.y };
    const d = `M${a.x} ${a.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
    const fade = p > 1 ? 1 - (p - 1) / 0.6 : 1;
    out.push(`<path d="${d}" fill="none" stroke="#7fe0ff" stroke-width="2.5" stroke-dasharray="7 7" opacity="${0.55 * fade}"/>`);
    const q = ease(clamp(p));
    const pt = bez(a, c1, c2, b, q);
    if (p >= 0 && p <= 1.05) {
      out.push(`<circle cx="${pt.x}" cy="${pt.y}" r="15" fill="#7fe0ff" opacity=".25"/><circle cx="${pt.x}" cy="${pt.y}" r="7.5" fill="#dff8ff"/>`);
      if (f.label) out.push(`<g transform="translate(${pt.x + 14} ${pt.y - 26})"><rect x="-6" y="-17" width="${labelW(f.label)}" height="26" rx="6" fill="#0b2230" stroke="#7fe0ff"/><text x="${labelW(f.label) / 2 - 6}" y="1" text-anchor="middle" font-size="16" fill="#e8fbff" font-family="var(--mono)">${esc(f.label)}</text></g>`);
    } else if (p > 1.05 && fade > 0) {
      out.push(`<circle cx="${b.x}" cy="${b.y}" r="${10 + 12 * (p - 1)}" fill="none" stroke="#7fe0ff" stroke-width="2" opacity="${fade}"/>`);
    }
  }
  $('flows').innerHTML = out.join('');
}
const labelW = s => 14 + [...s].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 16 : 9.6), 0);
function bez(a, b, c, d, t) {
  const u = 1 - t;
  return { x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x, y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y };
}
function endpoint(name, other, S) {
  if (name.startsWith('addr:')) {
    const o = other && anchorEl(other);
    const right = o && center(o).x > MEM.x + 588;
    return { x: MEM.x + (right ? MEM.px1 : MEM.px0), y: MEM.y + Math.min(MEM.bottom, Math.max(MEM.top, py(Number(name.slice(5)) + (VIEW - VLO <= 64 ? 0.5 : 0)))) };
  }
  if (name.startsWith('vaddr:')) { const v = BigInt(name.slice(6)); return { x: MEM.x + MEM.vx1, y: MEM.y + vy(v) }; }
  if (name.startsWith('mem.')) {
    const o = other && !other.startsWith('mem.') ? anchorEl(other) : null;
    const side = o && center(o).x > MEM.x + 588 ? 'right' : 'left';
    return memAnchor(name.slice(4), STATES.at(-1).mem[name.slice(4)] ? { mem: { ...STATES.at(-1).mem, ...S.mem } } : S, side);
  }
  const el = anchorEl(name);
  if (!el) return null;
  const c = center(el);
  if (!other) return c;
  const oe = other.startsWith('mem.') ? { x: MEM.x + MEM.px0, y: 0 } : (anchorEl(other) ? center(anchorEl(other)) : c);
  if (Math.abs(oe.x - c.x) > 150) return { x: oe.x > c.x ? c.r : c.l, y: c.y };
  return c;
}

/* ---------- playback ---------- */
let t = 0;
let playing = false;
let stopAt = null;
let speed = 1;
let muted = VIDEO;
let lastNow = performance.now();
let audioOp = -1;
const audio = new Audio();
audio.preload = 'auto';

function syncAudio() {
  if (VIDEO) return;
  const { k, op, local } = locate(t);
  if (!playing || muted || !op.audio) { if (!audio.paused) audio.pause(); audioOp = playing ? audioOp : -1; return; }
  if (audioOp !== k && local >= 0.15) {
    audioOp = k;
    audio.src = op.audio;
    audio.playbackRate = speed;
    audio.currentTime = Math.max(0, local - 0.15);
    audio.play().catch(() => {});
  }
}
function frame(now) {
  const dt = (now - lastNow) / 1000;
  lastNow = now;
  if (playing) {
    t += dt * speed;
    if (stopAt != null && t >= stopAt) { t = stopAt; playing = false; stopAt = null; }
    if (t >= TOTAL) { t = TOTAL; playing = false; }
    updatePlay();
  }
  render(t);
  syncAudio();
  const k = locate(t).k;
  if (!VIDEO && k !== frame.k) { frame.k = k; history.replaceState(null, '', `#${k + 1}`); }
  requestAnimationFrame(frame);
}
function updatePlay() { $('play').textContent = playing ? (stopAt != null ? '播放本步…' : '暂停') : '播放'; }
function playOp(k) {
  k = clamp(k, 0, OPS.length - 1);
  t = OPS[k].start;
  stopAt = OPS[k].start + OPS[k].dur - 0.02;
  playing = true;
  audioOp = -1;
  updatePlay();
}
function toggle() {
  if (playing && stopAt == null) { playing = false; } else { stopAt = null; playing = true; if (t >= TOTAL - 0.01) t = 0; audioOp = -1; }
  updatePlay();
}
function curK() { return locate(t).k; }

if (!VIDEO) {
  $('play').onclick = toggle;
  $('nextOp').onclick = () => playOp(curK() + 1);
  $('prevOp').onclick = () => playOp(curK() - 1);
  $('nextAct').onclick = () => playOp(OPS.findIndex(o => o.act === Math.min(ACTS.length - 1, OPS[curK()].act + 1)));
  $('prevAct').onclick = () => { const a = OPS[curK()].act; const k = OPS.findIndex(o => o.act === a); playOp(curK() === k ? OPS.findIndex(o => o.act === Math.max(0, a - 1)) : k); };
  $('speed').onchange = e => { speed = Number(e.target.value); audio.playbackRate = speed; };
  $('mute').onclick = () => { muted = !muted; $('mute').textContent = muted ? '声音：关' : '声音：开'; if (muted) audio.pause(); audioOp = -1; };
  $('seek').oninput = e => { t = (Number(e.target.value) / 1000) * TOTAL; playing = false; stopAt = null; audioOp = -1; updatePlay(); };
  $('acts').onclick = e => { const li = e.target.closest('li'); if (li) playOp(OPS.findIndex(o => o.act === Number(li.dataset.act))); };
  addEventListener('keydown', e => {
    if (e.target.closest('select,input')) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); $('nextOp').click(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); $('prevOp').click(); }
    else if (e.key === 'PageDown') { e.preventDefault(); $('nextAct').click(); }
    else if (e.key === 'PageUp') { e.preventDefault(); $('prevAct').click(); }
    else if (e.key === 'm' || e.key === 'M') $('mute').click();
  });
  const fromHash = () => {
    const h = Number(location.hash.slice(1));
    if (h >= 1 && h <= OPS.length && h !== frame.k + 1) { const op = OPS[h - 1]; t = op.start + op.dur - 0.02; playing = false; stopAt = null; audioOp = -1; updatePlay(); }
  };
  addEventListener('hashchange', fromHash);
  fromHash();
  if (!TIMING) $('mute').title = '尚未生成配音';
  requestAnimationFrame(frame);
} else {
  render(0);
}

window.__story = {
  total: TOTAL,
  ops: OPS.map(o => ({ start: o.start, dur: o.dur, audio: o.audio, say: o.say })),
  seek(x) { t = x; render(x); },
  ready: false,
};
document.fonts.ready.then(() => { window.__story.ready = true; });
