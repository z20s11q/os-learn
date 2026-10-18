/** 从 DIE 引用求结构大小、成员位置和枚举值。
 * 同名候选先跟随 typedef/限定符归一到类型定义，再按定义 DIE 去重并对账。
 * 求解缺口用 null 或 LayoutError 表达，对账结果包含样本数和冲突位置。
 */

import type { DwarfReader, Die } from './reader.ts';
import { ATTR, TAG, TAG_NAMES, TYPE_WRAPPER_TAGS } from './constants.ts';

/** 一个成员（字段）的布局。 */
export interface MemberLayout {
  /** 字段名；匿名成员为 null */
  name: string | null;
  /** 从结构开头算起的字节偏移（位域按所属字节算） */
  byteOffset: number;
  /** 精确到位的偏移（位域用；非位域就是 byteOffset*8） */
  bitOffset: number;
  /** 位域宽度；普通字段为 null */
  bitSize: number | null;
  /** 字段类型占多少字节（位域/数组等求不出时可能是 null） */
  byteSize: number | null;
  /** 人类可读的类型名，例如 `struct list_head`、`unsigned int`、`struct task_struct *` */
  typeName: string | null;
  /** 字段类型对应的 DIE 偏移，便于继续往下钻（数组元素类型、成员结构等） */
  typeDie: number | null;
  /** 匿名成员，其字段摊平到父结构 */
  anonymous: boolean;
}

export type CompositeKind = 'struct' | 'union' | 'enum' | 'base';

/** 一个复合类型的完整布局。 */
export interface CompositeLayout {
  kind: CompositeKind;
  name: string;
  byteSize: number | null;
  alignment: number | null;
  /** DW_AT_declaration 前向声明标志，此时 members 为空 */
  declaration: boolean;
  /** 实际取值时用的那一份定义的 DIE 偏移 */
  die: number;
  /** 生成期确定的 C 类型名：匿名结构使用 typedef 名，具名复合类型带 C 关键字。 */
  cTypeName: string;
  members: MemberLayout[];
  /** enum 的枚举值 */
  enumerators: { name: string; value: number | null }[];
  /** 同名 DIE 归一后"真正的类型定义"有几份（按定义所在 DIE 去重）。 */
  definitionCount: number;
  /** 同名 DIE 归一后"只是前向声明"（`struct X;`）的有几份。 */
  declarationCount: number;
  /** 实际对账样本数，上限 CONSISTENCY_SAMPLE_LIMIT */
  comparedCount: number;
  /** 多定义对账是否一致；样本数小于 2 时为 null */
  consistent: boolean | null;
  /** 与第一份不一致的定义的 DIE 偏移，便于人工核对 */
  inconsistentAt: number[];
}

/** 同名定义对账的样本上限，实际样本数写入 comparedCount。 */
const CONSISTENCY_SAMPLE_LIMIT = 24;

/** 类型名解析的最大嵌套深度，防止畸形引用把递归拖爆。 */
const MAX_TYPE_DEPTH = 24;

export class LayoutError extends Error {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LayoutError';
    this.detail = detail;
  }

  detail: Record<string, unknown>;
}

export class LayoutResolver {
  constructor(reader: DwarfReader) {
    this.reader = reader;
    this.index = reader.nameIndex();
    this.sizeCache = new Map();
    this.nameCache = new Map();
    this.layoutCache = new Map();
    this.layoutByDie = new Map();
    this.declarationCache = new Map();
  }

  reader: DwarfReader;
  private index: Map<string, { offset: number; tag: number; cuOffset: number }[]>;
  private sizeCache: Map<number, number | null>;
  private nameCache: Map<number, string | null>;
  private layoutCache: Map<string, CompositeLayout>;
  private layoutByDie: Map<number, CompositeLayout>;
  private declarationCache: Map<number, boolean>;

  /** 这个名字在 DWARF 里有哪些定义。 */
  definitions(name: string): { offset: number; tag: number; cuOffset: number }[] {
    return this.index.get(name) ?? [];
  }

