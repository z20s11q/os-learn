/**
 * GDB/MI 记录解析器（纯函数，可单测）。
 *
 * 依据总体方案 6.1 与 T03b：必须解析 token、结果记录、异步 stopped/running、
 * 流输出、转义字符串和错误，并按目标描述发现寄存器，寄存器编号由目标描述提供。
 *
 * MI 记录语法：
 *   [token] output-type class [ , results ]
 *   output-type: '~' console-stream '@' target-stream '&' log-stream
 *                '+' status '*' exec-async '=' notify-async '^' result '#' flush
 * 字符串是 C 字符串（带 \" \\ \n \t \r \e \a \b \f \v 与八进制转义），
 * 结果为树形：value = c-string | tuple | list | bare-word。
 */

const C_ESCAPES = {
  n: '\n',
  t: '\t',
  r: '\r',
  e: '\x1b',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '"': '"',
  '\\': '\\',
  "'": "'",
};

/** 解析 C 字符串内容（已去除首尾引号）。 */
export function unescapeCString(raw) {
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character !== '\\') {
      out += character;
      continue;
    }
    const next = raw[index + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    index += 1;
    if (Object.hasOwn(C_ESCAPES, next)) {
      out += C_ESCAPES[next];
      continue;
    }
    if (next >= '0' && next <= '7') {
      let octal = next;
      while (octal.length < 3 && raw[index + 1] >= '0' && raw[index + 1] <= '7') {
        index += 1;
        octal += raw[index];
      }
      out += String.fromCharCode(Number.parseInt(octal, 8));
      continue;
    }
    // 未知转义：保留字符本身，避免丢信息
    out += next;
  }
  return out;
}

function skipWhitespace(text, position) {
  while (position < text.length && /\s/.test(text[position])) position += 1;
  return position;
}

