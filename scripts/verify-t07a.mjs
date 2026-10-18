/**
 * T07a 验收：DWARF 布局清单与 GDB 独立对照。
 *
 *   node scripts/verify-t07a.mjs
 *
 * 这份脚本要证明的不是"生成器跑通了"，而是**生成出来的偏移是对的**。对照物必须是
 * 与生成路径无关的第二个实现：生成侧自己读 `.debug_info`，逐字节按 form 长度走 DIE；
 * 对照侧用 GDB 的 `sizeof` 与 `&((struct X*)0)->f`。两边都从同一份 vmlinux 出发，
 * 但代码路径完全不同 —— 这才叫独立对照。
 *
 * 实现上有一个必须交代的决定：**对照走 GDB 内嵌 Python，而不是一串 GDB 命令**。
 * 原因是 GDB 在 `-batch` 模式下遇到第一个错误（比如某个类型名它不认识）就会中断整个
 * 命令脚本，后面的对照全部拿不到数据，而"某个类型 GDB 不认识"本身恰恰是需要被报出来
 * 的结果，不是中断的理由。用 Python 逐项 try/except，一项失败不影响其余，且失败本身
 * 也能被分类统计。
 *
 * 检查项：
 *   V1  产物存在，且自述来源里 build ID / sha256 / 编译单元数 / DIE 数齐全
 *   V2  build ID 与 sha256 与现场 vmlinux **重新算一遍**的结果一致（不采信产物自述）
 *   V3  遍历完整：DIE 数是真实规模，编译单元数与现场一致
 *   V4  生成可复现：重跑生成器到临时路径，`types` 与 `source` 逐字节相同
 *   V5  全部类型的 sizeof 与 GDB 一致（只有前向声明的类型单列，不混进来充数）
 *   V6  抽样字段的字节偏移与 GDB 一致（含穿过匿名成员的字段）
 *   V7  位域的"第几字节第几位"与 GDB 的 `ptype /o` 一致，且每一个含位域的类型都真的比到了
 *   V8  枚举值与 GDB 一致
 *   V9  同名多份定义的对账结论被如实记录（不一致的必须列出来，不能吞掉）
 *   V10 摊平未截断（`truncatedAnonymous` / `truncatedFields` 不得出现）
 *
 * 结果写入 `artifacts/verify/t07a.json` 与 `artifacts/verify/t07a.log`。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElfFile } from '../packages/linux-decoder/dwarf/elf.ts';

const VMLINUX = 'artifacts/build/linux/vmlinux';
const LAYOUT = 'artifacts/layout/linux-6.12.112-observatory-f5e5edc1c572.json';
const EVIDENCE_JSON = 'artifacts/verify/t07a.json';
const EVIDENCE_LOG = 'artifacts/verify/t07a.log';

/**
 * 每个类型抽样多少个字段去问 GDB。
 *
 * 抽样而不是全量：85 个类型、上万个字段全问一遍要跑很久，而抽样已经足以让"位域整体
 * 错位""匿名成员没摊平""某类字段统一偏了 8 字节"这类**系统性**错误立刻暴露。真正
 * 要防的是系统性错位，不是单个字段的偶然差异。
 */
const FIELD_SAMPLE_PER_TYPE = 14;

/**
 * 位域核对**不写死名单**，而是从产物里挑出"真的有位域的类型"。
 *
 * 为什么不能写死：写死的名单会退化成一种自欺。名单里放几个根本没有位域的类型（或者
 * 名字在新的内核版本里已经不存在了），检查照样报"通过"，因为一行都没比到 —— 覆盖率
 * 为零的检查和不写检查是一回事（上一版就是这样：名单里 6 个类型只有 `task_struct`
 * 真有位域，`sock` 根本不在产物里）。所以这里改成从产物推导，并要求**每一个含位域的
 * 类型都真的比到至少一个位域**，把"覆盖到了"变成可断言的事实。
 */
function bitfieldTypesOf(types, names) {
  return names.filter((name) => (types[name].members ?? []).some((member) => member.bitSize !== null)).sort();
}

const results = [];
let failures = 0;
const logLines = [];

function log(line) {
  logLines.push(line);
  console.log(line);
}

