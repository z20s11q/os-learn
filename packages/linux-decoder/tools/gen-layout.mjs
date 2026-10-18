/** 读取 vmlinux DWARF，按 layout-manifest 求 size/offset/枚举并输出来源绑定 JSON。
 * 用法：node packages/linux-decoder/tools/gen-layout.mjs [--file <vmlinux>] [--out <路径>]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { ElfFile } from '../dwarf/elf.ts';
import { DwarfReader } from '../dwarf/reader.ts';
import { LayoutResolver } from '../dwarf/types.ts';
import { dedupedManifest } from '../layout-manifest.ts';
import { layoutArtifactName } from '../layout.ts';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const vmlinuxPath = option('--file', 'artifacts/build/linux/vmlinux');
const uTSReleasePath = option('--utsrelease', 'artifacts/build/linux/include/generated/utsrelease.h');

/** 匿名成员展开深度上限，超限时记录 truncatedAnonymous。 */
const MAX_ANONYMOUS_DEPTH = 4;

/** 单个类型最多摊平出多少字段，超过就停下并记录。 */
const MAX_FIELDS_PER_TYPE = 4000;

function kernelRelease() {
  try {
    const text = readFileSync(uTSReleasePath, 'utf8');
    const match = text.match(/UTS_RELEASE\s+"([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const started = Date.now();
const bytes = new Uint8Array(readFileSync(vmlinuxPath));
const elf = new ElfFile(bytes);
const reader = new DwarfReader(elf);

process.stdout.write(`读取 ${vmlinuxPath}（${bytes.length} 字节）… `);
const sha256 = createHash('sha256').update(bytes).digest('hex');
console.log(`sha256=${sha256.slice(0, 16)}…`);

process.stdout.write(`解析 DWARF（${reader.units.length} 个编译单元）… `);
const resolver = new LayoutResolver(reader);
const names = resolver.nameIndexSize();
// 复用名称索引构造时的遍历自检结果。
const scanStats = reader.indexScanStats;
if (scanStats === null) {
  console.error('名字索引没有留下遍历自检结果，无法确认遍历完整性，拒绝生成布局清单。');
  process.exit(1);
}
console.log(`${scanStats.dies} 个 DIE，${names} 个类型名`);

// CU 遍历提前截断时中止生成。
if (scanStats.truncated.length > 0) {
  console.error(`编译单元遍历被截断 ${scanStats.truncated.length} 处，索引不完整，拒绝生成布局清单：`);
  console.error(JSON.stringify(scanStats.truncated.slice(0, 5), null, 2));
  process.exit(1);
}

const manifest = dedupedManifest();
const types = {};
const missing = [];

for (const entry of manifest) {
  let layout;
  try {
    layout = resolver.resolve(entry.name);
  } catch (error) {
    missing.push({
      name: entry.name,
      kind: entry.kind,
      required: entry.required,
      why: entry.why,
      reason: error.message,
    });
    if (entry.required) console.error(`缺少必需结构 ${entry.name}：${error.message}`);
    continue;
  }
  if (entry.kind !== 'any' && entry.kind !== layout.kind && layout.kind !== 'base') {
    // 清单 kind 与 DWARF 类型冲突时记录错误。
    missing.push({
      name: entry.name,
      kind: entry.kind,
      required: entry.required,
      why: entry.why,
      reason: `清单声明是 ${entry.kind}，DWARF 里是 ${layout.kind}`,
    });
    continue;
  }
  const fields = {};
  const flat = { truncatedAnonymous: false, truncatedFields: false };
  flattenFields(layout.members, [], fields, flat, 0, false);
  types[entry.name] = {
    kind: layout.kind,
    name: layout.name,
    cTypeName: layout.cTypeName,
    byteSize: layout.byteSize,
    alignment: layout.alignment,
    declaration: layout.declaration,
    evidence: {
      die: layout.die,
      definitionCount: layout.definitionCount,
      declarationCount: layout.declarationCount,
      comparedCount: layout.comparedCount,
      consistent: layout.consistent,
      inconsistentAt: layout.inconsistentAt,
    },
    members: layout.members.map((member) => ({
      name: member.name,
      byteOffset: member.byteOffset,
      bitOffset: member.bitOffset,
      bitSize: member.bitSize,
      byteSize: member.byteSize,
      typeName: member.typeName,
      typeDie: member.typeDie,
      anonymous: member.anonymous,
    })),
    enumerators: layout.enumerators,
    fields,
    ...(flat.truncatedAnonymous ? { truncatedAnonymous: true } : {}),
    ...(flat.truncatedFields ? { truncatedFields: true } : {}),
  };
}

/** 按成员名称展开字段路径；匿名成员偏移换算到父结构，具名成员保留父.子路径。 */
function flattenFields(members, prefix, out, flat, depth, descendedAnonymous) {
  for (const member of members) {
    if (Object.keys(out).length >= MAX_FIELDS_PER_TYPE) {
      flat.truncatedFields = true;
      return;
    }
    const path = member.name === null ? prefix : [...prefix, member.name];
    if (path.length > 0) {
      const key = path.join('.');
      // 同名路径只保留第一次求得的偏移。
      // 重复成员通过显式守卫处理。
      if (!(key in out)) {
        out[key] = {
          byteOffset: member.byteOffset,
          bitOffset: member.bitOffset,
          bitSize: member.bitSize,
          byteSize: member.byteSize,
          typeName: member.typeName,
          typeDie: member.typeDie,
          viaAnonymous: descendedAnonymous,
          path,
        };
      }
    }
    if ((member.anonymous || member.name === null) && member.typeDie !== null) {
      if (depth + 1 > MAX_ANONYMOUS_DEPTH) {
        flat.truncatedAnonymous = true;
        continue;
      }
      let inner;
      try {
        inner = resolver.resolveAt(member.typeDie);
      } catch {
        // 匿名成员引用求解失败时记录截断。
        flat.truncatedAnonymous = true;
        continue;
      }
      // 匿名成员的子字段要**整体平移**到父结构坐标系上，这才是它在内存里的真实位置。
      const shifted = inner.members.map((child) => ({
        ...child,
        byteOffset: member.byteOffset + child.byteOffset,
        bitOffset: member.bitOffset + child.bitOffset,
      }));
      flattenFields(shifted, path, out, flat, depth + 1, true);
    }
  }
}

const source = {
  vmlinux: vmlinuxPath,
  bytes: bytes.length,
  sha256,
  buildId: elf.buildId,
  linuxRelease: kernelRelease(),
  dwarfVersion: reader.units[0]?.version ?? null,
  compileUnits: reader.units.length,
  diesScanned: scanStats.dies,
  typeNames: names,
  anonymousDepthLimit: MAX_ANONYMOUS_DEPTH,
  generator: 'packages/linux-decoder/tools/gen-layout.mjs',
};

const output = {
  schema: 'oslab.linux-layout/1',
  generatedAt: new Date().toISOString(),
  source,
  types,
  missing,
};

const outPath = resolvePath(option('--out', join('artifacts/layout', layoutArtifactName(source))));
if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);

const requiredMissing = missing.filter((entry) => entry.required);
console.log(`写出 ${outPath}`);
console.log(`  类型 ${Object.keys(types).length} 个，缺失 ${missing.length} 个（其中必需 ${requiredMissing.length} 个）`);
console.log(`  耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
if (missing.length > 0) {
  console.log('  缺失明细：');
  for (const entry of missing) {
    console.log(`    ${entry.required ? '必需' : '可选'} ${entry.name}（清单声明 ${entry.kind}）：${entry.reason}`);
  }
}
if (requiredMissing.length > 0) {
  console.error(`有 ${requiredMissing.length} 个必需结构缺失，生成结果不完整。`);
  process.exit(1);
}
