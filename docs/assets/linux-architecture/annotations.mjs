import { terms, registers, asmTerms } from './annotation-terms.mjs'
import { extraTerms } from './annotation-extra.mjs'
import { assemblyPurpose } from './assembly-notes.mjs'

const keywords = new Set('if else for while do return switch case break continue goto struct union enum typedef static const volatile inline extern register auto signed unsigned void int long short char float double bool restrict sizeof typeof __typeof__ default asm __asm__ __volatile__'.split(' '))
const actions = { init: '初始化', setup: '建立配置', get: '获取', put: '释放所持引用/提交', alloc: '分配', free: '释放', add: '添加', del: '移除', remove: '移除', insert: '插入', read: '读取', write: '写入', lock: '加锁', unlock: '解锁', wait: '等待', wake: '唤醒', wakeup: '唤醒', copy: '复制', map: '映射', unmap: '解除映射', lookup: '查找', find: '查找', check: '检查', test: '检查', set: '设置', clear: '清除', update: '更新', register: '注册', unregister: '注销', enable: '启用', disable: '停用', flush: '刷新/清空', submit: '提交', end: '结束', start: '开始', stop: '停止', count: '计数', account: '记账', enqueue: '入队', dequeue: '出队', queue: '排队', notify: '通知', release: '释放', exit: '退出', finish: '完成', prepare: '准备', load: '装载', save: '保存', restore: '恢复', reset: '重置', recalc: '重新计算', revalidate: '重新验证', validate: '验证', attach: '绑定', detach: '解绑', drain: '排空', balance: '平衡', shrink: '收缩回收', migrate: '迁移', commit: '提交事务', trace: '跟踪', debug: '诊断', parse: '解析' }
const objects = { task: '任务', process: '进程', page: '页', pages: '页集合', folio: 'folio缓存单元', inode: '文件inode', file: '打开文件', files: '文件表', mm: '地址空间', mmap: '映射', pte: '页表项', pmd: '中间层页表项', pgd: '顶层页表项', vma: '虚拟映射区域', rq: '运行队列', entity: '公平调度实体', curr: '当前实体', cpu: 'CPU', cpus: 'CPU集合', irq: '中断', irqs: '中断', timer: '定时器', tick: '调度时钟', rcu: 'RCU', buf: '缓冲', buffer: '缓冲', tty: '终端', ldisc: '行规程', work: '工作对象', worker: '工作线程', pool: '线程池', queue: '队列', request: '块请求', req: '请求', bio: '块I/O', super: '超级块', dentry: '目录项', path: '路径', name: '名字', pid: '进程标识', signal: '信号', state: '状态', flags: '标志', bit: '位', ref: '引用', refcount: '引用计数', journal: '日志', transaction: '事务', commit: '日志提交', writeback: '写回', slab: '对象缓存', cache: '缓存', lru: 'LRU队列', zone: '内存区域', node: '节点', memory: '内存', mem: '内存', time: '时间', clock: '时钟', event: '事件', input: '输入', output: '输出', char: '字符', key: '键值', device: '设备', dev: '设备', disk: '磁盘', block: '块', blocks: '块集合', mount: '挂载', root: '根', user: '用户态', kernel: '内核', thread: '线程' }
const contexts = [
  [/drivers\/tty\/n_tty/, '本函数处理终端行规程：要区分已接收字符、可交付整行、回显与等待通知。'],
  [/kernel\/sched/, '本函数参与调度：状态变为可运行、队列选择与真正切换执行现场是不同阶段。'],
  [/mm\/memory|arch\/x86\/mm\/fault/, '本函数参与缺页/映射：先验证权限和并发状态，再按故障类型安装映射或返回错误。'],
  [/mm\/filemap|mm\/readahead/, '本函数参与页缓存I/O：缓存对象存在、数据就绪和PTE已安装是不同状态。'],
  [/virtio|block\//, '本函数参与块请求/virtio交接：提交将请求交给设备，完成通过回调及状态传回。'],
  [/fs\/jbd2/, '本函数参与日志事务：内存更新、日志提交持久化和检查点写回各有完成时刻。'],
  [/kernel\/rcu/, '本函数参与RCU：旧读者跨过宽限期后才可执行安全回收，引用计数仍可能限制最终释放。'],
  [/workqueue/, '本函数协调异步工作；排队/唤醒与worker实际执行回调分开。'],
  [/vmscan|shrinker/, '本函数参与内存回收，按页状态、引用、写回进度和分配目标选择可释放页面。'],
  [/init\/|head64|kernel\/setup/, '本函数处于启动阶段，初始化次序及资源自举决定后续代码能否安全运行。'],
]
function namedMeaning(name) {
  const words = name.replace(/^_+/, '').split('_'), a = words.filter(x => actions[x]).map(x => actions[x]), o = [...new Set(words.filter(x => objects[x]).map(x => objects[x]))]
  return a.length ? `命名阅读：${a.join('、')}${o.length ? '，涉及' + o.join('、') : ''}；具体行为以本地定义和分支为准。` : o.length ? '命名中的对象：' + o.join('、') + '；完整行为需结合本地定义和分支确认。' : ''
}
function cleanLines(lines) {
  let block = false
  return lines.map(raw => {
    let out = '', quote = '', comment = ''
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i], d = raw[i + 1]
      if (block) { comment += c; if (c === '*' && d === '/') { block = false; comment += d; i++ } continue }
      if (quote) { out += c; if (c === '\\') out += raw[++i] ?? ''; else if (c === quote) quote = ''; continue }
      if (c === '"' || c === "'") { quote = c; out += c; continue }
      if (c === '/' && d === '*') { block = true; comment += '/*'; i++; continue }
      if (c === '/' && d === '/') { comment += raw.slice(i); break }
      out += c
    }
    return { code: out.trim(), comment: comment.trim(), raw }
  })
}
function coreMeaning(name, file) {
  // Interpret ambiguous short names in their declaration context.
  if (['c', 'p', 'prev', 'next', 'q', 'wq', 'port', 'task', 'head', 'h', 'dev'].includes(name)) return terms[name]
  if (name === 'deadline' && !file.includes('sched/fair')) return '截止值/到期值；具体时钟单位与比较规则见当前对象类型。'
  if (name === 'ldata' && !file.includes('n_tty')) return '当前局部数据对象，类型和用途以本函数声明为准。'
  return extraTerms[name] || terms[name] || ''
}
function selectTag(name, d, catalog, isCall, member, ownerType, isType) {
  let all = catalog[name] || []
  all = all.filter(t => t.kind !== 'label' && (d.file.endsWith('.S') || !t.file.endsWith('.S')) && (t.kind !== 'local' || (t.file === d.file && t.line >= d.a && t.line <= d.b)))
  if (member) all = all.filter(t => ['member', 'generated'].includes(t.kind) && (!ownerType || t.scope === 'struct:' + ownerType || t.scope === 'union:' + ownerType || t.kind === 'generated'))
  else if (isCall) all = all.filter(t => ['function', 'prototype', 'macro', 'member', 'generated'].includes(t.kind))
  else if (isType) all = all.filter(t => ['struct', 'union', 'enum', 'typedef'].includes(t.kind))
  else all = all.filter(t => t.kind !== 'member' && t.kind !== 'declaration')
  const score = t => (t.file === d.file ? 100 : t.file.startsWith('include/linux/') ? 30 : t.file.startsWith('arch/x86/include/') ? 20 : 0) +
    (t.file === d.file && t.line >= d.a && t.line <= d.b ? 100 : 0) +
    (isCall && t.kind === 'function' ? 35 : 0) + (isCall && t.decl === '#define ' + name + ' ' + name ? -100 : 0) + (t.file === 'include/linux/types.h' || t.file === 'include/asm-generic/int-ll64.h' ? 45 : 0) + (t.file.startsWith('include/linux/raid/') ? -40 : 0)
  const sorted = all.sort((a, b) => score(b) - score(a) || a.line - b.line)
  if (member && !ownerType && new Set(sorted.map(t => t.scope)).size > 1) return null
  return sorted[0]
}
const kindNames = { function: '函数', prototype: '函数声明', macro: '宏', local: '局部变量', variable: '变量', member: '结构成员', typedef: '类型别名', struct: '结构类型', union: '联合类型', enum: '枚举类型', enumerator: '枚举常量', config: '编译配置', generated: '宏生成接口', declaration: '声明' }
function declarationFor(name, d) {
  const signatureEnd = d.lines.findIndex(x => x.includes('{'))
  const signature = d.lines.slice(0, signatureEnd + 1).join(' ').trim()
  const params = signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')'))
  const param = params.split(',').find(x => new RegExp('\\b' + name + '\\s*(?:\\[[^\\]]*\\])?\\s*$').test(x.trim()))
  if (param && !/^(?:struct|union|enum)\s+\w+$/.test(param.trim())) {
    const offset = d.lines.slice(0, signatureEnd + 1).findIndex(x => new RegExp('\\b' + name + '\\s*(?:[,)]|$)').test(x))
    return { kind: '参数', decl: param.trim(), file: d.file, line: d.a + Math.max(0, offset) }
  }
  return null
}
function ownerTypeFor(owner, d, catalog) {
  if (!owner) return ''
  if (owner === 'current') return 'task_struct'
  const p = declarationFor(owner, d)
  const t = p || selectTag(owner, d, catalog, false, false)
  return /(?:struct|union)\s+(\w+)/.exec(t?.decl || '')?.[1] || ''
}
function lineAction(code, i, d, all) {
  if (!code) return all[i].raw.trim() ? '原作者注释行，说明附近代码的前提、约束或设计原因；完整原文保留在上方。' : '空行：分隔逻辑段。'
  if (/^#/.test(code)) {
    const m = /^#\s*(\w+)\s*(.*)/.exec(code)
    const op = m?.[1], rest = m?.[2] || ''
    if (/if|ifdef|ifndef/.test(op)) return `编译条件“${rest}”：只把满足该配置的代码编入内核。`
    if (op === 'else' || op === 'elif') return '切换预处理条件的另一编译分支；不同内核配置可能只保留其中一支。'
    if (op === 'endif') return '结束上面的条件编译范围。'
    if (op === 'define') return '定义预处理宏“' + rest + '”，编译时展开。'
    return '预处理指令，影响编译阶段：' + code
  }
  const signatureEnd = all.findIndex(x => x.code.includes('{'))
  if (i < signatureEnd && !/;\s*$/.test(code)) return '函数定义/参数列表：声明入口、返回类型或参数；参数类型与本行符号解释见下方。'
  if (code === '{') return '开始当前函数/控制块；花括号确定作用域。'
  if (/^}\s*;?$/.test(code)) return '结束当前作用域/控制块；若为函数末尾，控制按该函数的返回约定结束。'
  if (/^(?:else\b|}\s*else\b)/.test(code)) return '与此分支配对的if条件为假时执行；' + (code.includes('if') ? '这里继续检查else if条件：' + code.replace(/^}\s*/, '') : '进入else分支。')
  if (/^if\s*\(/.test(code)) return '分支检查：' + code.replace(/\s*\{\s*$/, '') + '；条件为真才执行后续受控语句，未带花括号时通常只控制下一条完整语句。'
  if (/^for\s*\(/.test(code)) return 'for循环：依次执行初始化、条件检查、循环体及步进；本行表达式规定迭代范围和退出条件。'
  if (/^while\s*\(/.test(code)) return 'while循环条件：' + code + '；满足才进入/继续循环，循环中状态可能被当前代码或并发事件改变。'
  if (/^do\b/.test(code)) return '开始do循环，先执行循环体，再在末尾while检查是否继续。'
  if (/^switch\b/.test(code)) return '按“' + code.replace(/^switch\s*\(|\)\s*\{$/g, '') + '”选择匹配case；需看break/return确认是否穿透后续分支。'
  if (/^case\b|^default:/.test(code)) return 'switch分支标签：' + code + '；case匹配对应值，其余值由default承接。'
  if (/^[A-Za-z_]\w*:$/.test(code)) return '跳转标签“' + code.slice(0, -1) + '”：goto可以到达这里，常用于分级撤销已取得的资源。'
  if (/\bgoto\b/.test(code)) return '跳到标号“' + code.match(/goto\s+(\w+)/)?.[1] + '”继续执行；清理/重试路径由标签后的语句决定。'
  if (/^return\b/.test(code)) return '结束本函数' + (code.replace(/^return\s*|;$/g, '') ? '并返回“' + code.replace(/^return\s*|;$/g, '') + '”；返回值可能是结果、长度、指针或错误码，取决于返回类型。' : '；void返回将控制权交还调用者。')
  if (/^break\b/.test(code)) return '退出最近的循环或switch，接着执行其后的语句。'
  if (/^continue\b/.test(code)) return '跳过本轮循环剩余语句，进入循环步进/下一次条件检查。'
  if (/^(?:struct|unsigned|int|long|bool|u\d+|s\d+|size_t|ssize_t|loff_t|pgoff_t|gfp_t|[A-Za-z_]\w*_t)\b/.test(code) && !/^[\w]+\s*\(/.test(code)) return '声明本地变量/类型' + (/(?<![=!<>])=(?!=)/.test(code) ? '并用右侧表达式初始化；取得的指针/引用后续需按对应生命周期规则使用。' : '；变量需在读取前获得有效赋值，初始状态由初始化代码决定。')
  const assign = /(?<![=!<>])(?:\|=|&=|\^=|\+=|-=|\*=|\/=|=(?!=))/.exec(code)
  if (assign) {
    const left = code.slice(0, assign.index).trim(), right = code.slice(assign.index + assign[0].length).replace(/;\s*$/, '').trim()
    const meanings = { '=': '写入/更新', '|=': '按位OR并写回：设置掩码包含的位，保留其它位', '&=': '按位AND并写回：仅保留掩码允许的位', '^=': '按位XOR并写回：翻转掩码对应的位', '+=': '增加并写回', '-=': '减少并写回', '*=': '乘以右侧值并写回', '/=': '除以右侧值并写回' }
    return `${meanings[assign[0]] || '复合更新'}“${left}”，右侧为“${right}”；右侧先求值，成员/索引及调用含义见本行符号。`
  }
  if (/\+\+|--/.test(code)) return '递增/递减本行指定的计数或指针，配合循环/进度维护；步长由类型和操作符决定。'
  const calls = [...code.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map(m => m[1]).filter(x => !keywords.has(x))
  if (calls.length) return '执行/展开本行“' + calls.join('、') + '”；括号内传入参数，宏展开与回调调用的作用见本行符号说明。'
  if (/^[)}\],]+[;,]?$/.test(code)) return '收束前面跨行表达式/参数列表或代码块；需与前行连读。'
  return '这是前后相连的表达式或参数部分：“' + code + '”；与相邻行构成完整语句，操作数/类型/成员含义见下方。'
}
const asmActions = {
  cld: '清DF方向标志，明确后续字符串存储按地址递增。',
  cli: '清IF，关闭本CPU可屏蔽中断；页表、段和栈转换期间，异常和NMI仍按各自机制处理。',
  mov: '按操作数宽度复制源值到目标；AT&T语法为源在左、目标在右。',
  lea: '计算有效地址到目标寄存器；用于栈/页表地址和重定位计算。',
  push: '把操作数压入向低地址增长的栈，随后调整栈指针；这里也可为远返回准备CS和目标地址。',
  pop: '从当前栈顶取值到目标并推进栈指针；与call配合时可取得当前实际运行地址。',
  call: '保存下一条指令地址并跳入目标；返回会回到调用之后，本入口用局部call/pop获得实际位置。',
  sub: '从目标减去源并更新算术标志；重定位计算和循环计数用这些结果。',
  add: '将源加到目标并写回，更新算术标志；此处用于地址、偏移或页表项高半部。',
  xor: '逐位XOR并写回；同寄存器XOR得到0，明确初始化临时值。',
  or: '逐位OR并写回，设置掩码位同时保留已有其它位。',
  and: '逐位AND并写回，清除掩码禁止的位；对齐计算可清掉地址低位。',
  not: '逐位取反；这里用于把alignment-1转换成对齐掩码。',
  dec: '将目标减1，零标志反映结果是否为0；常与jnz组合控制固定次数循环。',
  cmp: '按目标减源的结果更新标志，保留操作数原值；后面的条件跳转使用这些标志。',
  test: '按位AND的结果更新标志，保留操作数原值；同寄存器test通常判断是否为0。',
  bts: '按位编号设置目标位，CF接收该位原值；编号n对应掩码1<<n。',
  shr: '逻辑右移，空出的高位补0；这里把64位地址高半部移到wrmsr需要的edx。',
  lgdt: '从内存加载GDTR的界限与表基址；各段寄存器的隐藏描述缓存由后续段装载刷新。',
  lldt: '加载局部描述符表选择子；这里加载0使LDT处于停用状态。',
  ltr: '加载任务寄存器中的TSS选择子，建立当前TSS关联。',
  rdmsr: '读ECX指定的MSR，结果分为EDX高32位与EAX低32位；需特权并遵守CPU支持条件。',
  wrmsr: '把EDX:EAX组合的64位值写入ECX指定MSR；本入口更新EFER或GSBASE。',
  lret: '远返回：从栈恢复指令指针和CS，使代码段属性真正切换；不同后缀决定操作数宽度。',
  jmp: '将控制权直接转移到目标；带*的是间接目标。',
  jnz: 'ZF为0时跳转，即使用前次test/cmp/算术指令留下的零标志。',
  jz: 'ZF为1时跳转，即前次结果为零。', je: 'ZF为1时跳转，通常表示前次cmp相等。',
  jae: 'CF为0时按无符号大于等于关系跳转；此处按无符号关系比较装载地址。',
  rep: 'REP重复后面的字符串指令，次数由ECX提供；stosl把EAX的32位值写到目标，DF清零使EDI向高地址推进。',
}
function asmExplain(code, raw) {
  if (!code) return raw.trim() ? '汇编原作者注释，描述启动前提、模式转换或安全原因；完整原文保留在上方。' : '空行：分隔启动阶段。'
  if (code.startsWith('#')) return lineAction(code, 0, {}, [{ raw }])
  if (/^SYM_.*START/.test(code)) return '符号起点宏，导出启动入口并生成所需类型/布局元数据。'
  if (/^SYM_.*END/.test(code)) return '符号终点宏，标明入口范围供链接/工具使用。'
  if (/^UNWIND_HINT|^ANNOTATE_/.test(code)) return asmTerms[code.split(/[ (]/)[0]] || '供汇编工具使用的元数据标注。'
  const label = /^(\d+|\.\w+):\s*/.exec(code)
  const prefix = label ? `定义标签${label[1]}，供跳转定位；` : ''
  if (label) code = code.slice(label[0].length)
  if (!code) return prefix + '此行只定义跳转位置。'
  const m = /^(\w+)\s*(.*)/.exec(code), op = m?.[1] || '', arg = m?.[2] || ''
  const base = asmActions[op] ? op : op.replace(/[bwlq]$/, '')
  let text = prefix + (asmActions[base] || '汇编指令/宏“' + op + '”，具体展开以本地定义为准。')
  if (/[bwlq]$/.test(op) && ['mov', 'lea', 'push', 'pop', 'sub', 'add', 'xor', 'or', 'and', 'not', 'dec', 'cmp', 'test', 'bts', 'shr', 'lret'].includes(base)) text += ' 后缀' + op.at(-1) + '表示' + ({ b: '8', w: '16', l: '32', q: '64' }[op.at(-1)]) + '位操作。'
  if (arg) text += ' 本行操作数：' + arg + '。'
  if (/\b\d+[fb]\b/.test(arg)) text += ' 数字标签f向前找、b向后找最近同号标签，用于定位局部跳转目标。'
  if (/\$/.test(arg)) text += ' $前缀表示立即数/符号值；无$的地址表达式可能读取内存，lea例外。'
  if (/\*/.test(arg) && base === 'jmp') text += ' *表示从指定内存/寄存器取得跳转目标；此处转到公共启动代码的内核虚拟地址。'
  if (/0x1007/.test(arg)) text += ' 0x1000是下一4KiB页表位置，低0x7设置present/write/user；最终访问还受下一层页项约束。'
  if (/0x00000183/.test(arg)) text += ' 0x183包含present、writable、PS大页和global位，建立2MiB恒等映射页目录项。'
  if (/\$2048/.test(arg)) text += ' 2048个2MiB页项覆盖早期4GiB地址范围。'
  if (/\$0x00200000/.test(arg)) text += ' 每个下一大页的物理起点增加2MiB。'
  if (/\$8,\s*%edi/.test(arg)) text += ' 每个64位页表项占8字节，移到下一项。'
  if (/\$32/.test(arg) && base === 'sub') text += ' 加密位位于bit31之上，减32转为页表高32位内的位编号。'
  if (/\b2\(%eax\)/.test(arg)) text += ' 32位GDTR描述的前2字节是界限，后4字节是基址；写+2位置修正实际GDT基址。'
  if (/rva\(1b\),\s*%ebp/.test(arg)) text += ' call压入的实际地址减去标签相对偏移，得到映像实际装载基址。'
  if (/%cr3\b/.test(arg) && base === 'mov') text += ' 页表根及加密修饰须先准备好；新页表须覆盖当前代码和栈，以保证装载后的地址翻译连续。'
  return text
}
const overrides = {
  n_tty_receive_handle_newline: [
    [/set_bit/, '在read_head对应的环形槽设置行结束位；先记录边界，再写入换行并发布完整行。'],
    [/put_tty_queue/, '将换行字节c写入输入缓冲并推进接收边界read_head；新边界由后续release写入canon_head发布给读者。'],
    [/smp_store_release/, '把新的read_head发布到canon_head，声明一整行已就绪；release使读者经配对读取看到边界时也能看到之前写入的字符。'],
    [/kill_fasync/, '向tty->fasync登记者发送SIGIO，以POLL_IN说明可读原因；这条异步信号路径与下面的等待队列唤醒不同。'],
    [/wake_up_interruptible_poll/, '通知tty->read_wait中的合适等待者，并传递EPOLLIN|EPOLLRDNORM可读位图；shell只是变为可运行，仍需调度并重检整行。'],
  ],
  wait_woken: [
    [/^set_current_state/, '先发布mode指定的睡眠状态并提供完整排序，与唤醒侧的屏障配对；避免检查结束后通知到达、任务却永久睡下。'],
    [/^if/, '等待项WQ_FLAG_WOKEN为0且内核线程的停止/park检查为假时，执行下一条实际睡眠；已收到通知则跳过等待。'],
    [/schedule_timeout/, '按剩余timeout等待到唤醒/超时并更新剩余值；调度恢复后从本调用的暂停处继续。'],
    [/__set_current_state/, '等待结束后恢复TASK_RUNNING；这里的较弱状态设置依赖等待协议已有的同步条件。'],
    [/smp_store_mb/, '清WQ_FLAG_WOKEN并执行完整屏障，与唤醒侧标志写入协调；外层仍要重检数据条件，避免清标志与新通知竞态。'],
  ],
  folio_end_read: [
    [/mask =/, '先将掩码设为1<<PG_locked，后面用XOR解除已锁定状态；PG_locked是位编号。'],
    [/BUILD_BUG_ON/, '编译期要求PG_uptodate处在最低字节，满足x86该原子标志操作的实现约束。'],
    [/VM_BUG_ON_FOLIO/, '检查本接口前提：folio应仍锁定且尚未uptodate；违反时按调试配置报警。XOR更新依赖这些原状态。'],
    [/if \(likely\(success\)/, 'success为真才把数据就绪位加入待更新掩码；likely只是分支概率提示，失败同样必须解除锁定。'],
    [/mask \|=/, '将PG_uptodate位OR进mask；后续同一次标志更新在成功时发布数据就绪并清locked。'],
    [/folio_xor_flags_has_waiters/, '按mask翻转已知初始状态，返回是否有该folio的位等待者；仅有等待者时执行后续唤醒。'],
    [/folio_wake_bit/, '唤醒等待PG_locked解除的任务；恢复后的读路径用uptodate或错误状态判定读取结果。'],
  ],
  update_deadline: [
    [/^if.*vruntime.*deadline/, '以有符号虚拟时间差判断本次请求是否用完；比较的是EEVDF公平实体的虚拟时间。'],
    [/se->deadline\s*=/, '用当前vruntime加上按权重折算的请求slice生成新虚拟deadline；下一次选取还要满足eligible资格。'],
    [/resched_curr/, '请求本CPU在安全点重新调度；内核栈由后续任务切换路径更换。'],
  ],
  tty_flip_buffer_push: [[/tty_flip_buffer_commit/, '先提交tail中已写入的字符，使消费者只能读取已经发布的内容。'], [/queue_work/, '把buf->work排入system_unbound_wq，worker稍后执行flush_to_ldisc并调用行规程。']],
  fd_install: [[/rcu_assign_pointer/, '以RCU发布方式把file写进fdtable槽；初始化数据必须先可见，fd指向打开实例。']],
  wp_page_copy: [[/pte_same/, '持页表锁重检原PTE；映射仍与原值一致时安装复制页，否则走对应撤销/退出路径。']],
}

export function annotate(snippets, catalog, callNotes) {
  const symbolIds = new Map()
  const annotations = {}, glossary = {}, stats = { lines: 0, asmLines: 0, symbols: 0, declarationBacked: 0, contextualOnly: new Set() }
  for (const [ref, d] of Object.entries(snippets)) {
    const ls = cleanLines(d.lines), asm = d.file.endsWith('.S'), fn = ref.split(':').at(-1)
    const purpose = (callNotes[ref] ? "本步关注：" + callNotes[ref] + "。 " : "") + (contexts.find(([r]) => r.test(d.file))?.[1] || '本段作用需结合所属步骤及前后控制流阅读。')
    const localCache = new Map()
    function symbol(name, isCall, member, ownerType, isType) {
      const key = name + ':' + (isType ? 'type' : member ? 'member:' + ownerType : isCall ? 'call' : 'value')
      if (localCache.has(key)) return localCache.get(key)
      const reg = asm && registers[name]
      const param = !asm && !member && !isType && !isCall && declarationFor(name, d)
      const labelIndex = d.lines.findIndex(x => x.trim() === name + ':')
      const label = labelIndex >= 0 ? { kind: 'label', decl: name + ':', file: d.file, line: d.a + labelIndex } : null
      const tag = label || param || (reg || ["NULL", "true", "false"].includes(name) ? null : selectTag(name, d, catalog, isCall, member, ownerType, isType))
      const decl = param?.decl || tag?.decl
      const exact = (asm && asmTerms[name]) || coreMeaning(name, d.file) || (callNotes[d.file + ':' + name])
      let meaning = reg || exact || (label ? '本函数内部跳转标签，goto ' + name + ' 从此处继续；常用于资源撤销、退出或重试，按标签后的语句判断具体动作。' : tag?.kind === 'config' ? '内核编译配置：' + (tag.prompt || name) + '；是否启用决定哪些分支编入。' : /^trace_/.test(name) ? '跟踪点接口，用于记录' + (namedMeaning(name.slice(6)) || name.slice(6)) + '；事件采集由配置和运行期开关控制。' : /^folio_(test|set|clear)_/.test(name) ? 'folio状态接口：' + ({test:'检查',set:'设置',clear:'清除'}[/^folio_(test|set|clear)_/.exec(name)[1]]) + ' ' + name.replace(/^folio_(test|set|clear)_/, '') + ' 标志；就绪、锁、脏页及写回状态分别表达对应进度。' : /^(buffer_|set_buffer_|clear_buffer_)/.test(name) ? 'buffer_head状态位接口：' + (name.startsWith('set_') ? '设置' : name.startsWith('clear_') ? '清除' : '检查') + ' ' + name.replace(/^(?:set_|clear_)?buffer_/, '') + ' 状态；设备I/O由提交和完成路径处理。' : namedMeaning(name))
      const kind = label ? '跳转标签' : reg ? '寄存器' : param ? '参数' : ['NULL', 'true', 'false'].includes(name) ? '常量' : tag ? kindNames[tag.kind] || tag.kind : member ? '成员访问' : isCall ? '调用/宏/回调标识符' : /^[A-Z][A-Z\d_]*$/.test(name) ? '常量/配置标识符' : '表达式标识符'
      if (!meaning) meaning = tag ? `${kind}${tag.scope ? '，所属' + tag.scope : ''}；具体类型/值见本地声明。` : `${kind}，在本行作为操作数或类型使用；轻量声明目录的定位结果待确认，具体含义需结合当前作用域核实。`
      if (decl && !isCall && !isType && !reg && !label) {
        const type = /(?:struct|union)\s+(\w+)/.exec(decl)?.[1]
        const typeMeaning = type && (extraTerms[type] || terms[type] || extraTerms[type.replace(/_struct$/, '')] || terms[type.replace(/_struct$/, '')])
        meaning += type ? ' 声明类型为' + type + (typeMeaning ? '：' + typeMeaning : '，用于该子系统对象的状态/操作管理。') : /\b(?:bool)\b/.test(decl) ? ' 声明为布尔值，用于真假条件。' : /\b(?:u8|char)\b/.test(decl) ? ' 声明含字节/字符类型，读取或写入需尊重其位宽。' : /\b(?:unsigned|int|long|size_t|u32|u64)\b/.test(decl) ? ' 声明为整数/计数或位值类型，单位由本行使用处决定。' : ''
        if (/\*/.test(decl)) meaning += ' 含指针声明：它保存对象地址，使用前需保证非空、有效及生命周期受保护。'
      }
      if (!exact && !reg && !label && tag && isCall) meaning += ' 此处' + (tag.kind === 'macro' ? '为编译宏展开，具体动作以宏定义为准。' : '按声明调用/使用；锁、返回值及错误分支需看实现。')
      const id = [name, kind, tag?.file || '', tag?.line || '', decl || '', meaning].join('|')
      // Sequential IDs let repeated declarations share one glossary record.
      let gid = symbolIds.get(id)
      if (!gid) {
        gid = 's' + Object.keys(glossary).length
        glossary[gid] = { name, kind, meaning, ...(decl ? { decl } : {}), ...(tag ? { file: tag.file, line: tag.line, ...(tag.doc ? { doc: tag.doc } : {}) } : {}) }
        symbolIds.set(id, gid)
        if (tag || param || reg || exact) stats.declarationBacked++
        else stats.contextualOnly.add(name)
      }
      localCache.set(key, gid)
      return gid
    }
    annotations[ref] = ls.map(({ code, raw, comment }, i) => {
      let text = asm ? asmExplain(code, raw) : lineAction(code, i, d, ls)
      if (!asm && code) for (const [pattern, note] of overrides[fn] || []) if (pattern.test(code)) { text = note; break }
      const asmPurpose = asm && assemblyPurpose(d.file, code)
      if (asmPurpose) text += ' 目的与原因：' + asmPurpose
      if (i === 0) text += ' 本函数目的：' + purpose
      const withoutStrings = code.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' ')
      const ids = []
      for (const m of withoutStrings.matchAll(/\b[A-Za-z_]\w*\b/g)) {
        const name = m[0]
        if (keywords.has(name)) continue
        if (asm && (/^SYM_/.test(name) || /^\.\w+:$/.test(code) || /^(mov|lea|push|pop|sub|add|xor|or|and|not|dec|cmp|test|bts|shr|lret)[bwlq]?$/.test(name) || asmActions[name] || name === 'stosl' || /^(ifdef|endif|else|ifndef)$/.test(name))) continue
        const before = withoutStrings.slice(0, m.index), after = withoutStrings.slice(m.index + name.length)
        const member = /(?:->|\.)\s*$/.test(before)
        const owner = /([A-Za-z_]\w*)(?:->|\.)\s*$/.exec(before)?.[1]
        const ownerType = ownerTypeFor(owner, d, catalog)
        const isType = /(?:struct|union|enum)\s+$/.test(before)
        const id = symbol(name, /^\s*\(/.test(after), member, ownerType, isType)
        if (!ids.includes(id)) ids.push(id)
      }
      if (comment && code) text += ' 本行还有作者行内注释，其原文随代码保留。'
      if (/<<|>>/.test(code) && !asm) text += ' <<和>>分别为左移/右移，常把位编号转为掩码；位宽与有符号性由类型决定。'
      if (/\b(?:smp_|rcu_assign_pointer|READ_ONCE|WRITE_ONCE)/.test(code) && !asm) text += ' 注意：内存顺序、互斥与对象生命周期各由对应的同步机制保证。'
      if (!asm && code.includes('->')) text += ' ->通过指针访问成员，左侧对象必须仍有效。'
      if (!asm && /(?<!&)&(?!&|=)/.test(code)) text += ' 单个&在对象前取地址，在两值之间按位AND；具体语义由表达式位置决定。'
      if (!asm && /(?<!\|)\|(?!\||=)/.test(code)) text += ' 单个|按位OR，常组合多个事件/属性位。'
      if (!asm && /~/.test(code)) text += ' ~逐位取反，常用来构造清位掩码。'
      stats.lines++; if (asm) stats.asmLines++
      return { text, symbols: ids }
    })
  }
  stats.symbols = Object.keys(glossary).length
  return { annotations, glossary, stats: { ...stats, contextualOnly: [...stats.contextualOnly].sort() } }
}
