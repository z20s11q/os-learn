/** ELF64 小端读取器，提供段表、原始段字节和 GNU build ID。
 * 格式与压缩段校验失败时抛 ElfError。
 */

/** ELF 段表里的一项。 */
export interface ElfSection {
  index: number;
  name: string;
  type: number;
  flags: bigint;
  address: bigint;
  offset: number;
  size: number;
}

/** 解析失败时抛这个，message 说明是哪个字段不符合预期。 */
export class ElfFormatError extends Error {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ElfFormatError';
    this.detail = detail;
  }

  detail: Record<string, unknown>;
}

const SHT_NOTE = 7;
const SHT_NOBITS = 8;

export class ElfFile {
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    if (bytes.length < 64) throw new ElfFormatError('文件短于 ELF64 头部');
    if (!(bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)) {
      throw new ElfFormatError('不是 ELF 文件（magic 不是 0x7f E L F）');
    }
    if (bytes[4] !== 2) throw new ElfFormatError(`只支持 64 位 ELF，ei_class=${bytes[4]}`);
    if (bytes[5] !== 1) throw new ElfFormatError(`只支持小端 ELF，ei_data=${bytes[5]}`);
    this.sections = this.#readSectionTable();
    this.sectionByName = new Map(this.sections.map((section) => [section.name, section]));
  }

  bytes: Uint8Array;
  sections: ElfSection[];
  sectionByName: Map<string, ElfSection>;

  #readSectionTable(): ElfSection[] {
    const eShoff = this.u64(0x28);
    const eShentsize = this.u16(0x3a);
    const eShnum = this.u16(0x3c);
    const eShstrndx = this.u16(0x3e);
    if (eShnum === 0) throw new ElfFormatError('段表为空');
    const raw = [] as { nameOff: number; type: number; flags: bigint; address: bigint; offset: number; size: number }[];
    for (let i = 0; i < eShnum; i += 1) {
      const base = Number(eShoff) + i * eShentsize;
      raw.push({
        nameOff: this.u32(base),
        type: this.u32(base + 4),
        flags: this.u64(base + 8),
        address: this.u64(base + 0x10),
        offset: Number(this.u64(base + 0x18)),
        size: Number(this.u64(base + 0x20)),
      });
    }
    const strTab = raw[eShstrndx];
    const out: ElfSection[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const entry = raw[i];
      out.push({
        index: i,
        name: this.cstring(Number(strTab.offset) + entry.nameOff),
        type: entry.type,
        flags: entry.flags,
        address: entry.address,
        offset: entry.offset,
        size: entry.size,
      });
    }
    return out;
  }

  section(name: string): ElfSection {
    const found = this.sectionByName.get(name);
    if (!found) {
      throw new ElfFormatError(`ELF 里没有段 ${name}`, {
        available: this.sections.filter((s) => s.name.startsWith('.debug')).map((s) => s.name),
      });
    }
    if (found.type === SHT_NOBITS) {
      throw new ElfFormatError(`段 ${name} 是 SHT_NOBITS（文件里没有实际字节）`);
    }
    return found;
  }

  /** 段原始字节的共享视图。 */
  sectionBytes(name: string): Uint8Array {
    const found = this.section(name);
    return this.bytes.subarray(found.offset, found.offset + found.size);
  }

  hasSection(name: string): boolean {
    return this.sectionByName.has(name);
  }

  /** 遍历 SHT_NOTE 及候选名称段，返回首个 NT_GNU_BUILD_ID 的值。 */
  get buildId(): string | null {
    const candidates = this.sections.filter((section) => section.type === SHT_NOTE
      || section.name === '.note.gnu.build-id' || section.name === '.notes');
    for (const section of candidates) {
      const found = this.#buildIdInSection(section);
      if (found) return found;
    }
    return null;
  }

  #buildIdInSection(section: ElfSection): string | null {
    let cursor = section.offset;
    const end = section.offset + section.size;
    while (cursor + 12 <= end) {
      const nameSize = this.u32(cursor);
      const descSize = this.u32(cursor + 4);
      const noteType = this.u32(cursor + 8);
      const nameStart = cursor + 12;
      const descStart = nameStart + ((nameSize + 3) & ~3);
      if (noteType === 3) {
        return Buffer.from(this.bytes.subarray(descStart, descStart + descSize)).toString('hex');
      }
      cursor = descStart + ((descSize + 3) & ~3);
    }
    return null;
  }

  u8(offset: number): number {
    return this.bytes[offset];
  }

  u16(offset: number): number {
    return this.bytes[offset] | (this.bytes[offset + 1] << 8);
  }

  u32(offset: number): number {
    return (this.bytes[offset] | (this.bytes[offset + 1] << 8)
      | (this.bytes[offset + 2] << 16) | (this.bytes[offset + 3] << 24)) >>> 0;
  }

  u64(offset: number): bigint {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset, 8);
    return view.getBigUint64(0, true);
  }

  /** 以 `offset` 起、到第一个 0 字节为止的 ASCII 字符串（DW_FORM_string 用）。 */
  cstring(offset: number): string {
    let end = offset;
    while (end < this.bytes.length && this.bytes[end] !== 0) end += 1;
    return Buffer.from(this.bytes.subarray(offset, end)).toString('utf8');
  }

  /** 在某个段的字节里按偏移取以 0 结尾的字符串（.debug_str 用）。 */
  stringInSection(sectionName: string, offset: number): string {
    const section = this.section(sectionName);
    return this.cstring(section.offset + offset);
  }
}