  /** 优先选择完整的复合类型定义，其次跟随 typedef；全部为声明时返回声明。 */
  findDefinition(name: string): { offset: number; tag: number; kind: CompositeKind } | null {
    const hits = this.definitions(name);
    if (hits.length === 0) return null;
    const order: number[] = [
      TAG.structure_type, TAG.union_type, TAG.class_type, TAG.enumeration_type, TAG.base_type,
    ];
    for (const wanted of order) {
      const concrete = hits.find((hit) => hit.tag === wanted && !this.#isDeclaration(hit.offset));
      if (concrete) return { offset: concrete.offset, tag: wanted, kind: kindOfTag(wanted) };
    }
    const asTypedef = hits.find((hit) => hit.tag === TAG.typedef);
    if (asTypedef) {
      const die = this.reader.dieAt(asTypedef.offset);
      const target = this.reader.refAttr(die, ATTR.type);
      if (target !== null) {
        const stripped = this.#stripToDefinition(target);
        if (stripped !== null && !this.#isDeclaration(stripped.offset)) return stripped;
      }
    }
    const declared = hits.find((hit) => order.includes(hit.tag));
    if (declared) return { offset: declared.offset, tag: declared.tag, kind: kindOfTag(declared.tag) };
    return null;
  }

  /** 依据 DW_AT_declaration 判定前向声明并缓存结果。 */
  #isDeclaration(offset: number): boolean {
    const cached = this.declarationCache.get(offset);
    if (cached !== undefined) return cached;
    const die = this.reader.dieAt(offset);
    const result = (this.reader.intAttr(die, ATTR.declaration) ?? 0) !== 0;
    this.declarationCache.set(offset, result);
    return result;
  }

  /** 跟随类型包装取得定义点，筛选类型 DIE 并按偏移去重。 */
  #definitionSites(name: string): { offset: number; declaration: boolean }[] {
    const seen = new Set<number>();
    const sites: { offset: number; declaration: boolean }[] = [];
    for (const hit of this.definitions(name)) {
      const target = this.#definitionTarget(hit.offset);
      if (target === null || seen.has(target)) continue;
      seen.add(target);
      sites.push({ offset: target, declaration: this.#isDeclaration(target) });
    }
    return sites;
  }

  /** 类型定义 DIE 的偏移；非类型或引用求解失败时返回 null。 */
  #definitionTarget(offset: number, depth = 0): number | null {
    if (depth > MAX_TYPE_DEPTH) return null;
    const die = this.reader.dieAt(offset);
    if (
      die.tag === TAG.structure_type
      || die.tag === TAG.union_type
      || die.tag === TAG.class_type
      || die.tag === TAG.enumeration_type
      || die.tag === TAG.base_type
    ) {
      return offset;
    }
    if (TYPE_WRAPPER_TAGS.has(die.tag)) {
      const target = this.reader.refAttr(die, ATTR.type);
      return target === null ? null : this.#definitionTarget(target, depth + 1);
    }
    return null;
  }

  /** 跟随 typedef 和限定符，直到复合类型或基础类型 DIE。 */
  #stripToDefinition(offset: number, depth = 0): { offset: number; tag: number; kind: CompositeKind } | null {
    if (depth > MAX_TYPE_DEPTH) return null;
    const die = this.reader.dieAt(offset);
    if (
      die.tag === TAG.structure_type
      || die.tag === TAG.union_type
      || die.tag === TAG.class_type
      || die.tag === TAG.enumeration_type
      || die.tag === TAG.base_type
    ) {
      return { offset, tag: die.tag, kind: kindOfTag(die.tag) };
    }
    if (die.tag === TAG.typedef || die.tag === TAG.const_type || die.tag === TAG.volatile_type
      || die.tag === TAG.restrict_type || die.tag === TAG.packed_type) {
      const target = this.reader.refAttr(die, ATTR.type);
      if (target !== null) return this.#stripToDefinition(target, depth + 1);
    }
    return null;
  }