function parseString(text, position) {
  // position 指向起始引号
  let index = position + 1;
  let raw = '';
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      raw += character + (text[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (character === '"') {
      return { value: unescapeCString(raw), next: index + 1 };
    }
    raw += character;
    index += 1;
  }
  // 未闭合：按已有内容返回，由上层判为不完整
  return { value: unescapeCString(raw), next: text.length };
}

function parseBareWord(text, position) {
  let index = position;
  while (index < text.length && !',}]'.includes(text[index])) index += 1;
  return { value: text.slice(position, index), next: index };
}

/** 尝试解析 `name=` 前缀；命名结果匹配失败时返回 null。 */
function tryParseName(text, position) {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=/.exec(text.slice(position));
  if (!match) return null;
  return { name: match[1], next: position + match[0].length };
}

export function parseValue(text, position = 0) {
  const start = skipWhitespace(text, position);
  const character = text[start];
  if (character === '"') return parseString(text, start);
  if (character === '{') return parseTuple(text, start);
  if (character === '[') return parseList(text, start);
  return parseBareWord(text, start);
}

function parseTuple(text, position) {
  let index = position + 1;
  const unnamed = [];
  const named = {};
  let sawName = false;
  for (;;) {
    index = skipWhitespace(text, index);
    if (text[index] === '}') {
      index += 1;
      break;
    }
    if (index >= text.length) break;
    const name = tryParseName(text, index);
    if (name) {
      sawName = true;
      const parsed = parseValue(text, name.next);
      named[name.name] = parsed.value;
      index = skipWhitespace(text, parsed.next);
    } else {
      const parsed = parseValue(text, index);
      unnamed.push(parsed.value);
      index = skipWhitespace(text, parsed.next);
    }
    if (text[index] === ',') {
      index += 1;
      continue;
    }
    if (text[index] === '}') {
      index += 1;
      break;
    }
    if (index >= text.length) break;
  }
  if (!sawName) return { value: unnamed, next: index };
  // 混合形态：命名项用名字，未命名项用序号字符串，保留全部信息
  const result = { ...named };
  unnamed.forEach((value, position_) => {
    result[String(position_)] = value;
  });
  return { value: result, next: index };
}

function parseList(text, position) {
  let index = position + 1;
  const items = [];
  for (;;) {
    index = skipWhitespace(text, index);
    if (text[index] === ']') {
      index += 1;
      break;
    }
    if (index >= text.length) break;
    const parsed = parseValue(text, index);
    items.push(parsed.value);
    index = skipWhitespace(text, parsed.next);
    if (text[index] === ',') {
      index += 1;
      continue;
    }
    if (text[index] === ']') {
      index += 1;
      break;
    }
    if (index >= text.length) break;
  }
  return { value: items, next: index };
}

/** 解析 `name=value,name=value` 形式的结果列表。 */
export function parseResults(text, position = 0) {
  const results = {};
  let index = skipWhitespace(text, position);
  while (index < text.length) {
    const name = tryParseName(text, index);
    if (!name) break;
    const parsed = parseValue(text, name.next);
    results[name.name] = parsed.value;
    index = skipWhitespace(text, parsed.next);
    if (text[index] === ',') index += 1;
    else break;
  }
  return { results, next: index };
}

const RECORD_PREFIXES = new Set(['~', '@', '&', '+', '*', '=', '^', '#']);

/**
 * 解析一行 MI 记录。
 * 返回 null 表示这一行与 MI 语法匹配失败（例如 GDB 的裸输出）。
 */
export function parseRecord(line) {
  const match = /^(\d+)?([~@&*+=^#])([\s\S]*)$/.exec(line);
  if (!match) return null;
  const [, tokenText, type, body] = match;
  const token = tokenText ? Number(tokenText) : null;

  if (type === '#') {
    return { token: null, type: 'flush', cls: 'flush', results: {}, text: null, raw: line };
  }
  if (type === '~' || type === '@' || type === '&') {
    let text = body;
    if (text.trimStart().startsWith('"')) {
      text = parseString(text, text.indexOf('"')).value;
    }
    return {
      token,
      type: 'stream',
      stream: type === '~' ? 'console' : type === '@' ? 'target' : 'log',
      cls: 'stream',
      results: {},
      text,
      raw: line,
    };
  }

  const commaIndex = body.indexOf(',');
  const cls = (commaIndex < 0 ? body : body.slice(0, commaIndex)).trim();
  const rest = commaIndex < 0 ? '' : body.slice(commaIndex + 1);
  const { results } = parseResults(rest, 0);
  return { token, type, cls, results, text: null, raw: line };
}

const REASON_MAP = {
  'breakpoint-hit': 'breakpoint',
  'end-stepping-range': 'step',
  'function-finished': 'step',
  'location-reached': 'breakpoint',
  'watchpoint-trigger': 'breakpoint',
  'read-watchpoint-trigger': 'breakpoint',
  'access-watchpoint-trigger': 'breakpoint',
  'signal-received': 'signal',
  'exited-normally': 'exited',
  exited: 'exited',
  'exited-signalled': 'exited',
};

/**
 * 从 `*stopped` 记录提取停止原因。
 * 未知原因必须保留原始文本，保留原始文本供上层判断。
 */
export function stopReasonOf(record) {
  const results = record?.results ?? {};
  const rawReason = typeof results.reason === 'string' ? results.reason : 'unknown';
  const frame = results.frame && !Array.isArray(results.frame) ? results.frame : {};
  const pc = typeof frame.addr === 'string' ? frame.addr : null;
  // GDB thread IDs are not zero-based QEMU CPU indices (the first thread is
  // normally "1", while its core is 0). Never use thread-id as a CPU number.
  const cpuIdSource = results.core ?? '0';
  const cpuId = Number.parseInt(String(cpuIdSource), 10);
  return {
    reason: REASON_MAP[rawReason] ?? 'unknown',
    rawReason,
    pc,
    cpuId: Number.isFinite(cpuId) ? cpuId : 0,
    breakpointId: results.bkptno !== undefined ? Number.parseInt(String(results.bkptno), 10) : undefined,
    function: typeof frame.func === 'string' ? frame.func : null,
    file: typeof frame.file === 'string' ? frame.file : null,
    line: frame.line !== undefined ? Number.parseInt(String(frame.line), 10) : null,
    fullname: typeof frame.fullname === 'string' ? frame.fullname : null,
    raw: record.raw,
  };
}

/** 是否为停止通知（含执行中断）。 */
export function isStopRecord(record) {
  return record?.type === '*' && record.cls === 'stopped';
}

/** 是否为开始运行通知。 */
export function isRunningRecord(record) {
  return record?.type === '*' && record.cls === 'running';
}

/** 把 `-data-list-register-names` 的结果转成名字数组。 */
export function registerNamesOf(record) {
  const names = record?.results?.['register-names'];
  if (!Array.isArray(names)) return [];
  // 必须保留空字符串占位：GDB 用空名字表示保留位，
  // 过滤掉会让后续按 number 映射的寄存器整体错位。
  return names.map((name) => (typeof name === 'string' ? name : ''));
}

/**
 * 把 `-data-list-register-values` 的结果转成 { name, value } 数组。
 * 值保持 GDB 给出的字符串形式，数值解释交给上层。
 * 名字为空的保留位直接跳过。
 */
export function registerValuesOf(record, names) {
  const values = record?.results?.['register-values'];
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const entry of values) {
    if (!entry || Array.isArray(entry)) continue;
    const number = Number.parseInt(String(entry.number), 10);
    const name = Number.isFinite(number) ? names[number] : undefined;
    if (!name) continue;
    out.push({ name, value: String(entry.value), number });
  }
  return out;
}

/** 把 `-data-read-memory-bytes` 的结果转成字节块数组。 */
export function memoryBlocksOf(record) {
  const memory = record?.results?.memory;
  if (!Array.isArray(memory)) return [];
  return memory
    .filter((entry) => entry && !Array.isArray(entry) && typeof entry.contents === 'string')
    .map((entry) => ({
      begin: String(entry.begin),
      offset: String(entry.offset ?? '0x0'),
      end: entry.end !== undefined ? String(entry.end) : null,
      contents: entry.contents,
      length: entry.contents.length / 2,
    }));
}

/** 提取错误信息：`^error,msg="..."`。 */
export function errorMessageOf(record) {
  const message = record?.results?.msg;
  if (typeof message === 'string') return message;
  return record?.raw ?? 'unknown MI error';
}
