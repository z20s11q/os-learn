/** Linux 解码出口：layout 提供镜像绑定布局，dwarf 提供按 DIE 引用读取类型的能力。
 * tools 中的生成器作为独立构建期命令运行。
 */

export {
  KernelLayout,
  LAYOUT_SCHEMA,
  LayoutBindingError,
  isSignedTypeName,
  layoutArtifactName,
  liveBuildId,
  readBitfield,
  readField,
  readSigned,
  readUnsigned,
} from './layout.ts';
export type {
  LayoutDocument,
  LayoutEnumerator,
  LayoutEvidence,
  LayoutField,
  LayoutManifestEntry,
  LayoutMember,
  LayoutSource,
  LayoutType,
} from './layout.ts';

export { ElfFile, ElfFormatError } from './dwarf/elf.ts';
export type { ElfSection } from './dwarf/elf.ts';

export { DwarfReader, DwarfError } from './dwarf/reader.ts';
export type { Die, DieValue, DwarfCompileUnit, NameIndexEntry, ScanStats } from './dwarf/reader.ts';

export { LayoutResolver, LayoutError } from './dwarf/types.ts';
export type { CompositeKind, CompositeLayout, MemberLayout } from './dwarf/types.ts';

export {
  ATTR, ATTR_NAMES, COMPOSITE_TAGS, CONSTANT_FORMS, DW_OP, ENCODING, FORM, FORM_NAMES,
  REFERENCE_FORMS, TAG, TAG_NAMES, TYPE_WRAPPER_TAGS,
} from './dwarf/constants.ts';

export { LAYOUT_MANIFEST, dedupedManifest } from './layout-manifest.ts';
export type { ManifestEntry } from './layout-manifest.ts';

export {
  BufferCapture,
  CaptureReadError,
  KernelMemoryView,
  SYMBOL_UNAVAILABLE_REASON,
  isCaptureAttribution,
  littleEndianToBigInt,
  memoryEvidence,
  writeLittleEndian,
} from './capture.ts';
export type { CaptureAttribution, MemoryViewStats, ReadOnlyCapture } from './capture.ts';

export * from './objects/index.ts';

// 盘面解析读取磁盘字节，证据来源为 disk。
// 内存对象解析的证据来源为 memory。
export * from './disk/index.ts';

// I/O 关联这一层（T07f）：从文件偏移经页缓存、bio、request 一路走到 virtio 描述符
// 与设备请求。它同时要用内存侧（bio/request/队列）与盘面侧（扇区到块的对应），
// 所以放在两者之后导出。
export * from './io/index.ts';