  /** 求类型字节数；大小信息缺失或超过引用深度时返回 null。 */
  typeSize(offset: number, depth = 0): number | null {
    const cached = this.sizeCache.get(offset);
    if (cached !== undefined) return cached;
    if (depth > MAX_TYPE_DEPTH) return null;
    const die = this.reader.dieAt(offset);
    let result: number | null;
    switch (die.tag) {
      case TAG.base_type:
      case TAG.enumeration_type:
      case TAG.structure_type:
      case TAG.union_type:
      case TAG.class_type:
        result = this.reader.intAttr(die, ATTR.byte_size);
        break;
      case TAG.pointer_type:
      case TAG.reference_type:
        result = this.reader.intAttr(die, ATTR.byte_size)
          ?? this.reader.unitAt(offset).addressSize;
        break;
      case TAG.typedef:
      case TAG.const_type:
      case TAG.volatile_type:
      case TAG.restrict_type:
      case TAG.packed_type: {
        const target = this.reader.refAttr(die, ATTR.type);
        result = target === null ? null : this.typeSize(target, depth + 1);
        break;
      }
      case TAG.array_type: {
        const declared = this.reader.intAttr(die, ATTR.byte_size);
        if (declared !== null) {
          result = declared;
          break;
        }
        const element = this.reader.refAttr(die, ATTR.type);
        const elementSize = element === null ? null : this.typeSize(element, depth + 1);
        if (elementSize === null) {
          result = null;
          break;
        }
        let count = 1;
        let unknown = false;
        for (const child of this.reader.children(die)) {
          if (child.tag !== TAG.subrange_type) continue;
          const upper = this.reader.intAttr(child, ATTR.upper_bound);
          const explicitCount = this.reader.intAttr(child, ATTR.count);
          const lower = this.reader.intAttr(child, ATTR.lower_bound) ?? 0;
          if (explicitCount !== null) count *= explicitCount;
          else if (upper !== null) count *= (upper - lower + 1);
          else unknown = true;
        }
        result = unknown ? null : elementSize * count;
        break;
      }
      default:
        result = null;
    }
    this.sizeCache.set(offset, result);
    return result;
  }

  /** 人类可读的类型名。求不出来时返回 null，由调用方决定怎么显示"未知"。 */
  typeName(offset: number, depth = 0): string | null {
    const cached = this.nameCache.get(offset);
    if (cached !== undefined) return cached;
    if (depth > MAX_TYPE_DEPTH) return null;
    const die = this.reader.dieAt(offset);
    const name = this.reader.stringAttr(die, ATTR.name);
    let result: string | null;
    switch (die.tag) {
      case TAG.base_type: {
        if (name) {
          result = name;
          break;
        }
        const encoding = this.reader.intAttr(die, ATTR.encoding);
        result = encoding === null ? null : `base-type(encoding=${encoding})`;
        break;
      }
      case TAG.structure_type:
        result = name ? `struct ${name}` : 'struct <anonymous>';
        break;
      case TAG.union_type:
        result = name ? `union ${name}` : 'union <anonymous>';
        break;
      case TAG.class_type:
        result = name ? `class ${name}` : 'class <anonymous>';
        break;
      case TAG.enumeration_type:
        result = name ? `enum ${name}` : 'enum <anonymous>';
        break;
      case TAG.typedef:
        // typedef 有自己的名字，按源码里写的名字报，别展成 `unsigned int` ——
        // 内核里 `u32`/`gfp_t`/`loff_t` 这些别名本身就是要看的信息。
        result = name ?? this.#targetName(die, depth);
        break;
      case TAG.const_type:
        result = `const ${this.#targetName(die, depth) ?? '<未知>'}`;
        break;
      case TAG.volatile_type:
        result = `volatile ${this.#targetName(die, depth) ?? '<未知>'}`;
        break;
      case TAG.restrict_type:
        result = `${this.#targetName(die, depth) ?? '<未知>'} restrict`;
        break;
      case TAG.packed_type:
        result = this.#targetName(die, depth);
        break;
      case TAG.pointer_type: {
        const target = this.reader.refAttr(die, ATTR.type);
        result = target === null ? 'void *' : `${this.typeName(target, depth + 1) ?? '<未知>'} *`;
        break;
      }
      case TAG.reference_type: {
        const target = this.reader.refAttr(die, ATTR.type);
        result = target === null ? null : `${this.typeName(target, depth + 1) ?? '<未知>'} &`;
        break;
      }
      case TAG.array_type: {
        const element = this.reader.refAttr(die, ATTR.type);
        const elementName = element === null ? null : this.typeName(element, depth + 1);
        const bounds: string[] = [];
        for (const child of this.reader.children(die)) {
          if (child.tag !== TAG.subrange_type) continue;
          const upper = this.reader.intAttr(child, ATTR.upper_bound);
          const explicitCount = this.reader.intAttr(child, ATTR.count);
          const lower = this.reader.intAttr(child, ATTR.lower_bound) ?? 0;
          if (explicitCount !== null) bounds.push(String(explicitCount));
          else if (upper !== null) bounds.push(String(upper - lower + 1));
          else bounds.push('?');
        }
        result = bounds.length === 0
          ? `${elementName ?? '<未知>'}[]`
          : `${elementName ?? '<未知>'}[${bounds.join('][')}]`;
        break;
      }
      case TAG.subroutine_type:
        result = '函数指针';
        break;
      default:
        result = name ?? `tag:${TAG_NAMES[die.tag] ?? die.tag}`;
    }
    this.nameCache.set(offset, result);
    return result;
  }

