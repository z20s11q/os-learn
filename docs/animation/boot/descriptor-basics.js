/** Beginner model: 32-bit protected mode, paging off. Addresses and offsets are displayed in hexadecimal.
 * Intel SDM Vol. 3A §§2.4, 3.4–3.5, 6.10–6.12. This is an explanatory model,
 * not a CPU emulator. GDT and IDT contents are deliberately small and explicit.
 */
import { LINUX_STEPS, linuxMemory, linuxCpu } from './descriptor-linux.js';

const GDT_BASE = 0x1000;
const DATA_BASE = 0x3000;
const hex = n => '0x' + n.toString(16).toUpperCase().padStart(n < 0x100 ? 2 : 4, '0');
const IDT_BASE = 0x6000;
const step = (part, title, say, scene, task, why, extra = {}) => ({
  say, lesson: { part, title, scene, task, why, ...extra },
});
const ops = [
  step(0, '先只认识两个地方：CPU 和内存',
    'CPU 负责做事，内存负责放东西。程序、数据、表，都放在内存里。',
    'memory', '程序是一份步骤清单。CPU 从内存取出一条指令，完成一个动作，再取下一条。',
    '要理解这套机制，先分清“谁执行动作”和“东西放在哪里”。表本身不会执行任何动作。',
    { bridge: 'CPU 读写内存', direction: '↔' }),
  step(0, '地址是位置；内容是放在那里的东西',
    '“地址 0x3005”是一个格子的位置；“数值 7”是这个格子里的内容。两者不是一回事。',
    'memory', '想读取一个数，必须先知道它在内存的哪个地址。',
    '可以把地址理解成格子的编号。图里一格是 1 字节，也就是一个基本存储单位。CPU 用地址找到格子，才读得到内容；地址与偏移统一显示为十六进制，用 0x 开头。',
    { bridge: '读地址 0x3005', direction: '→', cell: true }),
  step(0, '寄存器：CPU 内部的几个小存储位置',
    '寄存器在 CPU 里面，也能存数。CPU 把常用的信息放在这里，执行时直接使用。',
    'memory', '把从内存读出的 7，暂存在自己内部的一个寄存器里。',
    '内存很大，放程序和数据；寄存器很少，放当前工作需要的信息。寄存器里也可以存“某张表的地址”。',
    { bridge: '数值 7 送回 CPU', direction: '←', register: true, cell: true }),
  step(0, 'CPU 怎样把一份程序运行起来？',
    'CPU 记住下一条指令的位置，取出指令，识别动作，执行，再走到下一条。查表也会在特定动作中自动发生。',
    'cycle', '从内存取下一条指令；按照硬件内置的规则识别并执行它，然后继续。',
    '人写的代码会被工具转换成 CPU 认识的数字编码。图中用中文表示这些编码要求的动作；CPU 实际读取的是编码，不会阅读中文说明。',
    { bridge: '取指令 → 执行动作 → 下一条', direction: '↔' }),
  step(1, '为什么还需要“段”？给一片内存加上使用规则',
    '段就是一片有起点、有范围、有使用规则的内存。例如：从 0x3000 开始的 100 字节，可以读写。',
    'range', '需要知道：允许使用哪一片内存？有多大？能读、能写，还是能执行？',
    '只有一个地址还不够。CPU 也要检查这次访问是否超出范围、是否违反权限。这里用 32 位保护模式说明这件事。',
    { bridge: '先定义使用规则', direction: '→' }),
  step(1, '把每个段的规则写成一行，就是“段描述符”',
    '一行描述一个段，多行放在一起就是一张段表。GDT 是“全局描述符表”的缩写。',
    'gdt', '等待软件告诉自己：各个段的规则写在哪里。',
    '表里放的是描述内存的资料。它与被描述的那片内存分开存放：表在 0x1000 附近，数据在 0x3000 附近。',
    { bridge: '软件先填写表', direction: '→' }),
  step(1, 'CPU 怎么知道这张表从哪里开始？',
    'CPU 不会自己搜索整块内存。启动程序或操作系统先选好放表的位置，再发出一条指令把位置告诉 CPU。',
    'gdt', '还不知道 GDT 在哪里；仅仅把表写进内存，不会自动通知 CPU。',
    '启动程序、操作系统也是由 CPU 执行的程序。它们先写好表，再发出登记指令。CPU 以后要找段表，就从这个专用寄存器里取地址。',
    { bridge: '表已写好，位置还未登记', direction: '…' }),
  step(1, '这个专门记住段表位置的寄存器，叫 GDTR',
    'GDTR 在 CPU 里，记住 GDT 在哪里、有多大。GDT 那张表仍然留在内存里。',
    'gdt', '软件执行装载指令，把“起点 0x1000、最后字节偏移 0x17”交给 GDTR。',
    'R 表示寄存器。本教学例子仅放空项、代码段、数据段 3 项，共 24 字节，limit 是 0x17。GDT 并不限定 3 项；Linux 的真实用途在本章最后专门说明。',
    { bridge: '表的位置 → GDTR', direction: '←', gdtr: true, focus: 'gdtr', formula: 'GDTR：base = 0x1000，limit = 0x17；表占地址 0x1000 ～ 0x1017' }),
  step(1, '现在程序提出请求：我要使用第 2 号数据段',
    '程序提供一个“选择子”，里面包含表项编号。这里选择的编号是 2，CPU 就去找 GDT 的第 2 项。',
    'gdt', '收到“装载数据段”的指令，以及包含编号 2 的选择子。',
    '程序不用在每次访问时重复提供段的起点和权限。先选好一个段，CPU 以后就能按它的规则工作。',
    { bridge: '拿到表项编号 2', direction: '→', gdtr: true, focus: 'request', formula: '本例选择子的实际数值是 0x10（十进制 16）；其中的表项编号是 2。先不用记位编码。' }),
  step(1, 'CPU 用“表的起点 + 行的位置”找到那一项',
    'GDTR 给出起点 0x1000。编号 2 的表项在起点后面 2 × 8 字节处，也就是地址 0x1010。',
    'gdt', '先读 GDTR，再计算 0x1000 + 2 × 8，并从内存地址 0x1010 读取描述符。',
    '编号从 0 开始，每项固定占 8 字节。这个计算由 CPU 的硬件规则完成，程序不用自己写一段“搜索表格”的代码。',
    { bridge: '读取地址 0x1010', direction: '→', gdtr: true, gdtRow: 2, formula: '表项地址 = 表的起点 0x1000 + 编号 2 × 每项 8 字节 = 0x1010' }),
  step(1, '读到这一行，才知道数据段从 0x3000 开始',
    'CPU 读出“起点 0x3000、长度 100 字节、允许读写”，检查通过后，把这些规则记在 CPU 内部。',
    'gdt', '把选择子放进 DS，把段的起点、界限、权限放进 DS 对应的内部缓存。',
    'DS 是“当前数据段”的寄存器。它对外显示选择子；CPU 内部还记着查到的规则，方便后续访问直接使用。',
    { bridge: '段规则送回 CPU', direction: '←', gdtr: true, cache: true, focus: 'cache', gdtRow: 2, formula: 'GDTR 里的 0x1000 是表的起点；缓存里的 0x3000 才是数据段的起点。' }),
  step(1, '接下来读数据：从段起点再往后走 5 字节',
    '段起点是 0x3000，段内偏移是 0x05，所以实际读地址 0x3005，得到里面的数值 7。',
    'read', '使用已经缓存的段规则，检查偏移，再读取数据。',
    '这里走的是“段起点 + 段内偏移”。普通读取不会每次重查 GDT。先选段时查表，后续访存使用缓存。',
    { bridge: '读取数据，取回 7', direction: '↔', gdtr: true, cache: true, cell: true, formula: '数据地址 = 段起点 0x3000 + 段内偏移 0x05 = 0x3005' }),
  step(1, '试一下：如果程序要求读到段外，会怎样？',
    '这个段只有 100 字节，所以合法偏移是 0x00 到 0x63。偏移 0x78 已经越界，CPU 会阻止访问。',
    'probe', '先检查范围，再决定是否允许这次访问。试点右边的两个请求。',
    '段表不仅帮助 CPU 找地址，也提供保护规则。CPU 发现越界会产生异常，交给操作系统处理。这里先观察“允许”与“阻止”的区别。',
    { bridge: '先检查，再读数据', direction: '↔', gdtr: true, cache: true, probe: true }),
  step(1, '把刚才的两次“找位置”分清楚',
    '第一次：用 GDTR 找到段表，取出段规则。第二次：用缓存的段起点，找到真正的数据。',
    'read', '保留两种不同的信息：表在哪里，以及当前数据段的规则是什么。',
    '只修改内存里的 GDT，或只给 GDTR 换一个表地址，都不会自动刷新已装载的 DS 缓存。重新装载 DS 才会读取新规则。',
    { bridge: '选段一次；按规则访问', direction: '↔', gdtr: true, cache: true, formula: '找规则：0x1000 + 2 × 8 → 描述符；找数据：0x3000 + 0x05 → 数值 7' }),
  step(2, '如果稍后来了设备事件，CPU 该去哪里处理？',
    '例如某个设备稍后会发来事件。CPU 需要暂停原程序，转去运行负责这件事的程序。现在先准备好这条路。',
    'event', '先不接收事件，先准备处理入口。设想原程序稍后需要从地址 0xC00C 继续。',
    '设备事件可以引起中断；CPU 自己发现错误也会产生异常。正确顺序是先配置入口，再允许接收设备中断。我们先跟踪一个由软件分配为 33 号的事件。',
    { bridge: '先准备，稍后再触发', direction: '…', gdtr: true, event: 'preview' }),
  step(2, '谁来告诉 CPU：33 号事件该交给哪段程序？',
    '软件准备另一张表：每个事件编号对应一个处理入口。这张表叫 IDT，中断描述符表。',
    'idt', '需要知道“发生的是哪件事”，以及“负责处理它的程序从哪里开始”。',
    '事件编号只是一个编号，不是程序地址，也不是设备数据。IDT 把编号对应到处理程序的入口。这里 33 号的对应关系由软件配置。',
    { bridge: '软件填写事件入口', direction: '→', gdtr: true }),
  step(2, 'IDTR 的任务也很简单：记住 IDT 在哪',
    '操作系统把 IDT 的起点 0x6000 和大小信息交给 IDTR。CPU 以后就从这里找到事件入口表。',
    'idt', '装载 IDTR：base = 0x6000，limit = 0x7FF。IDT 本身留在内存。',
    '本例 IDT 有 256 项，每项 8 字节，共 2048 字节。登记表位置和“允许接收中断”是两件事；装载 IDTR 不会自动打开中断开关。',
    { bridge: '表的位置 → IDTR', direction: '←', gdtr: true, idtr: true, focus: 'idtr', formula: 'IDTR：base = 0x6000，limit = 0x7FF；表占地址 0x6000 ～ 0x67FF' }),
  step(2, '事件 33 到来：CPU 查第 33 项',
    'IDTR 给出表起点 0x6000。第 33 项在后面 33 × 8 字节处，所以 CPU 读取地址 0x6108。',
    'idt', '设备发出信号，中断控制器按预先配置把编号 33 送给 CPU；CPU 据此读取入口。',
    '中断控制器负责汇集设备的信号；软件事先配置了信号与编号的对应关系。查 GDT 时编号来自选择子，查 IDT 时编号来自事件。',
    { bridge: '现在，事件 33 到达', direction: '→', gdtr: true, idtr: true, event: 'arrived', idtRow: true, formula: '入口表项地址 = 0x6000 + 33 × 8 = 0x6108' }),
  step(2, 'IDT 给出入口；GDT 说明入口所在的代码段',
    'IDT 给出选择子 0x08（编号 1）和偏移 0x28。CPU 再读 GDT 的第 1 项，得到代码段起点 0xC000，最终入口是 0xC028。',
    'dispatch', '检查代码段允许执行，再计算处理程序的实际入口。',
    '这一步把两张表接起来了：IDT 决定“去哪个入口”；GDT 说明“那个代码段在哪里、能否进入”。段选择与权限检查仍由 CPU 完成。',
    { bridge: '再用 GDTR 查代码段', direction: '↔', gdtr: true, idtr: true, gdtRow: 1, idtRow: true, formula: '先查 IDT：0x6108 → 选择子 0x08、偏移 0x28；再查 GDT：0x1000 + 1 × 8 = 0x1008 → 基址 0xC000' }),
  step(2, '跳走之前，CPU 先记下回来要用的信息',
    'CPU 把原代码段、段内位置 0x0C 和状态保存到“栈”里。以后用代码段起点 0xC000 加上 0x0C，就能回到地址 0xC00C。',
    'return', '保存返回记录，然后把执行位置改成处理入口 0xC028。',
    '否则处理完事件以后，就不知道原程序应该从哪里继续了。栈是一种保存临时记录的方式：后放进去的先取出来。这里先把它看成返回记录区。',
    { bridge: '保存记录，再跳走', direction: '→', gdtr: true, idtr: true, saved: true, handler: true }),
  step(2, '现在真正执行处理程序，它才负责“处理事情”',
    '处理程序在地址 0xC028 开始执行。本例只做一件容易观察的事：把事件计数从 0 加到 1。',
    'handler', '执行处理程序里的指令，把内存地址 0x300A 的计数改为 1。',
    'GDTR、IDTR 和两张表不会替程序处理设备。它们帮助 CPU 找到入口、检查规则；真正的处理逻辑仍然由程序的指令完成。',
    { bridge: '处理程序写入计数 1', direction: '→', gdtr: true, idtr: true, saved: true, handler: true, counter: true }),
  step(2, '处理完成：从保存的记录恢复原来的执行',
    '处理程序执行“从中断返回”的指令，CPU 恢复保存的位置和状态，回到 0xC00C 继续原程序。',
    'return', '读取返回记录，恢复原来的代码段、执行位置与状态。',
    '进入处理程序要通过 IDT 找入口；返回时使用之前保存的记录。这个返回指令通常写作 IRET，32 位形式是 IRETD。',
    { bridge: '返回记录 → CPU', direction: '←', gdtr: true, idtr: true, saved: true, resumed: true, counter: true }),
  step(3, '用两个问题记住它们的分工',
    'GDTR 帮 CPU 找“段的规则”；IDTR 帮 CPU 找“事件的处理入口”。它们都只负责定位内存里的表。',
    'compare', '在刚才的 32 位教学模型里，选数据段先读段规则；处理事件则先找处理入口。',
    '寄存器记住表的位置，编号选出表项，表项提供规则或入口，CPU 再按这些信息继续执行。这才是整套机制的运行顺序。',
    { bridge: '位置 → 表项 → CPU 行为', direction: '↔', gdtr: true, idtr: true }),
  ...LINUX_STEPS,
];
ops[0].reset = true;
export const DESCRIPTOR_ACT = { id: 'descriptors', title: '从零理解段表与中断表', ops };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parts = ['先认识 CPU 与内存', '走通 GDTR → 数据', '走通 IDTR → 返回', '把机制连起来', 'Linux 实际怎样用'];
const table = (name, subtitle, headers, rows) => `<div class="basic-table"><h3>${name}<small>${subtitle}</small></h3><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr class="${r.on ? 'selected' : ''}">${r.cells.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
function gdt(l, compact = false) {
  return table('GDT · 段的规则表', '放在内存地址 0x1000；每项 8 字节', ['编号', '表项位置', '这一项描述什么'], (compact ? [1] : [0, 1, 2]).map(n => ({ on: l.gdtRow === n,
    cells: [n, hex(GDT_BASE + n * 8), ['空项（保留不用）', '代码：起点 0xC000 · 长度 200 字节 · 可执行', '数据：起点 0x3000 · 长度 100 字节 · 可读写'][n]] })));
}
function idt(l, compact = false) {
  return table('IDT · 事件的入口表', '放在内存地址 0x6000；本例每项 8 字节', ['事件编号', '表项位置', '处理程序入口'], (compact ? [33] : [0, 33, 34]).map(n => ({ on: n === 33 && l.idtRow,
    cells: [n, hex(IDT_BASE + n * 8), n === 33 ? '代码段 1 内，段内偏移 0x28' : '其他事件的入口（此处省略）'] })));
}
function cells(l) {
  return `<div class="basic-cells"><h3>一小段内存<small>每格 1 字节；上面是地址，下面是内容</small></h3><div class="basic-cell-row">${[0x3004, 0x3005, 0x3006].map(a => `<div class="${a === 0x3005 && l.cell ? 'selected' : ''}"><small>地址 ${hex(a)}</small><b>${a === 0x3005 ? 7 : 0}</b></div>`).join('')}</div></div>`;
}
function memory(l) {
  if (l.real) return linuxMemory(l);
  if (l.scene === 'memory') return cells(l) + '<p class="basic-memory-note">内存也可以放指令、表格和地址；格子里面并不全是普通数值。</p>';
  if (l.scene === 'cycle') return `<div class="basic-cycle"><h3>CPU 的工作循环</h3><ol><li><b>① 找位置</b>CPU 记着下一条指令的位置</li><li><b>② 取指令</b>从内存那个位置读出指令编码</li><li><b>③ 识别动作</b>按固定规则识别“选段、读取、计算……”</li><li><b>④ 执行并前进</b>完成动作，再取下一条；跳转会改变位置</li></ol><p>后面只跟踪两个动作：<strong>选一个数据段</strong>、<strong>处理一个事件</strong>。</p></div>`;
  if (l.scene === 'range') return `<div class="basic-range"><h3>这一片是数据段</h3><div class="range-bar"><span>起点 0x3000</span><b>100 字节 · 可以读写</b><span>最后 0x3063</span></div><p>合法偏移：0x00 ～ 0x63<br>偏移 0x05 = 从起点往后走 5 字节</p><div class="basic-outside">地址 0x3064 及以后：已经超出这个段</div></div>`;
  if (l.scene === 'gdt') return gdt(l);
  if (l.scene === 'read' || l.scene === 'probe') return `<div class="basic-range"><h3>真正的数据区域<small>与放在 0x1000 的 GDT 分开</small></h3><div class="range-bar"><span>0x3000</span><b>允许使用：0x3000 ～ 0x3063</b><span>0x3063</span></div></div>${cells(l)}${l.probe ? '<div class="basic-probe"><span>发一个访问请求：</span><button data-probe="5">读偏移 0x05</button><button data-probe="120">读偏移 0x78</button><div id="basicProbeResult" aria-live="polite">选一个请求，看看 CPU 怎样处理。</div></div>' : ''}`;
  if (l.scene === 'event') return `<div class="basic-program"><h3>先想清楚将来会遇到的问题</h3><div>原程序执行到某处之后……</div><div class="selected">地址 0xC00C：下一条需要执行的指令</div><p class="event-arrival">假设稍后收到设备事件 33</p><p>CPU 需要知道：去哪里处理？处理完如何回来？</p></div>`;
  if (l.scene === 'idt') return idt(l);
  if (l.scene === 'dispatch') return idt(l, true) + '<div class="basic-connect">↓ 选择子 0x08 内含编号 1 → 用 GDTR 算 0x1000 + 1 × 8 = 0x1008</div>' + gdt(l, true) + '<div class="basic-target">代码段起点 0xC000 + 偏移 0x28 = 处理入口 0xC028</div>';
  if (l.scene === 'return' || l.scene === 'handler') return `<div class="basic-stack"><h3>返回记录区 · 栈<small>这些信息保存在内存中</small></h3><div>已保存：<b>原代码段、段内偏移 0x0C、原状态</b></div><div>恢复后的位置：<b>0xC000 + 0x0C = 0xC00C</b></div></div><div class="basic-program"><h3>${l.resumed ? '回到原程序' : '事件处理程序'}</h3><div class="${!l.resumed ? 'selected' : ''}">0xC028：把事件计数加 1</div><div>然后：执行中断返回指令</div><div class="${l.resumed ? 'selected' : ''}">0xC00C：继续原来未做完的工作</div><p>地址 0x300A 的事件计数：<b>${l.counter ? '1（处理程序已经运行）' : '0（处理程序还未运行）'}</b></p></div>`;
  return `<div class="basic-summary"><h3>找段的规则</h3><p>GDTR 的表地址 → GDT 中选一项<br>→ 检查并缓存段规则 → 按规则访问数据</p><h3>找事件的处理入口</h3><p>IDTR 的表地址 → IDT 中选一项<br>→ 检查代码段 → 保存现场 → 处理 → 返回</p><a href="boot/descriptor-example.asm" download>理解流程以后，可下载汇编补充示例（使用另一组地址）</a></div>`;
}
let shown = -1;
export function renderDescriptorLesson(root, op, navigate) {
  if (shown === op.inAct && root.dataset.initialized) return;
  shown = op.inAct;
  root.dataset.initialized = 'true';
  const l = op.lesson;
  const registers = l.real ? linuxCpu(l) : `${l.gdtr ? `<div class="basic-register ${l.focus === 'gdtr' ? 'selected' : ''}"><b>GDTR</b><span>GDT 起点 <strong>0x1000</strong> · 最后偏移 0x17</span><small>只记表的位置与大小；不存整张表</small></div>` : ''}${l.idtr ? `<div class="basic-register ${l.focus === 'idtr' ? 'selected' : ''}"><b>IDTR</b><span>IDT 起点 <strong>0x6000</strong> · 最后偏移 0x7FF</span><small>编号由事件提供；位置由这个寄存器提供</small></div>` : ''}${l.cache ? `<div class="basic-register ${l.focus === 'cache' ? 'selected' : ''}"><b>当前数据段 · DS 与内部缓存</b><span>段起点 <strong>0x3000</strong> · 长度 100 字节</span><small>允许读写；这是查过 GDT 后记住的规则</small></div>` : ''}${l.register ? '<div class="basic-register selected"><b>一个普通寄存器</b><span>刚读出的数值：<strong>7</strong></span><small>保存在 CPU 内部，方便接下来计算</small></div>' : ''}`;
  root.innerHTML = `<header class="basic-heading"><div class="basic-parts">${parts.map((p,i) => `<button data-part="${i}" class="${l.part === i ? 'current' : ''}">${i+1}. ${p}</button>`).join('')}</div><h2>${esc(l.title)}</h2><span class="basic-scope">${l.real ? "Linux 6.12.112 源码说明 · 地址示意均为十六进制" : "32 位保护模式示意 · 地址与偏移：十六进制（0x）"}</span></header><div class="basic-world"><section class="basic-cpu"><h3>CPU<small>执行动作，内部有寄存器</small></h3><div class="basic-task"><small>这一刻，CPU 在做什么？</small><p>${esc(l.task)}</p></div>${registers || '<div class="basic-placeholder">先理解 CPU 与内存的关系，<br>稍后再给寄存器起名字。</div>'}${l.event ? `<div class="basic-request">${l.event === 'preview' ? '先准备：事件 33 的处理入口' : '控制器送来的事件编号：33'}</div>` : ''}${l.focus === 'request' ? '<div class="basic-request">程序要选：第 2 号段</div>' : ''}${l.handler || l.resumed ? `<div class="basic-request">执行位置：${l.resumed ? '0xC00C · 原程序' : '0xC028 · 处理程序'}</div>` : ''}</section><div class="basic-bridge"><span>${esc(l.bridge)}</span><b>${esc(l.direction || '→')}</b><small>箭头表示信息的流向</small></div><section class="basic-memory"><h3>内存<small>存放表、程序、数据和返回记录</small></h3>${memory(l)}</section></div><div class="basic-reason"><b>为什么要这样做？</b><p>${esc(l.why)}</p>${l.formula ? `<div class="basic-formula">${esc(l.formula)}</div>` : ''}</div><nav class="basic-nav"><button data-go="${op.inAct - 1}" ${op.inAct === 0 ? 'disabled' : ''}>← 回看上一步</button><span>${op.inAct + 1} / ${ops.length} · 可以停下来反复看</span><button class="basic-next" data-go="${op.inAct + 1}">${op.inAct + 1 < ops.length ? '下一步：' + esc(ops[op.inAct + 1].lesson.title) : '继续看真正的开机过程'} →</button></nav>`;
  root.onclick = e => {
    const next = e.target.closest('[data-go]');
    if (next) { navigate(Number(next.dataset.go)); return; }
    const part = e.target.closest('[data-part]');
    if (part) { navigate(ops.findIndex(o => o.lesson.part === Number(part.dataset.part))); return; }
    const probe = e.target.closest('[data-probe]');
    if (probe) {
      const offset = Number(probe.dataset.probe), allowed = offset >= 0 && offset < 100;
      const result = root.querySelector('#basicProbeResult');
      result.className = allowed ? 'allowed' : 'denied';
      result.textContent = allowed ? `允许：偏移 ${hex(offset)} 在 0x00～0x63 内 → 地址 ${hex(DATA_BASE)} + ${hex(offset)} = ${hex(DATA_BASE + offset)} → 读到 7。` : `阻止：偏移 ${hex(offset)} 超过 0x63 → 不去读取地址 ${hex(DATA_BASE + offset)} → 产生越界异常。`;
      root.querySelectorAll('[data-probe]').forEach(b => b.classList.toggle('selected', b === probe));
    }
  };
}
