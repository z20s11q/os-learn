/**
 * 前端使用的运行时类型（T04）。
 *
 * 说明：这些接口按实际 HTTP/WS 返回的 JSON 形状声明。协议权威定义在
 * packages/contracts，但服务端返回的字段会随采集能力增加，前端只依赖
 * 自己真正读取的字段，缺失字段统一显示「未采集」。
 */

export type Hex = string;

export interface RegisterValue {
  name: string;
  width?: number;
  value: Hex;
}

export interface SegmentRegister {
  selector: Hex;
  base: Hex;
  limit: Hex;
  attributes: Hex;
  usable: boolean;
}

export interface InstructionView {
  address: Hex | null;
  bytes: string | null;
  text: string | null;
  length: number | null;
  evidence: string;
}

export interface CpuSnapshot {
  cpuId: number;
  mode: string;
  cpl: number;
  rip: Hex | null;
  rsp: Hex | null;
  general: RegisterValue[];
  segments: Record<string, SegmentRegister>;
  control: {
    cr0: Hex | null;
    cr2: Hex | null;
    cr3: Hex | null;
    cr4: Hex | null;
    cr8: Hex | null;
  };
  efer: Hex | null;
  eflags: Hex | null;
  halted: boolean;
  instruction: InstructionView;
  /** 线性 PC；实模式缺段隐藏基址时为 null */
  linearPc: Hex | null;
  evidence: string;
}

export interface MemoryEntry {
  addressSpace: 'physical' | 'linear';
  address: Hex;
  length: number;
  coverage: string;
  blobRef: string | null;
  label?: string;
  bytes?: string;
  reason?: string;
}

export interface SourceLocation {
  path: string;
  fileHash: string | null;
  symbol: string;
  line: number;
  module: string;
}

export interface EvidenceRef {
  kind: string;
  source: string;
  captureId?: string;
  refs: string[];
  reason?: string;
}

export interface StopInfo {
  reason: string;
  rawReason?: string;
  pc: Hex | null;
  cpuId: number;
  breakpointId?: number;
  previousPc?: Hex | null;
}

export interface Frame {
  schemaVersion: number;
  sessionId: string;
  epoch: number;
  frameId: number;
  parentFrameId: number | null;
  requestId: string;
  captureId: string;
  executionMode: 'live' | 'recorded';
  stop: StopInfo;
  eventRange: { first: string | null; last: string | null };
  coverage: { memory: string; events: string; unavailable: string[] };
  cpu: CpuSnapshot;
  memory: MemoryEntry[];
  devices: DeviceSnapshot[];
  diskVersions: Record<string, string>;
  os: OsSnapshot | null;
  source: SourceLocation | null;
  lesson: LessonMatch | null;
  fenceSeq?: number | null;
  eventWatermark?: string | null;
  frameBoundary?: unknown;
  pendingIo?: unknown;
  evidence: Record<string, EvidenceRef>;
  recording: {
    reconstructible: boolean;
    checkpointFrameId: number;
    instructionGaps: Array<{ fromFrameId: number; toFrameId: number; note: string }>;
    memoryGaps: string[];
    events: string;
    note?: string;
  };
  committedAt: string;
  captureMs?: number | null;
}

export interface Breakpoint {
  id: number | null;
  spec: string;
  hardware: boolean;
  hitCount: number;
  address: Hex | null;
  pending: boolean;
}

export interface SymbolStage {
  id: string;
  title?: string;
  hasSymbols: boolean;
  reason?: string;
  loadRange?: [string, string] | null;
  loadAddress?: string | null;
}

/** 符号解析候选（服务端 symbols.resolve 返回）。 */
export interface SymbolCandidate {
  module?: string;
  moduleLabel?: string;
  symbol?: string;
  /** ELF 链接地址 */
  address?: string;
  type?: string;
  global?: boolean;
  /** 实测装载地址，未实测为 null */
  loadAddress?: string | null;
}

