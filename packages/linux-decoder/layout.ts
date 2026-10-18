/** 消费 gen-layout.mjs 生成的内核布局清单，按类型和字段路径查表。
 * 清单携带 vmlinux 来源；绑定时校验 build ID，宽整数按 bigint 读取。
 */

import { readFileSync } from 'node:fs';
import { ElfFile } from './dwarf/elf.ts';
import { LayoutError } from './dwarf/types.ts';

/** 布局产物 schema 版本，构造时拒绝版本冲突。 */
export const LAYOUT_SCHEMA = 'oslab.linux-layout/1';

/** 一个字段在结构里的位置。`fields` 表里的值。 */
export interface LayoutField {
  /** 从结构开头算起的字节偏移；位域是它所属的那个字节 */
  byteOffset: number;
  /** 精确到位的偏移（位域用；非位域等于 byteOffset*8） */
  bitOffset: number;
  /** 位域宽度；普通字段为 null */
  bitSize: number | null;
  /** 类型占多少字节；求不出时为 null */
  byteSize: number | null;
  /** 类型名，例如 `struct list_head` */
  typeName: string | null;
  /** 类型对应的 DIE 偏移，可继续用 DWARF 层往下钻 */
  typeDie: number | null;
  /** 这个字段是穿过匿名成员才到达的（`mm_struct.mmap_base` 就是） */
  viaAnonymous: boolean;
  /** 从结构名到字段名的路径，例如 `['mm', 'mmap_base']` */
  path: string[];
}

/** 结构的原始成员（含匿名成员本身）。摊平后的路径在 `fields` 里。 */
export interface LayoutMember {
  name: string | null;
  byteOffset: number;
  bitOffset: number;
  bitSize: number | null;
  byteSize: number | null;
  typeName: string | null;
  typeDie: number | null;
  anonymous: boolean;
}

export interface LayoutEnumerator {
  name: string;
  value: number | null;
}

/** 同名多份定义的对照结论。 */
export interface LayoutEvidence {
  /** 实际取用的那份定义的 DIE 偏移 */
  die: number;
  definitionCount: number;
  declarationCount: number;
  comparedCount: number;
  /** 多定义对账结果；样本数小于 2 时为 null */
  consistent: boolean | null;
  inconsistentAt: number[];
}

export interface LayoutType {
  kind: 'struct' | 'union' | 'enum' | 'base';
  name: string;
  /** 在 C/GDB 里怎么称呼它（`struct task_struct` 还是 `atomic_t`） */
  cTypeName: string;
  byteSize: number | null;
  alignment: number | null;
  /** DW_AT_declaration 前向声明，此时 members 和 fields 为空 */
  declaration: boolean;
  evidence: LayoutEvidence;
  members: LayoutMember[];
  enumerators: LayoutEnumerator[];
  fields: Record<string, LayoutField>;
  /** 匿名成员层数超过上限，字段可能不全 */
  truncatedAnonymous?: boolean;
  /** 字段数超过上限，字段可能不全 */
  truncatedFields?: boolean;
}

/** 产物自述的来源：这份清单是从哪个二进制算出来的。 */
export interface LayoutSource {
  vmlinux: string;
  bytes: number;
  sha256: string;
  buildId: string | null;
  linuxRelease: string | null;
  dwarfVersion: number | null;
  compileUnits: number;
  diesScanned: number;
  typeNames: number;
  anonymousDepthLimit: number;
  generator: string;
}

export interface LayoutManifestEntry {
  name: string;
  kind: string;
  required: boolean;
  why: string;
  reason: string;
}

export interface LayoutDocument {
  schema: string;
  generatedAt: string;
  source: LayoutSource;
  types: Record<string, LayoutType>;
  missing: LayoutManifestEntry[];
}

/** 布局与内核镜像绑定失败，携带两侧来源供调用方诊断。 */
export class LayoutBindingError extends LayoutError {}

/** 清单文件名里带上内核版本与 build ID，让"哪份清单配哪个内核"在文件名上就成立。 */
export function layoutArtifactName(source: { linuxRelease?: string | null; buildId?: string | null }): string {
  const release = source.linuxRelease ?? 'unknown';
  const id = (source.buildId ?? 'nobuildid').slice(0, 12);
  return `linux-${release}-${id}.json`;
}

/** 从 vmlinux 的 ELF note 读取 build ID。 */
export function liveBuildId(vmlinuxPath: string): string | null {
  return new ElfFile(new Uint8Array(readFileSync(vmlinuxPath))).buildId;
}

export class KernelLayout {
  constructor(document: LayoutDocument) {
    if (document.schema !== LAYOUT_SCHEMA) {
      throw new LayoutError(`布局清单 schema 是 ${document.schema}，本代码只认 ${LAYOUT_SCHEMA}`, {
        schema: document.schema,
      });
    }
    this.document = document;
  }

