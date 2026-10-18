/**
 * Subtitle cues for the boot panorama: split each step's narration into short
 * lyric-style lines, time them against the narration audio, and resolve which
 * CPU fields, machine parts and memory regions each line talks about.
 * Dependency-free so build scripts can share the exact same segmentation.
 */

const SENTENCE_END = new Set(['。', '！', '？', '；', '\n']);
const SOFT_BREAK = new Set(['，', '：']);
const MAX_UNITS = 34;
const MIN_UNITS = 7;

const isCjk = c => /[\u3400-\u9fff\uf900-\ufaff]/.test(c);
function units(text) {
  let n = 0;
  for (const c of text) n += isCjk(c) || /[，。；：！？、（）“”]/.test(c) ? 1 : c === ' ' ? 0.3 : 0.55;
  return n;
}

/** Relative speaking time: digits and hex letters are spelled out, punctuation pauses. */
export function speechWeight(text) {
  let w = 0;
  for (const c of text) {
    if (isCjk(c)) w += 1;
    else if (/[0-9]/.test(c)) w += 0.8;
    else if (/[A-Za-z]/.test(c)) w += 0.5;
    else if (SENTENCE_END.has(c)) w += 1.4;
    else if (SOFT_BREAK.has(c) || c === '、' || c === ',' || c === ':') w += 0.6;
    else if (c === '→') w += 0.8;
    else if (c !== ' ') w += 0.2;
  }
  return Math.max(w, 0.5);
}

function display(raw) {
  return raw.replace(/\s+/g, ' ').trim().replace(/[。；，、：]+$/u, '');
}

function splitLong(text, start) {
  const size = units(display(text));
  if (size <= MAX_UNITS) return [{ start, end: start + text.length }];
  const middle = text.length / 2;
  const breakAt = breaks => {
    let best = -1;
    for (let i = 1; i < text.length - 1; i++) {
      if (!breaks.has(text[i])) continue;
      if (units(text.slice(0, i)) < MIN_UNITS || units(text.slice(i + 1)) < MIN_UNITS) continue;
      if (best < 0 || Math.abs(i - middle) < Math.abs(best - middle)) best = i;
    }
    return best;
  };
  let best = breakAt(SOFT_BREAK);
  if (best < 0 && size > MAX_UNITS + 8) best = breakAt(new Set(['、']));
  if (best < 0) return [{ start, end: start + text.length }];
  return [...splitLong(text.slice(0, best + 1), start), ...splitLong(text.slice(best + 1), start + best + 1)];
}

/** Lines in narration order; `start`/`end` index the original narration text. */
export function splitCues(narration) {
  const text = String(narration || '');
  const sentences = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (SENTENCE_END.has(text[i])) { sentences.push([from, i + 1]); from = i + 1; }
  }
  if (from < text.length) sentences.push([from, text.length]);
  let pieces = sentences.flatMap(([a, b]) => splitLong(text.slice(a, b), a)).filter(p => display(text.slice(p.start, p.end)));
  const merged = [];
  for (const piece of pieces) {
    const prev = merged.at(-1);
    const prevText = prev && text.slice(prev.start, prev.end);
    if (prev && units(display(text.slice(piece.start, piece.end))) < MIN_UNITS && units(display(prevText + text.slice(piece.start, piece.end))) <= MAX_UNITS + 6) prev.end = piece.end;
    else if (prev && units(display(prevText)) < MIN_UNITS && !prevText.includes('\n')) prev.end = piece.end;
    else merged.push({ ...piece });
  }
  pieces = merged;
  return pieces.map((p, index) => {
    const raw = text.slice(p.start, p.end);
    return { index, text: display(raw), raw, start: p.start, end: p.end, weight: speechWeight(raw) };
  });
}

/** Proportional start times (seconds) when no measured timing exists. */
export function estimateStarts(cues, duration, lead = 0, tail = 0) {
  const total = cues.reduce((sum, cue) => sum + cue.weight, 0) || 1;
  const span = Math.max(0, duration - lead - tail);
  let acc = 0;
  return cues.map((cue, i) => {
    const at = i === 0 ? 0 : lead + span * acc / total;
    acc += cue.weight;
    return at;
  });
}

/**
 * Cue start times from TTS word timings ([[seconds, text], ...] in speaking
 * order). Words are located in the narration so each line starts exactly when
 * its first word is spoken; unmatched lines fall back to interpolation.
 */
export function startsFromWords(cues, narration, words) {
  if (!Array.isArray(words) || !words.length) return null;
  const located = [];
  let cursor = 0;
  for (const [time, token] of words) {
    const at = String(narration).indexOf(String(token), cursor);
    if (at < 0 || at - cursor > 40) continue;
    located.push({ at, time });
    cursor = at + String(token).length;
  }
  if (located.length < Math.min(3, words.length)) return null;
  const starts = cues.map((cue, i) => {
    if (i === 0) return 0;
    const word = located.find(w => w.at >= cue.start);
    return word ? Math.max(0, word.time - 0.08) : null;
  });
  for (let i = 1; i < starts.length; i++) if (starts[i] == null || starts[i] < starts[i - 1]) starts[i] = starts[i - 1] + 0.5;
  return starts;
}

