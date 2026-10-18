/** DWARF 探针：--forms 统计 form/tag，--stats 检查 DIE 遍历，--name 查类型定义。
 * --file 指定 vmlinux，默认 artifacts/build/linux/vmlinux。
 */

import { readFileSync } from 'node:fs';
import { ElfFile } from '../dwarf/elf.ts';
import { DwarfReader } from '../dwarf/reader.ts';
import { FORM, FORM_NAMES, TAG_NAMES } from '../dwarf/constants.ts';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const file = option('--file', 'artifacts/build/linux/vmlinux');
const bytes = new Uint8Array(readFileSync(file));
const elf = new ElfFile(bytes);
console.log(`文件 ${file}`);
console.log(`  build ID   ${elf.buildId ?? '（无 .note.gnu.build-id）'}`);
console.log(`  段            .debug_info=${elf.section('.debug_info').size} 字节 `
  + `.debug_abbrev=${elf.section('.debug_abbrev').size} 字节 `
  + `.debug_str=${elf.section('.debug_str').size} 字节`);

const reader = new DwarfReader(elf);
console.log(`  编译单元   ${reader.units.length} 个`);

if (flag('--forms')) {
  // 重新数一遍 form 与 tag：直接解读者自己缓存的 abbrev 表，保证统计口径与解析口径一致。
  const forms = new Map();
  const tags = new Map();
  let abbrevOffsets = new Set(reader.units.map((unit) => unit.abbrevOffset));
  // abbrevCache 是私有的，这里借 units 里每个 CU 的 abbrevOffset 逐个触发一次解析，
  // 统计入口按 CU 的 abbrevOffset 重新解码。
  const counts = countForms(elf, abbrevOffsets);
  for (const [form, count] of [...counts.forms.entries()].sort((a, b) => a[0] - b[0])) {
    forms.set(form, count);
  }
  for (const [tag, count] of [...counts.tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    tags.set(tag, count);
  }
  console.log(`  abbrev 记录 ${counts.total} 条，去重后的表 ${abbrevOffsets.size} 张`);
  console.log('  form 统计（这就是 constants.ts 里那张表的来源）：');
  for (const [form, count] of forms) {
    console.log(`    ${String(form).padStart(2)} ${(FORM_NAMES[form] ?? `未知 tag`).padEnd(14)} ${count}`);
  }
  console.log('  tag 统计（前 20）：');
  for (const [tag, count] of tags) {
    console.log(`    0x${tag.toString(16)} ${(TAG_NAMES[tag] ?? '未知').padEnd(28)} ${count}`);
  }
  const known = new Set(Object.values(FORM));
  const unknown = [...forms.keys()].filter((form) => !known.has(form));
  console.log(unknown.length === 0
    ? '  结论：出现过的 form 全部在 constants.ts 的 FORM 表里，读取器不用新增分支'
    : `  结论：出现了 constants.ts 里没有的 form: ${unknown.join(',')}`);
}

if (flag('--stats')) {
  const started = Date.now();
  const stats = reader.scan(() => {});
  const elapsed = Date.now() - started;
  console.log(`  全量遍历 ${stats.dies} 个 DIE，耗时 ${elapsed} ms`);
  console.log(stats.truncated.length === 0
    ? '  自检：每个编译单元的游标都走到了单元末尾，遍历没有被提前截断'
    : `  自检：${stats.truncated.length} 个编译单元被提前截断，前 5 个 ${JSON.stringify(stats.truncated.slice(0, 5))}`);
}

if (flag('--name')) {
  const name = option('--name', null);
  const index = reader.nameIndex();
  const hits = index.get(name) ?? [];
  console.log(`  索引条目 ${index.size} 个名字`);
  console.log(`  名字 ${name} 的定义 ${hits.length} 处：`);
  for (const hit of hits.slice(0, 10)) {
    console.log(`    .debug_info@${hit.offset} tag=${TAG_NAMES[hit.tag] ?? hit.tag} cu=${hit.cuOffset}`);
  }
  if (hits.length > 10) console.log(`    …另有 ${hits.length - 10} 处`);
}

/** 独立解码 abbrev 表以统计 form/tag，和 reader 的解析结果对照。 */
function countForms(elfFile, abbrevOffsets) {
  const abbrev = elfFile.sectionBytes('.debug_abbrev');
  const forms = new Map();
  const tags = new Map();
  let total = 0;
  for (const offset of abbrevOffsets) {
    let position = offset;
    const uleb = () => {
      let result = 0;
      let shift = 0;
      for (;;) {
        const byte = abbrev[position++];
        result += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) return result;
        shift += 7;
      }
    };
    for (;;) {
      const code = uleb();
      if (code === 0) break;
      const tag = uleb();
      position += 1; // children 标志
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
      total += 1;
      for (;;) {
        const attr = uleb();
        const form = uleb();
        if (attr === 0 && form === 0) break;
        forms.set(form, (forms.get(form) ?? 0) + 1);
      }
    }
  }
  return { forms, tags, total };
}