  #targetName(die: Die, depth: number): string | null {
    const target = this.reader.refAttr(die, ATTR.type);
    return target === null ? null : this.typeName(target, depth + 1);
  }

  /** 名字索引里有多少个不同的类型名。 */
  nameIndexSize(): number {
    return this.index.size;
  }

  /** 按 DIE 偏移求布局；匿名类型直接求解，具名类型复用 resolve(name)。 */
  resolveAt(dieOffset: number): CompositeLayout {
    const cached = this.layoutByDie.get(dieOffset);
    if (cached) return cached;
    const die = this.reader.dieAt(dieOffset);
    /** 跟随 const/volatile/restrict/packed 引用读取类型本体，保留 typedef 名称入口。 */
    if (die.tag === TAG.const_type || die.tag === TAG.volatile_type
      || die.tag === TAG.restrict_type || die.tag === TAG.packed_type) {
      const target = this.reader.refAttr(die, ATTR.type);
      if (target !== null) {
        const layout = this.resolveAt(target);
        this.layoutByDie.set(dieOffset, layout);
        return layout;
      }
    }
    const name = this.reader.stringAttr(die, ATTR.name);
    const layout = name === null
      ? this.#resolveAt(`<匿名@0x${dieOffset.toString(16)}>`, dieOffset, kindOfTag(die.tag))
      : this.resolve(name);
    this.layoutByDie.set(dieOffset, layout);
    return layout;
  }

  /** 按名字求布局；定义查找失败时抛 LayoutError。 */
  resolve(name: string): CompositeLayout {
    const cached = this.layoutCache.get(name);
    if (cached) return cached;
    const definition = this.findDefinition(name);
    if (definition === null) {
      throw new LayoutError(`DWARF 里找不到 ${name} 的定义`, { name, definitions: this.definitions(name).length });
    }
    const layout = this.#resolveAt(name, definition.offset, definition.kind);
    this.layoutCache.set(name, layout);
    return layout;
  }

  #resolveAt(name: string, dieOffset: number, kind: CompositeKind): CompositeLayout {
    const die = this.reader.dieAt(dieOffset);
    // C 类型名依据 DIE 的名称确定。
    // 匿名结构使用查找入口提供的 typedef 名。
    const ownName = this.reader.stringAttr(die, ATTR.name);
    const byteSize = this.reader.intAttr(die, ATTR.byte_size);
    const alignment = this.reader.intAttr(die, ATTR.alignment);
    const declaration = (this.reader.intAttr(die, ATTR.declaration) ?? 0) !== 0;
    const members: MemberLayout[] = [];
    const enumerators: { name: string; value: number | null }[] = [];

    for (const child of this.reader.children(die)) {
      if (child.tag === TAG.member) {
        members.push(this.#member(child));
        continue;
      }
      if (child.tag === TAG.enumerator) {
        enumerators.push({
          name: this.reader.stringAttr(child, ATTR.name) ?? '<无名>',
          value: this.reader.intAttr(child, ATTR.const_value),
        });
        continue;
      }
      // DW_TAG_inheritance 按基类成员记录偏移与类型。
      // 基类信息与普通成员一起参与布局对账。
      if (child.tag === TAG.inheritance) {
        const offsetBits = (this.reader.intAttr(child, ATTR.data_member_location) ?? 0) * 8;
        const typeDie = this.reader.refAttr(child, ATTR.type);
        members.push({
          name: '<基类>',
          byteOffset: Math.floor(offsetBits / 8),
          bitOffset: offsetBits,
          bitSize: null,
          byteSize: typeDie === null ? null : this.typeSize(typeDie),
          typeName: typeDie === null ? null : this.typeName(typeDie),
          typeDie,
          anonymous: true,
        });
      }
    }

    const sites = this.#definitionSites(name);
    const definitions = sites.filter((site) => !site.declaration);
    const declarations = sites.filter((site) => site.declaration);
    // 实际使用的 DIE 属于完整定义时才进行多定义对账。
    // 前向声明单独统计。
    const isDefinition = definitions.some((site) => site.offset === dieOffset);
    const comparison = isDefinition
      ? this.#compareDefinitions(definitions.map((site) => site.offset), dieOffset)
      : { compared: 0, inconsistent: [] };

    return {
      kind,
      name,
      byteSize,
      alignment,
      declaration,
      die: dieOffset,
      cTypeName: ownName === null ? name : `${kindWord(kind)} ${name}`,
      members,
      enumerators,
      definitionCount: definitions.length,
      declarationCount: declarations.length,
      comparedCount: comparison.compared,
      consistent: comparison.compared <= 1 ? null : comparison.inconsistent.length === 0,
      inconsistentAt: comparison.inconsistent,
    };
  }

  /** 位域偏移优先取 data_bit_offset；bit_offset 写法按存储单元宽度和字节位置换算。 */
  #member(die: Die): MemberLayout {
    const name = this.reader.stringAttr(die, ATTR.name);
    const typeDie = this.reader.refAttr(die, ATTR.type);
    const bitSize = this.reader.intAttr(die, ATTR.bit_size);
    let bitOffset: number;
    const dataBitOffset = this.reader.intAttr(die, ATTR.data_bit_offset);
    if (dataBitOffset !== null) {
      bitOffset = dataBitOffset;
    } else if (bitSize !== null) {
      const legacyBitOffset = this.reader.intAttr(die, ATTR.bit_offset);
      const storageBytes = this.reader.intAttr(die, ATTR.byte_size);
      if (legacyBitOffset !== null && storageBytes !== null) {
        const locationBytes = this.reader.intAttr(die, ATTR.data_member_location) ?? 0;
        bitOffset = locationBytes * 8 + (storageBytes * 8 - legacyBitOffset - bitSize);
      } else {
        // 位宽存在而位移信息缺失时抛 LayoutError。
        throw new LayoutError(
          `成员 ${name ?? '<匿名>'}（DIE 0x${die.offset.toString(16)}）是位域但既没有 data_bit_offset `
          + '也没有可换算的 bit_offset/byte_size，无法确定它的位置',
          { die: die.offset, name, bitSize },
        );
      }
    } else {
      const byteOffset = this.reader.intAttr(die, ATTR.data_member_location) ?? 0;
      bitOffset = byteOffset * 8;
    }
    const anonymous = name === null && typeDie !== null
      && (() => {
        const target = this.reader.dieAt(typeDie);
        return target.tag === TAG.structure_type || target.tag === TAG.union_type;
      })();
    return {
      name,
      byteOffset: Math.floor(bitOffset / 8),
      bitOffset,
      bitSize,
      byteSize: typeDie === null ? null : this.typeSize(typeDie),
      typeName: typeDie === null ? null : this.typeName(typeDie),
      typeDie,
      anonymous,
    };
  }

  /** 比较完整定义的大小、成员位置、位宽和枚举值，返回样本数及冲突 DIE。 */
  #compareDefinitions(
    candidates: number[],
    primaryDie: number,
  ): { compared: number; inconsistent: number[] } {
    const primary = this.#plainLayout(primaryDie);
    if (primary === null) return { compared: 1, inconsistent: [] };
    const others = candidates.filter((offset) => offset !== primaryDie);
    const inconsistent: number[] = [];
    let compared = 1;
    for (const other of others.slice(0, CONSISTENCY_SAMPLE_LIMIT - 1)) {
      compared += 1;
      const candidate = this.#plainLayout(other);
      if (candidate === null || !sameLayout(primary, candidate)) inconsistent.push(other);
    }
    return { compared, inconsistent };
  }

  /** 仅解布局事实，供多定义对账使用。 */
  #plainLayout(dieOffset: number): { members: MemberLayout[]; byteSize: number | null; enumerators: { name: string; value: number | null }[] } | null {
    const die = this.reader.dieAt(dieOffset);
    const members: MemberLayout[] = [];
    const enumerators: { name: string; value: number | null }[] = [];
    try {
      for (const child of this.reader.children(die)) {
        if (child.tag === TAG.member) members.push(this.#member(child));
        else if (child.tag === TAG.enumerator) {
          enumerators.push({
            name: this.reader.stringAttr(child, ATTR.name) ?? '<无名>',
            value: this.reader.intAttr(child, ATTR.const_value),
          });
        }
      }
    } catch {
      // 定义求解失败时返回 null，记录为对账冲突。
      return null;
    }
    return { members, byteSize: this.reader.intAttr(die, ATTR.byte_size), enumerators };
  }
}