  private document: LayoutDocument;

  static parse(text: string): KernelLayout {
    return new KernelLayout(JSON.parse(text) as LayoutDocument);
  }

  /** 读取布局清单；传入 vmlinux 时调用 verifyAgainst 校验 build ID。 */
  static load(path: string, options: { vmlinux?: string } = {}): KernelLayout {
    const layout = KernelLayout.parse(readFileSync(path, 'utf8'));
    if (options.vmlinux) layout.verifyAgainst(options.vmlinux);
    return layout;
  }

  /** 这份清单是给哪个内核算的。 */
  get source(): LayoutSource {
    return this.document.source;
  }

  get buildId(): string | null {
    return this.document.source.buildId;
  }

  get sha256(): string {
    return this.document.source.sha256;
  }

  get linuxRelease(): string | null {
    return this.document.source.linuxRelease;
  }

  get generatedAt(): string {
    return this.document.generatedAt;
  }

  /** 清单要求但本次 DWARF 类型查找缺失的条目。 */
  get missing(): LayoutManifestEntry[] {
    return this.document.missing;
  }

  /** 清单里有哪些类型。 */
  typeNames(): string[] {
    return Object.keys(this.document.types);
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.document.types, name);
  }

  /** 查找类型布局；类型缺失时抛 LayoutError 并携带候选信息。 */
  type(name: string): LayoutType {
    const found = this.document.types[name];
    if (!found) {
      throw new LayoutError(`布局清单里没有类型 ${name}`, {
        name,
        typeNames: this.typeNames().length,
        missing: this.document.missing.some((entry) => entry.name === name),
      });
    }
    return found;
  }

  /** 取一个字段的位置。路径可以是摊平表里的点号键，也可以是具名成员的嵌套路径。 */
  field(typeName: string, path: string): LayoutField {
    const type = this.type(typeName);
    if (type.declaration) {
      throw new LayoutError(
        `${typeName} 在这份内核的 DWARF 里只有前向声明，没有定义，取不到字段 ${path}`,
        { typeName, path },
      );
    }
    return this.fieldPath(typeName, path);
  }

  hasField(typeName: string, path: string): boolean {
    const type = this.document.types[typeName];
    if (!type) return false;
    return Object.prototype.hasOwnProperty.call(type.fields, path);
  }

  /** 逐段解析具名成员路径，累计字节与位偏移，并保留 breadcrumb。
 * 中间段为位域、指针、数组或标量时抛 LayoutError。
 */
  fieldPath(typeName: string, dottedPath: string): LayoutField {
    const root = this.type(typeName);
    // 优先匹配生成器已摊平的完整路径。
    //
    // 匿名成员的字段偏移已换算到父结构坐标系。
    // 精确键命中时直接使用该位置。
    // 具名成员的嵌套路径由后面的逐段解析处理。
    // 两种路径分别保留生成期与运行期的来源信息。
    const direct = root.fields[dottedPath];
    if (direct) return direct;
    if (!dottedPath.includes('.')) {
      const candidates = Object.keys(root.fields);
      throw new LayoutError(
        `${typeName} 里没有字段 ${dottedPath}`,
        { typeName, dottedPath, fieldCount: candidates.length, samples: candidates.slice(0, 8) },
      );
    }

    const segments = dottedPath.split('.');
    let currentType = typeName;
    let byteOffset = 0;
    let bitOffset = 0;
    let last: LayoutField | null = null;
    const breadcrumb: Array<{ typeName: string; field: string; byteOffset: number; typeNameOfField: string | null }> = [];

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const type = this.type(currentType);
      const field = type.fields[segment];
      if (!field) {
        // 在中间任意一层报出"这一层有哪些字段"，比在最后一层报错更容易定位。
        const candidates = Object.keys(type.fields);
        throw new LayoutError(
          `${currentType} 里没有字段 ${segment}（路径 ${dottedPath} 的第 ${index + 1} 段）`,
          { typeName: currentType, segment, dottedPath, fieldCount: candidates.length, samples: candidates.slice(0, 8) },
        );
      }
      breadcrumb.push({
        typeName: currentType,
        field: segment,
        byteOffset: field.byteOffset,
        typeNameOfField: field.typeName,
      });
      byteOffset += field.byteOffset;
      bitOffset += field.bitOffset;
      const isLast = index === segments.length - 1;
      if (isLast) {
        last = {
          ...field,
          byteOffset,
          bitOffset,
          path: [...(field.path ?? []), ...segments.slice(0, index + 1)],
        };
        break;
      }
      if (field.bitSize !== null) {
        throw new LayoutError(
          `路径 ${dottedPath} 的第 ${index + 1} 段 ${segment} 是位域，没有字节地址，不能继续往下钻`,
          { typeName: currentType, segment, dottedPath },
        );
      }
      const nested = this.#nestedTypeName(field.typeName);
      if (nested === null) {
        throw new LayoutError(
          `路径 ${dottedPath} 的第 ${index + 1} 段 ${segment} 的类型是 ${field.typeName ?? '<未知>'}，`
          + '不是内嵌的结构/联合，没有更深的字段可钻',
          { typeName: currentType, segment, dottedPath, fieldType: field.typeName },
        );
      }
      currentType = nested;
    }

    if (last === null) throw new LayoutError(`路径 ${dottedPath} 为空`);
    (last as LayoutField & { breadcrumb?: unknown }).breadcrumb = breadcrumb;
    return last;
  }

  /** 去除 C 类型限定词后查找清单键；指针和数组类型返回 null。 */
  #nestedTypeName(typeName: string | null): string | null {
    if (typeName === null) return null;
    const stripped = typeName.replace(/\b(const|volatile|struct|union|enum)\b/g, '').trim();
    if (stripped.length === 0 || stripped.includes('*') || stripped.includes('[')) return null;
    return this.has(stripped) ? stripped : null;
  }

  /** 下钻路径的分步证据（每一段的类型与偏移），供面板展开。 */
  pathBreadcrumb(typeName: string, dottedPath: string): Array<Record<string, unknown>> {
    const field = this.fieldPath(typeName, dottedPath) as LayoutField & { breadcrumb?: Array<Record<string, unknown>> };
    return field.breadcrumb ?? [];
  }

  /** 读一个嵌套字段的绝对字节偏移。 */
  byteOffsetPath(typeName: string, dottedPath: string): number {
    return this.fieldPath(typeName, dottedPath).byteOffset;
  }

  byteOffset(typeName: string, path: string): number {
    return this.fieldPath(typeName, path).byteOffset;
  }

  /** 读取枚举值；枚举名、枚举项或取值缺失时抛 LayoutError。 */
  enumValue(typeName: string, enumeratorName: string): number {
    const type = this.type(typeName);
    const found = type.enumerators.find((entry) => entry.name === enumeratorName);
    if (!found) {
      throw new LayoutError(`${typeName} 里没有枚举项 ${enumeratorName}`, {
        typeName,
        enumeratorName,
        count: type.enumerators.length,
      });
    }
    if (found.value === null) {
      throw new LayoutError(`${typeName} 的枚举项 ${enumeratorName} 没有取值（DWARF 里没给常量值）`, {
        typeName,
        enumeratorName,
      });
    }
    return found.value;
  }

  /** 比较清单与现场 vmlinux 的 build ID；缺失或冲突时抛 LayoutBindingError。 */
  verifyAgainst(vmlinuxPath: string): void {
    const live = liveBuildId(vmlinuxPath);
    const expected = this.document.source.buildId;
    if (live === null) {
      throw new LayoutBindingError(
        `现场的 ${vmlinuxPath} 里读不到 build ID，无法确认布局清单是否对得上这个内核`,
        { vmlinux: vmlinuxPath, layoutBuildId: expected },
      );
    }
    if (expected === null) {
      throw new LayoutBindingError(
        `布局清单没有记录 build ID（生成时就没读出来），无法确认它属于哪个内核`,
        { vmlinux: vmlinuxPath, liveBuildId: live },
      );
    }
    if (live !== expected) {
      throw new LayoutBindingError(
        `布局清单是给 build ID ${expected} 的内核算的，现场 ${vmlinuxPath} 的 build ID 是 ${live}；`
        + '内核重编后结构偏移会整体变化，必须用当前内核重新生成布局清单',
        { vmlinux: vmlinuxPath, layoutBuildId: expected, liveBuildId: live },
      );
    }
  }
}

