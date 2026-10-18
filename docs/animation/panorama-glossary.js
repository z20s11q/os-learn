/**
 * Global glossary for the boot panorama: every register, register bit and
 * CPU structure shown in teaching text gets its Chinese name in brackets,
 * e.g. "CR0.PE" → "CR0.PE（保护模式使能位）". Display only: narration audio and
 * subtitle timing keep the original text.
 */

const TERMS = [
  [['RAX', 'EAX', 'AX'], '累加器'], [['RBX', 'EBX', 'BX'], '基址寄存器'], [['RCX', 'ECX', 'CX'], '计数寄存器'], [['RDX', 'EDX', 'DX'], '数据寄存器'],
  [['RSI', 'ESI', 'SI'], '源索引寄存器'], [['RDI', 'EDI', 'DI'], '目的索引寄存器'], [['RBP', 'EBP', 'BP'], '栈帧基址寄存器'], [['RSP', 'ESP', 'SP'], '栈指针'],
  [['R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15'], '扩展通用寄存器'],
  [['RIP', 'EIP', 'IP'], '指令指针'], [['RFLAGS', 'EFLAGS', 'FLAGS'], '标志寄存器'], [['CPL'], '当前特权级'],
  [['CR0'], '模式控制寄存器'], [['CR2'], '缺页地址寄存器'], [['CR3'], '页表基址寄存器'], [['CR4'], '扩展功能控制寄存器'], [['CR8', 'TPR'], '任务优先级寄存器'],
  [['EFER'], '扩展特性使能寄存器'], [['MSR'], '模型特定寄存器'],
  [['CS'], '代码段寄存器'], [['SS'], '栈段寄存器'], [['DS'], '数据段寄存器'], [['ES'], '附加段寄存器'], [['FS'], 'FS 段寄存器'], [['GS'], 'GS 段寄存器'],
  [['TR'], '任务寄存器'], [['LDTR'], '局部描述符表寄存器'], [['GDTR'], '全局描述符表寄存器'], [['IDTR'], '中断描述符表寄存器'],
  [['GDT'], '全局描述符表'], [['IDT'], '中断描述符表'], [['LDT'], '局部描述符表'], [['TSS'], '任务状态段'],
  [['PML4'], '第 4 级页表'], [['PDPT'], '页目录指针表'], [['PD'], '页目录'],
  [['DR0', 'DR1', 'DR2', 'DR3'], '断点地址寄存器'], [['DR6'], '调试状态寄存器'], [['DR7'], '调试控制寄存器'],
  [['MXCSR'], 'SSE 控制与状态寄存器'], [['FCW'], 'x87 控制字'], [['FSW'], 'x87 状态字'], [['FTW'], 'x87 标记字'],
  [Array.from({ length: 16 }, (_, i) => `XMM${i}`), 'SSE 向量寄存器'], [Array.from({ length: 8 }, (_, i) => `ST${i}`), 'x87 栈寄存器'],
  [['STAR', 'IA32_STAR'], '系统调用段选择子寄存器'], [['LSTAR', 'IA32_LSTAR'], '64 位系统调用入口寄存器'], [['SFMASK', 'FMASK', 'IA32_FMASK'], '系统调用标志屏蔽寄存器'],
  [['FS_BASE', 'FSBASE'], 'FS 基址'], [['GS_BASE', 'GSBASE'], 'GS 基址'], [['KERNEL_GS_BASE', 'IA32_KERNEL_GS_BASE'], '内核 GS 交换基址'], [['TSC', 'IA32_TSC'], '时间戳计数器'],
];

