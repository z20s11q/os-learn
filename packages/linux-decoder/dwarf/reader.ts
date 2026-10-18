/** 按实际 DWARF form 读取 .debug_info，CU 表提供偏移归属与 abbrev 来源。
 * 名称索引保留类型定义，随机访问按 DIE 引用解码；格式缺口抛 DwarfError。
 */

import { ElfFile } from './elf.ts';
import {
  ATTR,
  ATTR_NAMES,
  CONSTANT_FORMS,
  DW_OP,
  FORM,
  FORM_NAMES,
  REFERENCE_FORMS,
  TAG,
  TAG_NAMES,
} from './constants.ts';

export class DwarfError extends Error {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DwarfError';
    this.detail = detail;
  }

  detail: Record<string, unknown>;
}

/** 一个 DIE 的某个属性：form 决定怎么读，value 是读出来的东西。 */
export interface DieValue {
  form: number;
  /** 整数常量（data1/data2/data4/data8、sdata/udata、各种 ref）→ number；地址 → bigint；字符串 → string；块 → Uint8Array */
  value: number | bigint | string | Uint8Array;
  /** form 是引用类（ref4 等）时，这里给出**已换算成 .debug_info 绝对偏移**的目标 */
  target: number | null;
}

export interface Die {
  /** 在 .debug_info 里的绝对偏移，同时充当 DIE 的身份标识 */
  offset: number;
  tag: number;
  hasChildren: boolean;
  values: Map<number, DieValue>;
  /** 所属编译单元起点，用来把 ref4 换算成绝对偏移 */
  cuOffset: number;
}

interface AttrSpec {
  attr: number;
  form: number;
}

interface AbbrevEntry {
  code: number;
  tag: number;
  hasChildren: boolean;
  attrs: AttrSpec[];
}

export interface DwarfCompileUnit {
  start: number;
  end: number;
  abbrevOffset: number;
  addressSize: number;
  /** DWARF 单元头长度，从 unit_length 后首字节计算 */
  headerSize: number;
  version: number;
}

/** 名字 → 定义位置的索引项。同一个名字在多个 CU 里各有一份定义，全部记下。 */
export interface NameIndexEntry {
  offset: number;
  tag: number;
  cuOffset: number;
}

/** 全量遍历自检结果，truncated 列出提前结束的编译单元。 */
export interface ScanStats {
  dies: number;
  truncated: { unitOffset: number; unitEnd: number; stoppedAt: number; gap: number }[];
}

const INDEXED_TAGS = new Set<number>([
  TAG.structure_type, TAG.union_type, TAG.class_type,
  TAG.enumeration_type, TAG.typedef, TAG.base_type,
]);

/** 带边界的字节游标：越界一律报错并说明读到哪一段的哪个位置。 */
class Cursor {
  private readonly bytes: Uint8Array;
  position: number;
  private readonly label: string;

  constructor(bytes: Uint8Array, position: number, label: string) {
    this.bytes = bytes;
    this.position = position;
    this.label = label;
  }

  #need(count: number): void {
    if (this.position + count > this.bytes.length) {
      throw new DwarfError(
        `读取 ${this.label} 时越界：想在偏移 ${this.position} 读 ${count} 字节，段长度只有 ${this.bytes.length}`,
      );
    }
  }

  u8(): number {
    this.#need(1);
    return this.bytes[this.position++];
  }

  uint(size: number): number {
    this.#need(size);
    let value = 0;
    for (let i = 0; i < size; i += 1) value += this.bytes[this.position + i] * 2 ** (8 * i);
    this.position += size;
    return value;
  }

  biguint(size: number): bigint {
    this.#need(size);
    let value = 0n;
    for (let i = 0; i < size; i += 1) value |= BigInt(this.bytes[this.position + i]) << BigInt(8 * i);
    this.position += size;
    return value;
  }

  uleb(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 53) throw new DwarfError(`ULEB128 超过 53 位，${this.label} 数据可能已错位`);
    }
  }

  sleb(): number {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 53) throw new DwarfError(`SLEB128 超过 53 位，${this.label} 数据可能已错位`);
    } while (byte & 0x80);
    if (shift < 64 && (byte & 0x40)) result -= 2 ** shift;
    return result;
  }

  take(count: number): Uint8Array {
    this.#need(count);
    const slice = this.bytes.subarray(this.position, this.position + count);
    this.position += count;
    return slice;
  }

  /** 读取零结尾字符串，游标消费结尾字节，结果仅含字符串内容。 */
  cstring(): string {
    const start = this.position;
    let end = start;
    while (end < this.bytes.length && this.bytes[end] !== 0) end += 1;
    this.position = end + 1;
    return Buffer.from(this.bytes.subarray(start, end)).toString('utf8');
  }
}