/* 字节读取：统一处理范围校验、宽整数和补码。 */

function dataViewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function checkRange(bytes: Uint8Array, byteOffset: number, byteSize: number, what: string): void {
  if (byteSize <= 0 || byteSize > 8) {
    throw new LayoutError(`${what}：不支持的读取宽度 ${byteSize} 字节（只支持 1–8）`, { byteOffset, byteSize });
  }
  if (byteOffset < 0 || byteOffset + byteSize > bytes.byteLength) {
    throw new LayoutError(
      `${what}：读 ${byteOffset}..${byteOffset + byteSize} 超出这段内存的长度 ${bytes.byteLength}`,
      { byteOffset, byteSize, length: bytes.byteLength },
    );
  }
}

/** 小端无符号整数读取；7-8 字节用 bigint，其余用 number。 */
export function readUnsigned(bytes: Uint8Array, byteOffset: number, byteSize: number): number | bigint {
  checkRange(bytes, byteOffset, byteSize, '读无符号整数');
  if (byteSize >= 7) {
    let value = 0n;
    for (let i = byteSize - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[byteOffset + i]);
    return value;
  }
  let value = 0;
  for (let i = byteSize - 1; i >= 0; i -= 1) value = value * 256 + bytes[byteOffset + i];
  return value;
}