export function cueAt(starts, position) {
  let index = 0;
  for (let i = 0; i < starts.length; i++) if (position >= starts[i]) index = i;
  return index;
}

const word = token => new RegExp(`(?<![A-Za-z0-9_])(?:${token})(?![A-Za-z0-9_])`);
const wordI = token => new RegExp(`(?<![A-Za-z0-9_])(?:${token})(?![A-Za-z0-9_])`, 'i');

const REGISTER_ALIASES = {
  rip: [word('RIP|EIP|IP'), /指令指针|入口|跳转|跳到|远返回/], linearPc: [/取指/, wordI('linear PC')], rflags: [word('RFLAGS|EFLAGS|FLAGS'), /标志寄存器/],
  cpl: [word('CPL'), wordI('ring ?[03]'), /特权级|用户态|内核态/],
  cr0: [wordI('CR0')], cr2: [wordI('CR2'), /缺页/], cr3: [wordI('CR3'), /页表基址|身份映射|高地址映射/], cr4: [wordI('CR4')], cr8: [wordI('CR8')], efer: [wordI('EFER')],
  cs: [word('CS'), /段寄存器|远跳转|远返回|选择子|64 ?位代码|代码段/], ss: [word('SS'), /段寄存器|建立栈|切换栈/], ds: [word('DS'), /段寄存器/], es: [word('ES'), /段寄存器/], fs: [word('FS')], gs: [word('GS')],
  tr: [word('TR'), /任务寄存器|TSS/], ldtr: [word('LDTR')],
  gdtrBase: [word('GDTR?'), /全局描述符表/], gdtrLimit: [word('GDTR?'), /全局描述符表/],
  idtrBase: [word('IDTR?'), /中断描述符表|中断门/], idtrLimit: [word('IDTR?'), /中断描述符表|中断门/],
  rsp: [wordI('RSP|ESP'), word('SP'), /栈指针|建立栈|切换栈|栈顶|上下文/], rbp: [wordI('RBP|EBP')],
  rax: [wordI('RAX|EAX')], rbx: [wordI('RBX|EBX')], rcx: [wordI('RCX|ECX')], rdx: [wordI('RDX|EDX')], rsi: [wordI('RSI|ESI')], rdi: [wordI('RDI|EDI')],
  mxcsr: [word('MXCSR|SSE')], fcw: [word('FCW|x87'), /浮点控制/], fsw: [word('FSW')], ftw: [word('FTW')],
  star: [word('STAR'), wordI('syscall')], lstar: [word('LSTAR'), wordI('syscall')], sfmask: [word('SFMASK'), wordI('syscall')],
  fsBase: [word('FS_?BASE')], gsBase: [word('GS_?BASE'), wordI('per-?CPU|swapgs')], kernelGsBase: [word('KERNEL_GS_BASE'), wordI('swapgs')], tsc: [word('TSC')],
};
for (let i = 8; i <= 15; i++) REGISTER_ALIASES[`r${i}`] = [word(`R${i}`)];
for (let i = 0; i <= 7; i++) { REGISTER_ALIASES[`dr${i}`] = [word(`DR${i}`)]; REGISTER_ALIASES[`st${i}`] = [word(`ST${i}`)]; }
for (let i = 0; i <= 15; i++) REGISTER_ALIASES[`xmm${i}`] = [wordI(`XMM${i}`)];

const FLAG_TOKENS = ['IF', 'IOPL', 'PE', 'PG', 'WP', 'CD', 'NW', 'ET', 'NE', 'PAE', 'PSE', 'PGE', 'OSFXSR', 'OSXMMEXCPT', 'OSXSAVE', 'UMIP', 'LA57', 'FSGSBASE', 'PCIDE', 'SMEP', 'SMAP', 'LME', 'LMA', 'NXE', 'SCE'];
const FLAG_CONCEPTS = [
  [/保护模式/, ['cr0.PE']], [/分页/, ['cr0.PG']], [/长模式|64 ?位模式/, ['efer.LME', 'efer.LMA']], [/写保护/, ['cr0.WP']],
  [/物理地址扩展/, ['cr4.PAE']], [/关中断|开中断|关闭中断|打开中断|开启中断|屏蔽中断|中断标志|cli|sti/, ['rflags.IF']], [/不可执行/, ['efer.NXE']],
];
const COMPONENTS = {
  cpu: /CPU|处理器|寄存器|取指|复位|初值|初始状态|断电|上电|地址线|上下文/,
  rom: /ROM|Flash|固件|BIOS|复位向量|断电|上电/,
  ram: /RAM|内存|页表|装入|加载到|initramfs|断电|上电|A20|复制|搬移|引导数据|映射|归档|页描述符|分配|物理范围|initmem|只读权限/,
  disk: /磁盘|根盘|boot\.iso|ISO|ext2|vda|光盘|存储介质|El Torito|根文件系统|断电|上电|挂载|文件|GRUB|BusyBox|新根|inittab|rcS/,
  tty: /终端|TTY|tty|串口|UART|键盘|i8042|VGA|显示|控制台|console|IRQ|中断控制器|定时器|timer|输入|驱动|设备|可读|计时|时钟/,
};
const REGIONS = {
  ivt: /IVT|中断向量表|0x0000(?![0-9a-f])/, bda: /BDA|BIOS 数据区|0x0400/, boot: /0x7c00|引导扇区|El Torito|引导镜像|引导代码|引导窗口/, 'loader-low': /GRUB 核心|core\.img/,
  setup: /boot_params|命令行|cmdline|0x9020?0|setup|引导参数/, vga: /VGA|显存|0xb8000/,
  rom: /0xf0000|0xfe05b|0xfffffff0|BIOS 窗口|ROM 窗口|SeaBIOS/, decompressor: /解压/,
  kernel: /vmlinux|主内核|内核映像|start_kernel|0x1000000/, ram: /页帧|伙伴|task_struct|slab|initramfs|进程|归档|cpio|页描述符|页分配|对象缓存|memblock|分配器/,
};
const TERMINAL = /终端|shell|TTY|tty|getty|控制台|console|串口|提示符|login|输入|PID|进程|任务|BusyBox|调度|inittab|rcS|kernel_init/;
const BYTES = /字节|bytes/i;
const STOP_TOKENS = new Set(['cpu', 'ram', 'rom', 'the', 'and', 'qemu', 'linux']);