function kindOfTag(tag: number): CompositeKind {
  if (tag === TAG.structure_type || tag === TAG.class_type) return 'struct';
  if (tag === TAG.union_type) return 'union';
  if (tag === TAG.enumeration_type) return 'enum';
  return 'base';
}

/** kind → C 关键字，用于拼出可被 GDB 接受的类型写法。 */
function kindWord(kind: CompositeKind): string {
  if (kind === 'struct') return 'struct';
  if (kind === 'union') return 'union';
  if (kind === 'enum') return 'enum';
  // 基础类型在 C 中直接使用名称。
  return '';
}

/** 比较两份布局的"事实"是否一致。 */
function sameLayout(
  a: { members: MemberLayout[]; byteSize: number | null; enumerators: { name: string; value: number | null }[] },
  b: { members: MemberLayout[]; byteSize: number | null; enumerators: { name: string; value: number | null }[] },
): boolean {
  if (a.byteSize !== b.byteSize) return false;
  if (a.members.length !== b.members.length) return false;
  if (a.enumerators.length !== b.enumerators.length) return false;
  for (let i = 0; i < a.members.length; i += 1) {
    const left = a.members[i];
    const right = b.members[i];
    if (left.name !== right.name) return false;
    if (left.byteOffset !== right.byteOffset) return false;
    if (left.bitOffset !== right.bitOffset) return false;
    if (left.bitSize !== right.bitSize) return false;
    if (left.byteSize !== right.byteSize) return false;
    if (left.typeName !== right.typeName) return false;
  }
  for (let i = 0; i < a.enumerators.length; i += 1) {
    if (a.enumerators[i].name !== b.enumerators[i].name) return false;
    if (a.enumerators[i].value !== b.enumerators[i].value) return false;
  }
  return true;
}