export interface SessionInfo {
  id: string;
  profile: string;
  state: string;
  epoch: number;
  frameCount: number;
  latestFrameId: number | null;
  mode: 'live' | 'recorded';
  viewFrameId: number;
  breakpoints: Breakpoint[];
  terminalBytes: number;
  qmpVersion: unknown;
  capabilities: Capabilities | null;
  symbols: SymbolStage[];
  symbolPlan: unknown;
}

export interface CapabilityEntry {
  status: 'verified' | 'unavailable' | 'unknown';
  evidence?: string;
  note?: string;
}

export interface Capabilities {
  schema: string;
  observer: { version: number; qemuVersion: string; patched: boolean };
  standard: Record<string, CapabilityEntry>;
  observer_: Record<string, CapabilityEntry>;
  events: Record<string, CapabilityEntry>;
  devices: Record<string, CapabilityEntry>;
  droppedEvents: number;
  knownGaps: string[];
}

export interface MemoryReadResult {
  attribution: { sessionId: string; epoch: number; frameId: number; captureId: string | null };
  addressSpace: string;
  address: Hex;
  length: number;
  /** base64 */
  bytes: string;
  /** 连续小写十六进制 */
  hex: string;
  blobRef: string | null;
  withinCapture: boolean;
  evidence: EvidenceRef;
}

export interface MemoryView {
  /** 用户请求的地址 */
  requestedAddress: string;
  addressSpace: 'physical' | 'linear';
  length: number;
  status: 'idle' | 'loading' | 'ok' | 'error';
  result: MemoryReadResult | null;
  error: { code?: string; message: string } | null;
}