export class DwarfReader {
  constructor(elf: ElfFile) {
    this.elf = elf;
    this.info = elf.sectionBytes('.debug_info');
    this.abbrev = elf.sectionBytes('.debug_abbrev');
    if (!elf.hasSection('.debug_str')) throw new DwarfError('缺少 .debug_str 段');
    this.str = elf.sectionBytes('.debug_str');
    this.units = this.#readCompileUnits();
    this.unitStarts = this.units.map((unit) => unit.start);
    this.abbrevCache = new Map();
    this.nameIndexCache = null;
  }

  elf: ElfFile;
  info: Uint8Array;
  abbrev: Uint8Array;
  str: Uint8Array;
  units: DwarfCompileUnit[];
  private unitStarts: number[];
  private abbrevCache: Map<number, Map<number, AbbrevEntry>>;
  private nameIndexCache: Map<string, NameIndexEntry[]> | null;

  get buildId(): string | null {
    return this.elf.buildId;
  }

  #readCompileUnits(): DwarfCompileUnit[] {
    const units: DwarfCompileUnit[] = [];
    let cursor = 0;
    while (cursor < this.info.length) {
      const view = new DataView(this.info.buffer, this.info.byteOffset + cursor, 12);
      const unitLength = view.getUint32(0, true);
      if (unitLength === 0) break;
      if (unitLength === 0xffffffff) {
        throw new DwarfError(`编译单元 ${cursor} 使用 64 位 DWARF 格式（unit_length=0xffffffff），本读取器只支持 32 位格式`);
      }
      const version = view.getUint16(4, true);
      if (version < 2 || version > 4) {
        throw new DwarfError(`编译单元 ${cursor} 的 DWARF 版本是 ${version}，本读取器实现的是 2–4 版（这份 vmlinux 实测为 4 版）`);
      }
      const abbrevOffset = view.getUint32(6, true);
      const addressSize = view.getUint8(10);
      units.push({
        start: cursor,
        end: cursor + 4 + unitLength,
        abbrevOffset,
        addressSize,
        headerSize: 11,
        version,
      });
      cursor += 4 + unitLength;
    }
    return units;
  }

  /** 二分找到某个 .debug_info 偏移属于哪个编译单元。 */
  unitAt(offset: number): DwarfCompileUnit {
    let low = 0;
    let high = this.unitStarts.length - 1;
    let best = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.unitStarts[mid] <= offset) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best < 0) throw new DwarfError(`偏移 ${offset} 不在任何编译单元里`);
    const unit = this.units[best];
    if (offset >= unit.end) throw new DwarfError(`偏移 ${offset} 落在编译单元 ${unit.start}–${unit.end} 之外`);
    return unit;
  }

  /** abbrev 表按编译单元缓存，供属性解码复用。 */
  #abbrevTable(abbrevOffset: number): Map<number, AbbrevEntry> {
    const cached = this.abbrevCache.get(abbrevOffset);
    if (cached) return cached;
    const table = new Map<number, AbbrevEntry>();
    const cursor = new Cursor(this.abbrev, abbrevOffset, `.debug_abbrev@${abbrevOffset}`);
    for (;;) {
      const code = cursor.uleb();
      if (code === 0) break;
      const tag = cursor.uleb();
      const hasChildren = cursor.u8() !== 0;
      const attrs: AttrSpec[] = [];
      for (;;) {
        const attr = cursor.uleb();
        const form = cursor.uleb();
        if (attr === 0 && form === 0) break;
        attrs.push({ attr, form });
      }
      table.set(code, { code, tag, hasChildren, attrs });
    }
    this.abbrevCache.set(abbrevOffset, table);
    return table;
  }

  #readString(offset: number): string {
    if (offset >= this.str.length) {
      throw new DwarfError(`字符串偏移 ${offset} 超出 .debug_str 长度 ${this.str.length}`);
    }
    let end = offset;
    while (end < this.str.length && this.str[end] !== 0) end += 1;
    return Buffer.from(this.str.subarray(offset, end)).toString('utf8');
  }

  #readFormValue(cursor: Cursor, unit: DwarfCompileUnit, form: number): DieValue {
    switch (form) {
      case FORM.addr:
        return { form, value: cursor.biguint(unit.addressSize), target: null };
      case FORM.data1:
        return { form, value: cursor.uint(1), target: null };
      case FORM.data2:
        return { form, value: cursor.uint(2), target: null };
      case FORM.data4:
        return { form, value: cursor.uint(4), target: null };
      case FORM.data8:
        return { form, value: cursor.biguint(8), target: null };
      case FORM.sdata:
        return { form, value: cursor.sleb(), target: null };
      case FORM.udata:
        return { form, value: cursor.uleb(), target: null };
      case FORM.string:
        return { form, value: cursor.cstring(), target: null };
      case FORM.strp: {
        const offset = cursor.uint(4);
        return { form, value: this.#readString(offset), target: null };
      }
      case FORM.ref_addr: {
        const offset = cursor.uint(4);
        return { form, value: offset, target: offset };
      }
      case FORM.ref1:
      case FORM.ref2:
      case FORM.ref4:
      case FORM.ref8: {
        const size = { [FORM.ref1]: 1, [FORM.ref2]: 2, [FORM.ref4]: 4, [FORM.ref8]: 8 }[form] as number;
        const relative = cursor.uint(size);
        const absolute = unit.start + relative;
        return { form, value: absolute, target: absolute };
      }
      case FORM.ref_udata: {
        const relative = cursor.uleb();
        const absolute = unit.start + relative;
        return { form, value: absolute, target: absolute };
      }
      case FORM.sec_offset:
        return { form, value: cursor.uint(4), target: null };
      case FORM.exprloc: {
        const length = cursor.uleb();
        return { form, value: cursor.take(length), target: null };
      }
      case FORM.block: {
        const length = cursor.uleb();
        return { form, value: cursor.take(length), target: null };
      }
      case FORM.block1: {
        const length = cursor.uint(1);
        return { form, value: cursor.take(length), target: null };
      }
      case FORM.block2: {
        const length = cursor.uint(2);
        return { form, value: cursor.take(length), target: null };
      }
      case FORM.block4: {
        const length = cursor.uint(4);
        return { form, value: cursor.take(length), target: null };
      }
      case FORM.flag:
        return { form, value: cursor.u8(), target: null };
      case FORM.flag_present:
        return { form, value: 1, target: null };
      case FORM.indirect: {
        const realForm = cursor.uleb();
        return this.#readFormValue(cursor, unit, realForm);
      }
      default:
        throw new DwarfError(
          `遇到未实现的 DW_FORM 0x${form.toString(16)}（${FORM_NAMES[form] ?? '未知'}）：`
          + '长度未知，继续往下读会把后续字节错认成别的 DIE 的属性，因此在这里停下',
          { form, formName: FORM_NAMES[form] ?? null, position: cursor.position },
        );
    }
  }

  /** 解出从 `offset` 开始的一个 DIE。 */
  dieAt(offset: number): Die {
    const unit = this.unitAt(offset);
    return this.#readDie(offset, unit).die;
  }

  /** 解码一个 DIE 的全部属性，同时返回结束偏移以定位下一项。 */
  #readDie(offset: number, unit: DwarfCompileUnit): { die: Die; end: number } {
    const table = this.#abbrevTable(unit.abbrevOffset);
    const cursor = new Cursor(this.info, offset, `.debug_info@${offset}`);
    const code = cursor.uleb();
    if (code === 0) {
      throw new DwarfError(`偏移 ${offset} 是兄弟链的终止符（abbrev code 0），不是一个 DIE`);
    }
    const entry = table.get(code);
    if (!entry) {
      throw new DwarfError(
        `编译单元 ${unit.start} 的 abbrev 表里没有 code ${code}（.debug_info@${offset}），`
        + '说明前面的 DIE 长度被算错了',
        { abbrevOffset: unit.abbrevOffset, code },
      );
    }
    const values = new Map<number, DieValue>();
    for (const spec of entry.attrs) {
      const value = this.#readFormValue(cursor, unit, spec.form);
      if (!values.has(spec.attr)) values.set(spec.attr, value);
    }
    return {
      die: { offset, tag: entry.tag, hasChildren: entry.hasChildren, values, cuOffset: unit.start },
      end: cursor.position,
    };
  }

  /** 按文件顺序解码 DIE 的直接子节点。 */
  *children(die: Die): Generator<Die> {
    if (!die.hasChildren) return;
    const unit = this.unitAt(die.offset);
    let cursor = this.#readDie(die.offset, unit).end;
    for (;;) {
      const probe = new Cursor(this.info, cursor, `.debug_info@${cursor}`);
      if (probe.uleb() === 0) return;
      const { die: child, end } = this.#readDie(cursor, unit);
      yield child;
      cursor = end;
    }
  }

  /** 属性取字符串（DW_AT_name 等）。 */
  stringAttr(die: Die, attr: number): string | null {
    const value = die.values.get(attr);
    if (!value) return null;
    if (typeof value.value === 'string') return value.value;
    if (value.value instanceof Uint8Array) return Buffer.from(value.value).toString('utf8');
    return null;
  }

  /** 常量 form 直接取整数，exprloc 按支持的 opcode 求值；其余表达式报错。 */
  intAttr(die: Die, attr: number): number | null {
    const value = die.values.get(attr);
    if (!value) return null;
    if (typeof value.value === 'bigint') return Number(value.value);
    if (typeof value.value === 'number') return value.value;
    if (value.value instanceof Uint8Array) return this.#evalConstantExpression(value.value, die, attr);
    return null;
  }

  #evalConstantExpression(block: Uint8Array, die: Die, attr: number): number {
    // 逐个 opcode 走：只认"压一个常量"和"加上一个常量"，遇到别的就停。
    let index = 0;
    let accumulator = 0;
    while (index < block.length) {
      const op = block[index];
      if (op === DW_OP.plus_uconst) {
        index += 1;
        const cursor = new Cursor(block, index, 'DWARF 表达式');
        accumulator += cursor.uleb();
        index = cursor.position;
        continue;
      }
      const readInt = (size: number, signed: boolean): void => {
        index += 1;
        const cursor = new Cursor(block, index, 'DWARF 表达式');
        const raw = signed ? null : cursor.uint(size);
        const signedRaw = signed ? (() => {
          let v = 0;
          for (let i = 0; i < size; i += 1) v += block[cursor.position + i] * 2 ** (8 * i);
          const limit = 2 ** (8 * size - 1);
          return v >= limit ? v - 2 ** (8 * size) : v;
        })() : null;
        accumulator += (raw ?? signedRaw) as number;
        index = cursor.position;
      };
      if (op === DW_OP.const1u) { readInt(1, false); continue; }
      if (op === DW_OP.const1s) { readInt(1, true); continue; }
      if (op === DW_OP.const2u) { readInt(2, false); continue; }
      if (op === DW_OP.const2s) { readInt(2, true); continue; }
      if (op === DW_OP.const4u) { readInt(4, false); continue; }
      if (op === DW_OP.const4s) { readInt(4, true); continue; }
      if (op === DW_OP.const8u) { readInt(8, false); continue; }
      if (op === DW_OP.const8s) { readInt(8, true); continue; }
      throw new DwarfError(
        `DIE 0x${die.offset.toString(16)} 的属性 ${ATTR_NAMES[attr] ?? attr} 用了一段含 opcode 0x${op.toString(16)} 的 DWARF 表达式，`
        + '本读取器只实现常量表达式（const1u/const1s/…/const8s 与 plus_uconst），不估一个偏移出来',
        { die: die.offset, attr, tag: TAG_NAMES[die.tag] ?? die.tag },
      );
    }
    return accumulator;
  }

  /** 属性取 DIE 引用，返回目标绝对偏移。 */
  refAttr(die: Die, attr: number): number | null {
    const value = die.values.get(attr);
    if (!value) return null;
    if (value.target !== null) return value.target;
    if (typeof value.value === 'number' && REFERENCE_FORMS.has(value.form)) return value.value;
    return null;
  }

  /** 遍历建立类型名称索引，保留各编译单元中的全部同名候选。 */
  /** 顺序遍历各 CU 的 DIE，按 children/零终结符维护深度并记录单元结束位置。 */
  scan(visitor: (die: Die, end: number, unit: DwarfCompileUnit) => void): ScanStats {
    let dies = 0;
    const truncated: ScanStats['truncated'] = [];
    for (const unit of this.units) {
      let cursor = unit.start + unit.headerSize;
      let depth = 0;
      for (;;) {
        if (cursor >= unit.end) break;
        const probe = new Cursor(this.info, cursor, `.debug_info@${cursor}`);
        if (probe.uleb() === 0) {
          if (depth === 0) break;
          depth -= 1;
          cursor += 1;
          continue;
        }
        const { die, end } = this.#readDie(cursor, unit);
        dies += 1;
        visitor(die, end, unit);
        if (die.hasChildren) depth += 1;
        cursor = end;
      }
      const gap = unit.end - cursor;
      if (gap !== 0) {
        truncated.push({ unitOffset: unit.start, unitEnd: unit.end, stoppedAt: cursor, gap });
      }
    }
    return { dies, truncated };
  }

  nameIndex(): Map<string, NameIndexEntry[]> {
    if (this.nameIndexCache) return this.nameIndexCache;
    const index = new Map<string, NameIndexEntry[]>();
    const stats = this.scan((die, _end, unit) => {
      if (!INDEXED_TAGS.has(die.tag)) return;
      const name = this.stringAttr(die, ATTR.name);
      if (!name) return;
      const list = index.get(name) ?? [];
      list.push({ offset: die.offset, tag: die.tag, cuOffset: unit.start });
      index.set(name, list);
    });
    this.nameIndexCache = index;
    this.lastIndexScanStats = stats;
    return index;
  }

  /** 返回名称索引建立时同一趟遍历的自检结果。 */
  get indexScanStats(): ScanStats | null {
    return this.lastIndexScanStats;
  }
  private lastIndexScanStats: ScanStats | null = null;
}