function codeTokens(text) {
  const tokens = new Map();
  for (const m of text.toLowerCase().matchAll(/0x[0-9a-f]+|[a-z_][a-z0-9_.]*[a-z0-9_]/g)) {
    const t = m[0].replace(/\.$/, '');
    if (t.length < 2 || STOP_TOKENS.has(t)) continue;
    tokens.set(t, t.startsWith('0x') ? 2 : 1);
  }
  return tokens;
}

/** Code lines most related to a cue (1-based), or [] when nothing overlaps. */
export function relatedCodeLines(cueText, code) {
  const wanted = codeTokens(cueText);
  if (!wanted.size) return [];
  const scores = String(code || '').split('\n').map(line => {
    let score = 0;
    for (const [token, weight] of codeTokens(line)) if (wanted.has(token)) score += weight;
    return score;
  });
  const best = Math.max(0, ...scores);
  return best > 0 ? scores.flatMap((score, i) => (score === best ? [i + 1] : [])) : [];
}

/**
 * Decide at which subtitle line each change of a step becomes visible.
 * A change appears on the first line that talks about it; a flag always flips
 * together with its register word. Unmentioned register changes appear at the
 * first line for entry/waiting checkpoints (they happened before the stop) and
 * at the last line otherwise. Returns beat indices.
 */
export function planBeats({ targets, registerIds = [], flags = [], memoryChanges = [], terminalLines = 0, position }) {
  const last = Math.max(0, targets.length - 1);
  const first = (test, fallback) => { const i = targets.findIndex(test); return i >= 0 ? i : fallback; };
  const fallback = ['entry', 'waiting'].includes(position) ? 0 : last;
  const registers = new Map();
  for (const id of registerIds) {
    const own = flags.filter(f => f.register === id);
    registers.set(id, first(t => t.registers.has(id) || own.some(f => t.flags.has(f.id) || t.flags.has(f.en)), fallback));
  }
  const flagBeats = new Map(flags.map(f => [f.id, registers.get(f.register) ?? first(t => t.flags.has(f.id) || t.flags.has(f.en), fallback)]));
  const memory = memoryChanges.map(m => first(t => t.regions.has(m.region), Math.min(1, last)));
  const terminalStart = first(t => t.terminal, Math.min(1, last));
  const terminal = Array.from({ length: terminalLines }, (_, j) => Math.min(last, terminalStart + Math.floor(j * (last - terminalStart + 1) / terminalLines)));
  return { registers, flags: flagBeats, memory, terminal, last };
}

/** Which on-screen objects a subtitle line refers to. */
export function cueTargets(text, knownRegisters) {
  const registers = new Set();
  const flags = new Set();
  for (const [id, patterns] of Object.entries(REGISTER_ALIASES)) {
    if ((!knownRegisters || knownRegisters.has(id)) && patterns.some(p => p.test(text))) registers.add(id);
  }
  for (const m of text.matchAll(/(?<![A-Za-z0-9_])(CR[0-8]|EFER|RFLAGS|EFLAGS)\.([A-Z0-9]+)/gi)) {
    const reg = m[1].toLowerCase().replace('eflags', 'rflags');
    flags.add(`${reg}.${m[2].toUpperCase()}`);
  }
  for (const token of FLAG_TOKENS) if (word(token).test(text)) flags.add(token);
  for (const [pattern, ids] of FLAG_CONCEPTS) if (pattern.test(text)) ids.forEach(id => flags.add(id));
  const components = new Set(Object.entries(COMPONENTS).filter(([, p]) => p.test(text)).map(([id]) => id));
  const regions = new Set(Object.entries(REGIONS).filter(([, p]) => p.test(text)).map(([id]) => id));
  if (regions.size) components.add('ram');
  return { registers, flags, components, regions, terminal: TERMINAL.test(text), bytes: BYTES.test(text) };
}