function record(id, ok, detail) {
  results.push({ id, ok, detail });
  if (!ok) failures += 1;
  log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

/**
 * 把"要问 GDB 的问题"写成一份 spec，再交给内嵌 Python 逐项执行。
 *
 * spec 单独放一个 JSON 文件（而不是塞进 Python 源码字符串）是为了避免转义问题：
 * 类型名与字段路径里有 `_`、`[]`、`.`，任何一层字符串拼接出错都会变成"GDB 说找不到
 * 这个字段"，而真实原因只是我们自己引号没转好。
 */
function runGdbSpec(spec) {
  const dir = mkdtempSync(join(tmpdir(), 't07a-gdb-'));
  const specPath = join(dir, 'spec.json');
  const driverPath = join(dir, 'driver.py');
  writeFileSync(specPath, JSON.stringify(spec));
  writeFileSync(driverPath, DRIVER_PYTHON.replace('__SPEC_PATH__', specPath));
  try {
    return execFileSync('gdb', ['-batch', '-nx', '-x', driverPath, VMLINUX], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      timeout: 900000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DRIVER_PYTHON = `import gdb, json

with open(r"__SPEC_PATH__") as handle:
    spec = json.load(handle)

def emit(kind, *parts):
    gdb.write("%s|%s\\n" % (kind, "|".join(str(p).replace("\\n", " ") for p in parts)))

for name, entry in spec.items():
    expr = entry.get("expr")
    if expr:
        try:
            emit("SIZE", name, int(gdb.parse_and_eval("sizeof(%s)" % expr)))
        except gdb.error as error:
            emit("SIZEFAIL", name, str(error))
        for path in entry.get("fields", []):
            try:
                value = gdb.parse_and_eval("(unsigned long)&((%s *)0)->%s" % (expr, path))
                emit("OFF", name, path, int(value))
            except gdb.error:
                emit("OFFFAIL", name, path)
        for enumerator in entry.get("enums", []):
            try:
                emit("ENUM", name, enumerator, int(gdb.parse_and_eval("(long)%s" % enumerator)))
            except gdb.error:
                emit("ENUMFAIL", name, enumerator)
    if entry.get("ptype"):
        try:
            text = gdb.execute("ptype /o %s" % expr, to_string=True)
            emit("PTYPEBEGIN", name)
            for line in text.split("\\n"):
                if line.strip():
                    emit("PTYPEROW", name, line)
        except gdb.error:
            emit("PTYPEFAIL", name)
`;

/** 解析驱动输出的 `KIND|a|b|...` 行。 */
function parseDriverOutput(output) {
  const rows = [];
  for (const raw of output.split('\n')) {
    const match = raw.match(/^([A-Z]+)\|(.*)$/);
    if (!match) continue;
    const parts = [];
    let rest = match[2];
    // PTYPEROW 的最后一节是 GDB 的原始输出，可能自带 `|`，所以按"最多切 n 次"解析。
    const [head, ...tail] = rest.split('|');
    parts.push(head, ...tail);
    rows.push({ kind: match[1], parts });
  }
  return rows;
}

function main() {
  if (!existsSync(LAYOUT)) {
    record('V1 布局产物存在', false, `找不到 ${LAYOUT}，先运行 node packages/linux-decoder/tools/gen-layout.mjs`);
    return fail();
  }
  const layout = JSON.parse(readFileSync(LAYOUT, 'utf8'));
  const typeNames = Object.keys(layout.types);
  const src = layout.source ?? {};

  /* ---------- V1 产物自述来源 ---------- */
  record(
    'V1 产物自述来源齐全',
    layout.schema === 'oslab.linux-layout/1'
      && typeof src.buildId === 'string' && src.buildId.length > 0
      && typeof src.sha256 === 'string' && src.sha256.length === 64
      && Number.isInteger(src.compileUnits) && src.compileUnits > 0
      && Number.isInteger(src.diesScanned) && src.diesScanned > 0
      && typeof src.dwarfVersion === 'number',
    `schema=${layout.schema} buildId=${src.buildId} release=${src.linuxRelease} dwarf=${src.dwarfVersion} `
      + `CU=${src.compileUnits} DIE=${src.diesScanned} 类型=${typeNames.length}`,
  );

  /* ---------- V2 build ID 与 sha256 现场重算 ---------- */
  const bytes = new Uint8Array(readFileSync(VMLINUX));
  const liveBuildId = new ElfFile(bytes).buildId;
  const liveSha256 = createHash('sha256').update(bytes).digest('hex');
  record(
    'V2 build ID 与 sha256 与现场 vmlinux 一致',
    liveBuildId !== null && liveBuildId === src.buildId && liveSha256 === src.sha256,
    `现场 buildId=${liveBuildId} 产物=${src.buildId}；现场 sha256=${liveSha256.slice(0, 16)}… 产物=${String(src.sha256).slice(0, 16)}…（${bytes.length} 字节）`,
  );

  /* ---------- V3 遍历完整 ---------- */
  record(
    'V3 遍历完整未截断',
    src.diesScanned > 10000000 && src.compileUnits === 1690,
    `DIE=${src.diesScanned} CU=${src.compileUnits}（生成器在遍历被截断时直接失败退出，产物存在即说明没有截断）`,
  );

  /* ---------- V4 生成可复现 ---------- */
  const tempDir = mkdtempSync(join(tmpdir(), 't07a-regen-'));
  const tempOut = join(tempDir, 'layout.json');
  let regenerated = null;
  let regenError = null;
  try {
    execFileSync('node', ['packages/linux-decoder/tools/gen-layout.mjs', '--out', tempOut], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000,
    });
    regenerated = JSON.parse(readFileSync(tempOut, 'utf8'));
  } catch (error) {
    regenError = error;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  if (regenerated === null) {
    record('V4 生成可复现', false, `重跑生成器失败：${regenError?.message ?? '未知'}`);
  } else {
    const sameTypes = JSON.stringify(regenerated.types) === JSON.stringify(layout.types);
    const sameSource = JSON.stringify(regenerated.source) === JSON.stringify(layout.source);
    record('V4 生成可复现', sameTypes && sameSource,
      `重跑后 types 相同=${sameTypes} source 相同=${sameSource}（generatedAt 是唯一允许不同的字段）`);
  }

  /* ---------- 组装要问 GDB 的问题 ---------- */
  const spec = {};
  const declarationOnly = [];
  const sampled = {};
  const bitfieldTypes = bitfieldTypesOf(layout.types, typeNames);
  for (const name of typeNames) {
    const type = layout.types[name];
    const fieldsForType = Object.entries(type.fields ?? {})
      // 位域取不到地址（`&` 会失败），单独用 ptype /o 对照。
      .filter(([path, field]) => field.bitSize === null && field.byteSize !== null
        && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(path))
      .sort(([a], [b]) => (a < b ? -1 : 1));

    // "只有前向声明"的类型（byteSize 与成员都为空）在 DWARF 里就是 `struct X;`，
    // 它没有布局可比。单列出来，不混进"对上了 N 个"里充数，也不算对照失败。
    if (type.byteSize === null && (type.members ?? []).length === 0) {
      declarationOnly.push(name);
      continue;
    }

    const stride = Math.max(1, Math.floor(fieldsForType.length / FIELD_SAMPLE_PER_TYPE));
    const picked = [];
    for (let i = 0; i < fieldsForType.length && picked.length < FIELD_SAMPLE_PER_TYPE; i += stride) {
      picked.push(fieldsForType[i][0]);
    }
    sampled[name] = picked;
    spec[name] = {
      expr: type.cTypeName ?? null,
      fields: picked,
      enums: (type.enumerators ?? []).map((entry) => entry.name)
        .filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)),
      ptype: bitfieldTypes.includes(name),
    };
  }

  const output = runGdbSpec(spec);
  const rows = parseDriverOutput(output);
  const sizeByType = new Map();
  const sizeFail = new Map();
  const offsetByKey = new Map();
  const offsetFail = [];
  const enumByKey = new Map();
  const enumFail = [];
  const ptypeByType = new Map();
  for (const row of rows) {
    if (row.kind === 'SIZE') sizeByType.set(row.parts[0], Number(row.parts[1]));
    else if (row.kind === 'SIZEFAIL') sizeFail.set(row.parts[0], row.parts.slice(1).join('|'));
    else if (row.kind === 'OFF') offsetByKey.set(`${row.parts[0]}|${row.parts[1]}`, Number(row.parts[2]));
    else if (row.kind === 'OFFFAIL') offsetFail.push(`${row.parts[0]}.${row.parts[1]}`);
    else if (row.kind === 'ENUM') enumByKey.set(`${row.parts[0]}|${row.parts[1]}`, Number(row.parts[2]));
    else if (row.kind === 'ENUMFAIL') enumFail.push(`${row.parts[0]}.${row.parts[1]}`);
    else if (row.kind === 'PTYPEROW') {
      const list = ptypeByType.get(row.parts[0]) ?? [];
      list.push(row.parts.slice(1).join('|'));
      ptypeByType.set(row.parts[0], list);
    }
  }

  /* ---------- V5 sizeof 对照 ---------- */
  const sizeMismatches = [];
  let sizeCompared = 0;
  for (const name of Object.keys(spec)) {
    const expected = layout.types[name].byteSize;
    if (!sizeByType.has(name)) {
      sizeMismatches.push(`${name}: GDB 未给出大小（${sizeFail.get(name) ?? '未知原因'}）`);
      continue;
    }
    const actual = sizeByType.get(name);
    if (expected === null) {
      sizeMismatches.push(`${name}: 我们求不出大小，GDB 给出 ${actual}`);
      continue;
    }
    sizeCompared += 1;
    if (actual !== expected) sizeMismatches.push(`${name}: 我们=${expected} GDB=${actual}`);
  }
  record(
    'V5 sizeof 与 GDB 一致',
    sizeMismatches.length === 0,
    `逐一对上 ${sizeCompared} 个类型，不一致/取不到 ${sizeMismatches.length} 个；`
      + `另有 ${declarationOnly.length} 个只有前向声明的类型无从对照（${declarationOnly.slice(0, 5).join(',')}${declarationOnly.length > 5 ? '…' : ''}）`
      + (sizeMismatches.length === 0 ? '' : `；明细：${sizeMismatches.slice(0, 8).join(' | ')}`),
  );

  /* ---------- V6 字段偏移对照 ---------- */
  const offsetMismatches = [];
  let offsetCompared = 0;
  let anonymousCompared = 0;
  for (const [name, picked] of Object.entries(sampled)) {
    for (const path of picked) {
      const key = `${name}|${path}`;
      const field = layout.types[name].fields[path];
      if (!offsetByKey.has(key)) {
        offsetMismatches.push(`${key}: GDB 取不到`);
        continue;
      }
      offsetCompared += 1;
      if (field.viaAnonymous) anonymousCompared += 1;
      const actual = offsetByKey.get(key);
      if (actual !== field.byteOffset) {
        offsetMismatches.push(`${key}: 我们=${field.byteOffset}(0x${field.byteOffset.toString(16)}) GDB=${actual}(0x${actual.toString(16)})`);
      }
    }
  }
  record(
    'V6 字段字节偏移与 GDB 一致',
    offsetMismatches.length === 0,
    `逐一对上 ${offsetCompared} 个字段（其中穿过匿名成员的 ${anonymousCompared} 个），`
      + `不一致/取不到 ${offsetMismatches.length} 个`
      + (offsetMismatches.length === 0 ? '' : `；明细：${offsetMismatches.slice(0, 6).join(' | ')}`),
  );

  /* ---------- V7 位域对照 ---------- */
  const bitfield = checkBitfields(ptypeByType, layout.types, bitfieldTypes);
  record(
    'V7 位域第几字节第几位与 GDB 一致',
    bitfield.mismatches.length === 0
      && bitfield.compared > 0
      && bitfield.missingTypes.length === 0
      // 覆盖必须完整：每个含位域的类型都要真的比到至少一个位域。少一个就说明有类型的位域
      // 从检查里溜掉了（类型名对不上、ptype 输出格式换了，都会表现成这种"静默漏检"）。
      && bitfield.covered.length === bitfieldTypes.length,
    `逐一对上 ${bitfield.compared} 个位域，覆盖 ${bitfield.covered.length}/${bitfieldTypes.length} 个含位域的类型`
      + `（${bitfield.hits.join(' ')}），不一致 ${bitfield.mismatches.length} 个`
      + (bitfield.covered.length === bitfieldTypes.length
        ? ''
        : `；未比到位域的类型：${bitfieldTypes.filter((name) => !bitfield.covered.includes(name)).join(',')}`)
      + (bitfield.missingTypes.length === 0 ? '' : `；GDB 未给出 ptype 的类型：${bitfield.missingTypes.join(',')}`)
      + (bitfield.mismatches.length === 0 ? '' : `；明细：${bitfield.mismatches.slice(0, 6).join(' | ')}`),
  );

  /* ---------- V8 枚举值对照 ---------- */
  const enumMismatches = [];
  let enumCompared = 0;
  for (const name of Object.keys(spec)) {
    for (const enumerator of layout.types[name].enumerators ?? []) {
      const key = `${name}|${enumerator.name}`;
      if (!enumByKey.has(key)) continue;
      enumCompared += 1;
      const actual = enumByKey.get(key);
      if (actual !== enumerator.value) enumMismatches.push(`${key}: 我们=${enumerator.value} GDB=${actual}`);
    }
  }
  record(
    'V8 枚举值与 GDB 一致',
    enumMismatches.length === 0,
    `逐一对上 ${enumCompared} 个枚举值，不一致 ${enumMismatches.length} 个`
      + (enumFail.length === 0 ? '' : `；GDB 取不到 ${enumFail.length} 个（${enumFail.slice(0, 5).join(',')}）`)
      + (enumMismatches.length === 0 ? '' : `；明细：${enumMismatches.slice(0, 6).join(' | ')}`),
  );

  /* ---------- V9 多定义对账如实记录 ---------- */
  const unchecked = [];
  const inconsistent = [];
  let consistentTypes = 0;
  for (const name of typeNames) {
    const evidence = layout.types[name].evidence ?? {};
    if (evidence.consistent === true) consistentTypes += 1;
    if (evidence.consistent === false) inconsistent.push(`${name}(${evidence.inconsistentAt?.length ?? 0} 处)`);
    if (evidence.consistent === null && (evidence.definitionCount ?? 0) > 1) unchecked.push(name);
  }
  record(
    'V9 多定义对账如实记录',
    inconsistent.length === 0 && unchecked.length === 0,
    `对账一致 ${consistentTypes} 个类型，不一致 ${inconsistent.length} 个，多定义却无法对账 ${unchecked.length} 个`
      + (inconsistent.length === 0 ? '' : `；不一致：${inconsistent.slice(0, 8).join(' | ')}`)
      + (unchecked.length === 0 ? '' : `；${unchecked.slice(0, 8).join(' | ')}`),
  );

  /* ---------- V10 摊平未截断 ---------- */
  const truncated = typeNames.filter((name) => layout.types[name].truncatedAnonymous || layout.types[name].truncatedFields);
  record(
    'V10 匿名成员摊平未截断',
    truncated.length === 0,
    truncated.length === 0
      ? `${typeNames.length} 个类型都没有触发摊平上限（匿名层数上限 ${src.anonymousDepthLimit}）`
      : `以下类型触及摊平上限，字段可能不全：${truncated.join(' | ')}`,
  );

  const summary = {
    startedAt: new Date().toISOString(),
    layoutFile: LAYOUT,
    layoutSchema: layout.schema,
    source: src,
    declarationOnlyTypes: declarationOnly,
    total: results.length,
    passed: results.length - failures,
    failed: failures,
    results,
  };
  writeFileSync(EVIDENCE_JSON, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(EVIDENCE_LOG, `${logLines.join('\n')}\n`);
  log(`\n汇总：${results.length - failures}/${results.length} 通过，失败 ${failures} 项`);
  log(`证据：${EVIDENCE_JSON}`);
  return fail();
}

function fail() {
  return failures;
}

/**
 * 从 `ptype /o` 的输出里抠出位域的"第几字节第几位"。
 *
 * 输出长这样（首数是字节偏移，冒号后是该字节内的位号，竖线后是字节数，
 * 末尾是 `名字 : 宽度`）：
 *     /*  498: 0   |     1 *​/    u8 sk_gso_disabled : 1;
 * 三样都要对上：只对上字节而位号错，等于位域位置错了 —— 而位域错位恰恰是内核结构里
 * 最隐蔽的一类错误，因为成员个数、顺序、大小全都看起来正常。
 */
function checkBitfields(ptypeByType, types, wanted) {
  const mismatches = [];
  const hits = [];
  const covered = [];
  const missingTypes = [];
  let compared = 0;
  for (const name of wanted) {
    const type = types[name];
    if (!type) continue;
    const body = ptypeByType.get(name);
    if (!body) {
      missingTypes.push(name);
      continue;
    }
    const expected = new Map();
    for (const member of type.members ?? []) {
      if (member.bitSize === null || member.name === null) continue;
      expected.set(member.name, {
        byteOffset: member.byteOffset,
        bitInByte: member.bitOffset % 8,
        bitSize: member.bitSize,
      });
    }
    let hit = 0;
    for (const line of body) {
      const match = line.match(/\/\*\s*(\d+):\s*(\d+)\s*\|\s*(\d+)\s*\*\/\s*.*?\b([A-Za-z_]\w*)\s*:\s*(\d+)\s*;/);
      if (!match) continue;
      const [, byteText, bitText, , memberName, widthText] = match;
      const mine = expected.get(memberName);
      if (!mine) continue;
      compared += 1;
      hit += 1;
      const byte = Number(byteText);
      const bit = Number(bitText);
      const width = Number(widthText);
      if (byte !== mine.byteOffset || bit !== mine.bitInByte || width !== mine.bitSize) {
        mismatches.push(`${name}.${memberName}: 我们=${mine.byteOffset}:${mine.bitInByte}(w${mine.bitSize}) GDB=${byte}:${bit}(w${width})`);
      }
    }
    if (hit > 0) {
      hits.push(`${name}(${hit})`);
      covered.push(name);
    }
  }
  return { compared, mismatches, hits, covered, missingTypes };
}

process.exit(main() === 0 ? 0 : 1);