/** Register bits; also matched as `REG.BIT`. */
const BITS = {
  PE: '保护模式使能位', MP: '协处理器监视位', EM: '浮点仿真位', TS: '任务切换位', ET: '扩展类型位', NE: '数值异常位', WP: '内核写保护位', AM: '对齐检查屏蔽位', NW: '非直写位', CD: '缓存禁用位', PG: '分页使能位',
  VME: '虚拟 8086 扩展位', PVI: '保护模式虚拟中断位', TSD: '时间戳权限位', DE: '调试扩展位', PSE: '大页扩展位', PAE: '物理地址扩展位', MCE: '机器检查位', PGE: '全局页位', PCE: '性能计数权限位',
  OSFXSR: '操作系统保存 SSE 状态位', OSXMMEXCPT: 'SSE 异常支持位', UMIP: '用户指令防护位', LA57: '五级分页位', FSGSBASE: 'FS/GS 基址指令位', PCIDE: '进程上下文标识位', OSXSAVE: '扩展状态保存位', SMEP: '内核禁止执行用户页位', SMAP: '内核用户页访问保护位',
  SCE: 'SYSCALL 使能位', LME: '长模式使能位', LMA: '长模式已激活位', NXE: '禁止执行使能位', NX: '禁止执行位',
  CF: '进位标志', PF: '奇偶标志', AF: '辅助进位标志', ZF: '零标志', SF: '符号标志', TF: '单步标志', IF: '中断允许标志', DF: '方向标志', OF: '溢出标志', IOPL: 'I/O 特权级', NT: '嵌套任务标志', AC: '对齐检查标志', VIF: '虚拟中断标志', VIP: '虚拟中断挂起标志',
};
/** Fields written as `REG.field`, glossed as "<register>的<field>". */
const FIELDS = { base: '基址', limit: '界限', selector: '选择子', attributes: '属性', attr: '属性' };
/** Segment attribute bits, e.g. `CS.L`. */
const ATTRS = { L: '64 位代码段标志', D: '默认操作数大小标志', DPL: '描述符特权级' };
const DOTTED_OWNERS = ['RFLAGS', 'EFLAGS', 'CR0', 'CR4', 'EFER', 'CS', 'SS', 'DS', 'ES', 'FS', 'GS', 'GDTR', 'IDTR', 'TR', 'LDTR'];
/** Bare bit names that read as ordinary text in Chinese prose are glossed only in dotted form. */
const BARE_BITS = ['PE', 'PG', 'WP', 'CD', 'NW', 'PAE', 'PSE', 'PGE', 'OSFXSR', 'OSXSAVE', 'UMIP', 'LA57', 'FSGSBASE', 'PCIDE', 'SMEP', 'SMAP', 'SCE', 'LME', 'LMA', 'NXE', 'NX', 'IF', 'DF', 'TF', 'IOPL'];

const termZh = new Map(TERMS.flatMap(([names, zh]) => names.map(name => [name, zh])));
for (const bit of BARE_BITS) termZh.set(bit, BITS[bit]);
const regZh = owner => termZh.get(owner === 'EFLAGS' ? 'RFLAGS' : owner);
const alternatives = [...termZh.keys()].sort((a, b) => b.length - a.length).join('|');
const PATTERN = new RegExp(`(?<![A-Za-z0-9_.\\-])(?:(${DOTTED_OWNERS.join('|')})\\.([A-Za-z][A-Za-z0-9]*)|(${alternatives}))(?![A-Za-z0-9_])`, 'g');

function glossFor(owner, field, bare) {
  if (bare) return termZh.get(bare);
  if (BITS[field]) return BITS[field];
  if (ATTRS[field]) return ATTRS[field];
  if (FIELDS[field]) return `${regZh(owner).replace(/寄存器$/, '')}${FIELDS[field]}`;
  return regZh(owner);
}

/** Split text into plain pieces and `{ term, zh }` pieces. */
export function glossSegments(text) {
  const source = String(text ?? '');
  const out = [];
  let last = 0;
  for (const m of source.matchAll(PATTERN)) {
    const zh = glossFor(m[1], m[2], m[3]);
    if (!zh || source.startsWith('（', m.index + m[0].length)) continue;
    if (source.slice(Math.max(0, m.index - zh.length - 3), m.index).includes(zh)) continue;
    if (m.index > last) out.push(source.slice(last, m.index));
    out.push({ term: m[0], zh });
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

export function annotate(text) {
  return glossSegments(text).map(p => (typeof p === 'string' ? p : `${p.term}（${p.zh}）`)).join('');
}

export function annotateHtml(text, esc) {
  return glossSegments(text).map(p => (typeof p === 'string' ? esc(p) : `${esc(p.term)}<span class="gloss">（${esc(p.zh)}）</span>`)).join('');
}

export const glossary = Object.freeze({ terms: Object.fromEntries(termZh), bits: { ...BITS }, fields: { ...FIELDS }, attrs: { ...ATTRS } });