export interface CommandEnvelopeInput {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * T08/T09：完整组件与回放使用的类型
 * ------------------------------------------------------------------ */

export interface DeviceField {
  name: string;
  meaning?: string;
  width?: number;
  value: string | number | boolean | null;
}

export interface DeviceSnapshot {
  deviceId?: string;
  kind: string;
  pciAddress?: string;
  registerRanges?: Array<{ name?: string; base?: string; size?: string; owner?: string }>;
  fields: DeviceField[];
  readOnly?: boolean;
  virtqueues?: unknown;
  evidence?: EvidenceRef;
}

export interface ProcessRef {
  pid: number;
  tgid: number;
  taskAddress: Hex;
  comm: string;
  state: string;
  stateRaw: number;
  parentPid: number | null;
  mmAddress: Hex | null;
  stackAddress: Hex | null;
  threads: number[];
  evidence?: EvidenceRef;
}

export interface VmaRef {
  address: Hex;
  end: Hex;
  permissions: string;
  source: string | null;
  fileOffset: Hex | null;
}

export interface AddressSpaceRef {
  pid: number;
  mmAddress: Hex;
  startCode: Hex | null;
  endCode: Hex | null;
  startStack: Hex | null;
  pgdPhysical: Hex | null;
  vmas: VmaRef[];
  truncated: boolean;
  structure: string;
  evidence?: EvidenceRef;
}

export interface FileRef {
  fd: number;
  fileAddress: Hex;
  offset: Hex;
  flags: Hex;
  dentryAddress: Hex | null;
  inodeAddress: Hex | null;
  path: string | null;
  inodeNumber: string | null;
  deviceId: string | null;
  size: Hex | null;
  refCount: number | null;
  evidence?: EvidenceRef;
}

export interface FolioRef {
  address: Hex;
  fileOffset: Hex | null;
  pfn: Hex | null;
  dirty: boolean;
  uptodate: boolean;
  inodeAddress: Hex | null;
  evidence?: EvidenceRef;
}

export interface OsSnapshot {
  kernelRelease: string;
  initTaskAddress: Hex | null;
  current: ProcessRef | null;
  selected: ProcessRef | null;
  processes: ProcessRef[];
  processesTruncated: boolean;
  addressSpace: AddressSpaceRef | null;
  files: FileRef[];
  folios: FolioRef[];
  decoderVersion: string;
  evidence?: EvidenceRef;
  notes?: string[];
}

export interface LessonMatch {
  lessonId: string;
  stage: string;
  title: string;
  reason: string;
  checksPassed: boolean;
  checksDiff?: string[];
  explain: {
    purpose: string;
    io: string;
    instructions: Record<string, string>;
    concepts: string[];
    fieldRefs: string[];
  };
  focus: {
    cpuFields: string[];
    addresses: Hex[];
    source?: { module: string; symbol: string };
    deviceId?: string;
  } | null;
  questions: Array<{ prompt: string; evidenceRefs: string[] }>;
  evidence: string[];
  observe: unknown;
  execution: unknown;
  priority: number;
}

export interface FrameSummary {
  frameId: number;
  parentFrameId: number | null;
  reason: string;
  pc: Hex | null;
  cpuId: number;
  source: string | null;
  module: string | null;
  line: number | null;
  lessonId: string | null;
  lessonTitle: string | null;
  memoryCoverage: string;
  eventsCoverage: string;
  committedAt: string;
  captureMs?: number | null;
}

export interface FrameList {
  sessionId: string;
  epoch: number;
  liveFrameId: number | null;
  viewFrameId: number;
  mode: 'live' | 'recorded';
  frames: FrameSummary[];
}

export interface CurriculumLesson {
  id: string;
  title: string;
  stage: string;
  profileId: string | null;
  trigger: Record<string, unknown>;
  execution: unknown;
  purpose: string | null;
  priority: number;
  available: boolean;
  reason?: string;
}

export interface Curriculum {
  schema: string;
  version: string | null;
  profileId: string;
  lessons: CurriculumLesson[];
  unavailable: Array<{ lessonId: string; reason: string }>;
  note?: string | null;
}

export interface PageWalkEntry {
  tableAddress: Hex;
  index: number;
  raw: Hex;
  present: boolean;
  writable: boolean;
  user: boolean;
  huge: boolean;
  physicalAddress: Hex | null;
  noExecute: boolean;
  evidence?: EvidenceRef;
}

export interface PageWalkResult {
  linear: Hex;
  physical: Hex | null;
  pageSize: number | null;
  huge: boolean;
  fault: { kind: string; level: number; detail: string } | null;
  walk: PageWalkEntry[];
  mode: string;
  evidence?: EvidenceRef;
}

export interface MachineEvent {
  seq: string;
  kind: string;
  cpuId?: number;
  instructionId?: string;
  deviceId?: string;
  requestId?: string;
  pc?: Hex;
  addressSpace?: string;
  address?: Hex;
  size?: number;
  bytes?: string;
  phase?: string;
  at?: string;
}

export interface EventsResult {
  schema: string;
  epoch: number;
  source: 'observer' | 'service';
  events: MachineEvent[];
  truncated?: boolean;
  dropped?: number;
  watermark?: string | null;
  note?: string;
}

export interface FileSystemEntry {
  name?: string;
  ino: string;
  fileType: string;
  byteOffset?: string;
  childOf?: string;
  inode?: {
    modeText?: string;
    fileType?: string;
    size?: string;
    links?: number | null;
    extents?: Array<{
      startBlock: string;
      blockCount: number;
      physicalStart: string | null;
      hole: boolean;
      pathName: string;
    }>;
    indirectBlocks?: string[];
    blockMapError?: string;
  };
  resolved?: boolean;
  path?: string;
  entries?: FileSystemEntry[];
}

export interface FileSystemView {
  schema: string;
  requestedPath: string;
  resolved: boolean;
  missing: string | null;
  path: string;
  inode: FileSystemEntry['inode'] & { ino?: string; notes?: string[] };
  versionId: string | null;
  frameDiskVersion?: string | null;
  frameId?: number | null;
  baseSha256: string | null;
  diskId: string;
  superblock: {
    blockSize: number;
    blocksCount: number;
    inodesCount: number;
    inodeSize: number;
    volumeName: string;
  };
  entries: FileSystemEntry[];
  notes: string[];
  diskReads: number;
  note?: string;
}

export interface ReplayState {
  mode: 'live' | 'recorded';
  viewFrameId: number | null;
  playing: boolean;
  speed: number;
}

export interface RecordingSummary {
  id: string;
  sha256: string;
  importedAt: string;
  frameCount: number;
  manifest: unknown;
}