/** 小端读有符号整数（补码），宽度分界与 `readUnsigned` 相同。 */
export function readSigned(bytes: Uint8Array, byteOffset: number, byteSize: number): number | bigint {
  const raw = readUnsigned(bytes, byteOffset, byteSize);
  const signBit = 1n << BigInt(byteSize * 8 - 1);
  const modulus = 1n << BigInt(byteSize * 8);
  const asBig = typeof raw === 'bigint' ? raw : BigInt(raw);
  if ((asBig & signBit) === 0n) return raw;
  const negative = asBig - modulus;
  return byteSize >= 7 ? negative : Number(negative);
}

/** 将覆盖位域的字节按小端合并，再移位和掩码提取字段。 */
export function readBitfield(
  bytes: Uint8Array,
  byteOffset: number,
  bitInByte: number,
  bitSize: number,
  signed = false,
): number | bigint {
  if (bitSize <= 0 || bitSize > 64) {
    throw new LayoutError(`位域宽度 ${bitSize} 不合法（只支持 1–64 位）`, { byteOffset, bitInByte, bitSize });
  }
  // 从 byteOffset 读取覆盖位域的字节跨度，上限 8 字节。
  // 范围由 readUnsigned 校验。
  const span = Math.min(8, Math.max(1, Math.ceil((bitInByte + bitSize) / 8)));
  const raw = readUnsigned(bytes, byteOffset, span);
  const shifted = (typeof raw === 'bigint' ? raw : BigInt(raw)) >> BigInt(bitInByte);
  const masked = shifted & ((1n << BigInt(bitSize)) - 1n);
  if (!signed) return bitSize <= 31 ? Number(masked) : masked;
  const signBit = 1n << BigInt(bitSize - 1);
  const value = (masked & signBit) === 0n ? masked : masked - (1n << BigInt(bitSize));
  return bitSize <= 31 ? Number(value) : value;
}

/** 按布局读取字段；signed=true 使用补码解释，默认按无符号读取。 */
export function readField(
  bytes: Uint8Array,
  field: LayoutField,
  options: { signed?: boolean } = {},
): number | bigint {
  const signed = options.signed === true;
  if (field.bitSize !== null) {
    return readBitfield(bytes, field.byteOffset, field.bitOffset % 8, field.bitSize, signed);
  }
  if (field.byteSize === null) {
    throw new LayoutError(
      `字段 ${field.path.join('.')} 的类型大小未知（类型名 ${field.typeName ?? '<未知>'}），读不出来`,
      { path: field.path, typeName: field.typeName },
    );
  }
  if (field.byteSize > 8) {
    // 宽度超过 8 字节的字段按复合类型拒绝整数读取。
    // 调用方应按元素或成员读取。
    throw new LayoutError(
      `字段 ${field.path.join('.')} 占 ${field.byteSize} 字节（类型 ${field.typeName ?? '<未知>'}，`
      + '多半是数组或内嵌结构），不能当整数读；请按元素/成员逐个读',
      { path: field.path, typeName: field.typeName, byteSize: field.byteSize },
    );
  }
  const reader = signed ? readSigned : readUnsigned;
  return reader(bytes, field.byteOffset, field.byteSize);
}

/** 常见整数类型名的符号性；类型表外返回 null。 */
export function isSignedTypeName(typeName: string | null): boolean | null {
  if (typeName === null) return null;
  const name = typeName.replace(/\bconst\b/g, '').trim();
  if (SIGNED_TYPES.has(name)) return true;
  if (UNSIGNED_TYPES.has(name)) return false;
  return null;
}

const SIGNED_TYPES = new Set([
  'char', 'short', 'short int', 'int', 'long', 'long int', 'long long', 'long long int',
  'signed char', 'signed short', 'signed short int', 'signed int', 'signed long',
  'signed long int', 'signed long long', 'signed long long int',
  '__int128', 's8', 's16', 's32', 's64', 'int8_t', 'int16_t', 'int32_t', 'int64_t',
  '__s8', '__s16', '__s32', '__s64',
]);

const UNSIGNED_TYPES = new Set([
  'unsigned char', 'unsigned short', 'unsigned short int', 'unsigned int', 'unsigned long',
  'unsigned long int', 'unsigned long long', 'unsigned long long int',
  'bool', '_Bool', 'u8', 'u16', 'u32', 'u64', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  '__u8', '__u16', '__u32', '__u64',
]);
