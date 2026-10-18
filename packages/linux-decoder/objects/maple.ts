/** VMA 容器 mm_struct.mm_mt 的 Maple Tree 限定遍历。
 * 编码指针提供节点地址和类型；根分为空树、单条目和节点树。
 * 槽区间按 pivot 和父节点 max 计算，数据末槽分别按 mas_data_end 与 dumper 规则核对。
 * 遍历记录节点/深度上限、环及内部空槽，返回每个叶子槽的 min/max/value。
 */

import { CaptureReadError, memoryEvidence } from '../capture.ts';
import type { KernelMemoryView } from '../capture.ts';
import type { KernelLayout } from '../layout.ts';
import type { EvidenceRef } from '../../contracts/common.ts';
import { toHex } from '../../contracts/common.ts';

export class MapleParseError extends CaptureReadError {}

/** 无符号长整型的最大值，也就是"这段下标一直到最后"的上界。 */
export const ULONG_MAX = 0xffff_ffff_ffff_ffffn;
/** 节点编码指针里被借走的低位（节点 256 字节对齐，低 8 位都可借）。 */
export const MAPLE_NODE_MASK = 255n;
export const MAPLE_NODE_TYPE_SHIFT = 3;
export const MAPLE_NODE_TYPE_MASK = 0x0fn;
/** 4096 以下且低两位为 0b10 的内部保留值 */
export const MAPLE_RESERVED_RANGE = 4096n;
/** 树高度的上限（`MAPLE_HEIGHT_MAX`）。 */
export const MAPLE_HEIGHT_MAX = 31;

export const MT_FLAGS_ALLOC_RANGE = 0x01;
export const MT_FLAGS_USE_RCU = 0x02;
export const MT_FLAGS_HEIGHT_OFFSET = 0x02;
export const MT_FLAGS_HEIGHT_MASK = 0x7c;
export const MT_FLAGS_LOCK_MASK = 0x300;

/** 节点类型（内核 `enum maple_type`，顺序即取值）。 */
export const MAPLE_DENSE = 0;
export const MAPLE_LEAF_64 = 1;
export const MAPLE_RANGE_64 = 2;
export const MAPLE_ARANGE_64 = 3;
export const MAPLE_TYPE_NAMES = ['maple_dense', 'maple_leaf_64', 'maple_range_64', 'maple_arange_64'];

/** 叶子存数据，其余存子节点（`ma_is_leaf()`：类型小于 range_64 就是叶子）。 */
export function isMapleLeaf(type: number): boolean {
  return type < MAPLE_RANGE_64;
}

export function mapleNodeType(entry: bigint): number {
  return Number((entry >> BigInt(MAPLE_NODE_TYPE_SHIFT)) & BigInt(MAPLE_NODE_TYPE_MASK));
}

export function mapleNodeAddress(entry: bigint): bigint {
  return entry & ~MAPLE_NODE_MASK;
}

/** `xa_is_node()`：低两位是 0b10 且大于 4096。 */
export function isMapleNode(entry: bigint): boolean {
  return (entry & 3n) === 2n && entry > MAPLE_RESERVED_RANGE;
}

/* 节点布局由 DWARF 清单提供。 */

/**
 * `maple_node` 是个联合体，三个成员（`mr64`/`ma64`/基址形态）都从 0 开始，
 * 所以成员结构体里的偏移**就是**节点内的偏移。这里逐项取出来，
 * 是因为这些偏移是 `struct maple_arange_64` 里 pivot/slot/gap 的排列顺序决定的，
 * 内核改了排列（或者换了个 `unsigned long` 宽度的架构）就会整体变形。
 */
export interface MapleNodeLayout {
  nodeBytes: number;
  parentOffset: number;
  /** 类型 → pivot 数组在节点内的偏移与元素个数 */
  pivotOffset: Record<number, number>;
  pivotCount: Record<number, number>;
  /** 类型 → slot 数组在节点内的偏移与元素个数 */
  slotOffset: Record<number, number>;
  slotCount: Record<number, number>;
  /** 类型 → gap 数组（只有 arange 有） */
  gapOffset: Record<number, number>;
  gapCount: Record<number, number>;
  /** 类型 → meta（end/gap 两个字节）在节点内的偏移 */
  metaOffset: Record<number, number>;
  metaEndOffsetInStruct: number;
  metaGapOffsetInStruct: number;
}

/** x86_64 上指针与 `unsigned long` 都是 8 字节，数组元素个数由字节宽除出来。 */
const ARRAY_ELEMENT_BYTES = 8;

export function mapleNodeLayout(layout: KernelLayout): MapleNodeLayout {
  const arrayOf = (typeName: string, path: string): { offset: number; count: number } => {
    const field = layout.field(typeName, path);
    return {
      offset: field.byteOffset,
      count: Math.floor((field.byteSize ?? 0) / ARRAY_ELEMENT_BYTES),
    };
  };

  const denseSlot = arrayOf('maple_node', 'slot');
  const rangePivot = arrayOf('maple_range_64', 'pivot');
  const rangeSlot = arrayOf('maple_range_64', 'slot');
  const arangePivot = arrayOf('maple_arange_64', 'pivot');
  const arangeSlot = arrayOf('maple_arange_64', 'slot');
  const arangeGap = arrayOf('maple_arange_64', 'gap');
  const rangeMeta = layout.field('maple_range_64', 'meta').byteOffset;
  const arangeMeta = layout.field('maple_arange_64', 'meta').byteOffset;

  const nodeBytes = layout.type('maple_node').byteSize ?? 256;
  return {
    nodeBytes,
    parentOffset: layout.field('maple_node', 'parent').byteOffset,
    pivotOffset: {
      [MAPLE_DENSE]: 0,
      [MAPLE_LEAF_64]: rangePivot.offset,
      [MAPLE_RANGE_64]: rangePivot.offset,
      [MAPLE_ARANGE_64]: arangePivot.offset,
    },
    pivotCount: {
      [MAPLE_DENSE]: 0,
      [MAPLE_LEAF_64]: rangePivot.count,
      [MAPLE_RANGE_64]: rangePivot.count,
      [MAPLE_ARANGE_64]: arangePivot.count,
    },
    slotOffset: {
      [MAPLE_DENSE]: denseSlot.offset,
      [MAPLE_LEAF_64]: rangeSlot.offset,
      [MAPLE_RANGE_64]: rangeSlot.offset,
      [MAPLE_ARANGE_64]: arangeSlot.offset,
    },
    slotCount: {
      [MAPLE_DENSE]: denseSlot.count,
      [MAPLE_LEAF_64]: rangeSlot.count,
      [MAPLE_RANGE_64]: rangeSlot.count,
      [MAPLE_ARANGE_64]: arangeSlot.count,
    },
    gapOffset: {
      [MAPLE_DENSE]: 0,
      [MAPLE_LEAF_64]: 0,
      [MAPLE_RANGE_64]: 0,
      [MAPLE_ARANGE_64]: arangeGap.offset,
    },
    gapCount: {
      [MAPLE_DENSE]: 0,
      [MAPLE_LEAF_64]: 0,
      [MAPLE_RANGE_64]: 0,
      [MAPLE_ARANGE_64]: arangeGap.count,
    },
    metaOffset: {
      [MAPLE_DENSE]: 0,
      [MAPLE_LEAF_64]: rangeMeta,
      [MAPLE_RANGE_64]: rangeMeta,
      [MAPLE_ARANGE_64]: arangeMeta,
    },
    metaEndOffsetInStruct: layout.field('maple_metadata', 'end').byteOffset,
    metaGapOffsetInStruct: layout.field('maple_metadata', 'gap').byteOffset,
  };
}

/* --------------------------------------------------------------------------
 * 读一个节点
 * ------------------------------------------------------------------------ */

export interface MapleNodeFacts {
  address: bigint;
  type: number;
  typeName: string;
  isLeaf: boolean;
  slotCount: number;
  pivotCount: number;
  pivots: bigint[];
  slots: bigint[];
  gaps: bigint[] | null;
  metaEnd: number | null;
  metaGap: number | null;
  /** 按 `mas_data_end()` 规则算出的"最后一个有数据的槽" */
  dataEnd: number;
  /** 按内核自带 dumper 的停机规则算出的"最后一个有数据的槽" */
  dumpEnd: number;
  /** 两条规则是否一致 */
  dataEndAgrees: boolean;
  notes: string[];
}

function readLittleEndian(bytes: Uint8Array, offset: number, width: number): bigint {
  let value = 0n;
  for (let index = width - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
  }
  return value;
}

/** 按编码指针提供的类型读取 Maple 节点。 */
export async function readMapleNode(
  view: KernelMemoryView,
  nodeLayout: MapleNodeLayout,
  address: bigint,
  type: number,
  nodeMax: bigint = ULONG_MAX,
): Promise<MapleNodeFacts> {
  const notes: string[] = [];
  if (address === 0n) {
    throw new MapleParseError('null-node', 'maple 节点地址为 0，指向不了任何节点', { type });
  }
  const bytes = await view.bytes(address, nodeLayout.nodeBytes);
  const pivotCount = nodeLayout.pivotCount[type] ?? 0;
  const slotCount = nodeLayout.slotCount[type] ?? 0;
  const pivots: bigint[] = [];
  for (let index = 0; index < pivotCount; index += 1) {
    pivots.push(readLittleEndian(bytes, nodeLayout.pivotOffset[type] + index * ARRAY_ELEMENT_BYTES, ARRAY_ELEMENT_BYTES));
  }
  const slots: bigint[] = [];
  for (let index = 0; index < slotCount; index += 1) {
    slots.push(readLittleEndian(bytes, nodeLayout.slotOffset[type] + index * ARRAY_ELEMENT_BYTES, ARRAY_ELEMENT_BYTES));
  }
  const gapCount = nodeLayout.gapCount[type] ?? 0;
  let gaps: bigint[] | null = null;
  if (gapCount > 0) {
    gaps = [];
    for (let index = 0; index < gapCount; index += 1) {
      gaps.push(readLittleEndian(bytes, nodeLayout.gapOffset[type] + index * ARRAY_ELEMENT_BYTES, ARRAY_ELEMENT_BYTES));
    }
  }
  let metaEnd: number | null = null;
  let metaGap: number | null = null;
  if (type !== MAPLE_DENSE) {
    const metaBase = nodeLayout.metaOffset[type];
    metaEnd = bytes[metaBase + nodeLayout.metaEndOffsetInStruct] ?? 0;
    metaGap = bytes[metaBase + nodeLayout.metaGapOffsetInStruct] ?? 0;
  }

  const facts: MapleNodeFacts = {
    address,
    type,
    typeName: MAPLE_TYPE_NAMES[type] ?? `unknown(${type})`,
    isLeaf: isMapleLeaf(type),
    slotCount,
    pivotCount,
    pivots,
    slots,
    gaps,
    metaEnd,
    metaGap,
    dataEnd: 0,
    dumpEnd: 0,
    dataEndAgrees: true,
    notes,
  };
  facts.dataEnd = computeDataEnd(facts, nodeMax);
  if (type === MAPLE_DENSE) {
    // dense 的槽与下标直接对应。
    // 数据末槽按非空槽计算，pivot/meta 互校仅用于对应节点类型。
    facts.dumpEnd = facts.dataEnd;
    facts.dataEndAgrees = true;
    notes.push('这是 maple_dense 节点：它没有 pivot 也没有 meta，两条 data_end 规则都不适用');
  } else {
    facts.dumpEnd = computeDumpEnd(facts, nodeMax);
    facts.dataEndAgrees = facts.dataEnd === facts.dumpEnd;
  }
  if (!facts.dataEndAgrees) {
    notes.push(
      `节点 ${toHex(address)} 的两条"最后有数据的槽"规则不一致：`
      + `mas_data_end 规则给出 ${facts.dataEnd}，内核 dumper 的停机规则给出 ${facts.dumpEnd}`
      + '（这一类不一致通常意味着节点正在被并发改写，或内存已经损坏）',
    );
  }
  return facts;
}

/** `mas_data_end()`：arange 直接读 meta；其余先看最后一个 pivot，再看 meta。 */
function computeDataEnd(node: MapleNodeFacts, nodeMax: bigint): number {
  if (node.type === MAPLE_ARANGE_64) return node.metaEnd ?? 0;
  if (node.type === MAPLE_DENSE) {
    // dense 槽覆盖 min+i，末槽取最后一个非空位置。
    // 该路径兼容 mt_dump_node 的 dense 形态。
    let last = -1;
    for (let index = 0; index < node.slotCount; index += 1) if (node.slots[index] !== 0n) last = index;
    return last;
  }
  const lastPivotIndex = node.pivotCount - 1;
  const lastPivot = node.pivots[lastPivotIndex] ?? 0n;
  if (lastPivot === 0n) return node.metaEnd ?? 0;
  if (lastPivot === nodeMax) return lastPivotIndex;
  return node.pivotCount;
}

/** 内核 dumper（`mt_dump_range64()` / `mt_dump_arange64()`）的停机规则。 */
function computeDumpEnd(node: MapleNodeFacts, nodeMax: bigint): number {
  let last = -1;
  for (let index = 0; index < node.slotCount; index += 1) {
    let upper: bigint;
    if (index < node.pivotCount) {
      upper = node.pivots[index];
    } else if (node.type === MAPLE_ARANGE_64) {
      if (node.slots[index] === 0n) break;
      upper = nodeMax;
    } else if (node.type === MAPLE_DENSE) {
      upper = nodeMax;
    } else {
      // range/leaf：最后一个槽为空且本节点不是根时停机（`max != mt_node_max()`）
      if (node.slots[index] === 0n && nodeMax !== ULONG_MAX) break;
      upper = nodeMax;
    }
    if (upper === 0n && index > 0) break;
    last = index;
    if (upper === nodeMax) break;
  }
  return last;
}

/* --------------------------------------------------------------------------
 * 树本身
 * ------------------------------------------------------------------------ */

export interface MapleTreeFacts {
  address: bigint;
  maFlags: number;
  /** 树标志里记录的高度（`(ma_flags & MT_FLAGS_HEIGHT_MASK) >> MT_FLAGS_HEIGHT_OFFSET`） */
  heightField: number;
  /** 是否带 `MT_FLAGS_ALLOC_RANGE`（VMA 树带，于是内部节点是 arange） */
  allocRange: boolean;
  useRcu: boolean;
  lockMode: number;
  /** `ma_root` 原始值（可能编码了节点类型，也可能就是数据本身） */
  rootRaw: bigint;
}

export async function readMapleTree(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<MapleTreeFacts> {
  const flagsOffset = layout.byteOffset('maple_tree', 'ma_flags');
  const rootOffset = layout.byteOffset('maple_tree', 'ma_root');
  const maFlags = await view.u32(address + BigInt(flagsOffset));
  const rootRaw = await view.u64(address + BigInt(rootOffset));
  return {
    address,
    maFlags,
    heightField: (maFlags & MT_FLAGS_HEIGHT_MASK) >> MT_FLAGS_HEIGHT_OFFSET,
    allocRange: (maFlags & MT_FLAGS_ALLOC_RANGE) !== 0,
    useRcu: (maFlags & MT_FLAGS_USE_RCU) !== 0,
    lockMode: maFlags & MT_FLAGS_LOCK_MASK,
    rootRaw,
  };
}

/* --------------------------------------------------------------------------
 * 遍历
 * ------------------------------------------------------------------------ */

export interface MapleEntry {
  /** 槽区间下界（含） */
  min: bigint;
  /** 槽区间上界（含） */
  max: bigint;
  /** 槽里存的值：叶子是数据（VMA 指针），内部节点是编码后的子节点指针 */
  value: bigint;
  /** 根节点是第 1 层 */
  depth: number;
  nodeAddress: bigint;
  nodeType: number;
  slotIndex: number;
  /** 从根到本槽的槽位下标路径，便于复现与展示 */
  path: number[];
}

export interface MapleWalkOptions {
  /** 最多访问多少个节点 */
  maxNodes?: number;
  /** 最多下钻多少层（根算第 1 层） */
  maxDepth?: number;
  /** 只展开落在这个下标闭区间内的子树 */
  indexMin?: bigint;
  indexMax?: bigint;
  /** 每个叶子条目都过一遍的判据；返回非空字符串表示违反 */
  verifyEntry?: (entry: MapleEntry, node: MapleNodeFacts) => string | null;
}

export interface MapleWalkResult {
  tree: MapleTreeFacts;
  /** 根指针的形态：空树 / 单条目树 / 节点树 */
  rootKind: 'empty' | 'single-entry' | 'node';
  entries: MapleEntry[];
  /** 叶子空槽数，对应 VMA 映射空洞 */
  nullSlots: number;
  nodesVisited: number;
  maxDepth: number;
  truncated: boolean;
  cycle: boolean;
  /** 结构自身的矛盾之处（pivot 不单调、区间越界、内部槽不是节点指针……） */
  violations: string[];
  notes: string[];
  nodes: Array<{ address: bigint; type: number; typeName: string; dataEnd: number; dumpEnd: number; min: bigint; max: bigint; depth: number }>;
  evidence: EvidenceRef;
}

export const DEFAULT_MAX_MAPLE_NODES = 4096;

interface WalkFrame {
  nodeAddress: bigint;
  type: number;
  min: bigint;
  max: bigint;
  depth: number;
  path: number[];
}

/** 遍历返回叶子槽的 min/max/value，供 VMA 地址与覆盖区间逐项校验。 */
export async function walkMapleTree(
  view: KernelMemoryView,
  layout: KernelLayout,
  treeAddress: bigint,
  options: MapleWalkOptions = {},
): Promise<MapleWalkResult> {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_MAPLE_NODES;
  const maxDepth = options.maxDepth ?? MAPLE_HEIGHT_MAX;
  const indexMin = options.indexMin ?? 0n;
  const indexMax = options.indexMax ?? ULONG_MAX;
  const nodeLayout = mapleNodeLayout(layout);
  const tree = await readMapleTree(view, layout, treeAddress);

  const entries: MapleEntry[] = [];
  const nodes: MapleWalkResult['nodes'] = [];
  const violations: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let nullSlots = 0;
  let nodesVisited = 0;
  let observedDepth = 0;
  let truncated = false;
  let cycle = false;
  let rootKind: MapleWalkResult['rootKind'];

  const stack: WalkFrame[] = [];
  if (tree.rootRaw === 0n) {
    rootKind = 'empty';
  } else if (isMapleNode(tree.rootRaw)) {
    rootKind = 'node';
    stack.push({
      nodeAddress: mapleNodeAddress(tree.rootRaw),
      type: mapleNodeType(tree.rootRaw),
      min: 0n,
      max: ULONG_MAX,
      depth: 1,
      path: [],
    });
  } else {
    // 单条目树：数据直接躺在根指针里，且只代表下标 0（`mas_store_root()`）。
    rootKind = 'single-entry';
    notes.push(
      `ma_root = ${toHex(tree.rootRaw)} 不是节点指针：这是"单条目树"，数据直接存在根指针里，`
      + '只覆盖下标 0。VMA 树不该出现这种形态（VMA 的起始地址不可能是 0）',
    );
    if (tree.rootRaw >= indexMin && indexMin === 0n && indexMax >= 0n) {
      entries.push({
        min: 0n,
        max: 0n,
        value: tree.rootRaw,
        depth: 1,
        nodeAddress: 0n,
        nodeType: -1,
        slotIndex: 0,
        path: [],
      });
    }
  }

  while (stack.length > 0) {
    const frame = stack.pop() as WalkFrame;
    if (nodesVisited >= maxNodes) {
      truncated = true;
      notes.push(`访问节点数达到上限 ${maxNodes}，停止；树里可能还有更多节点`);
      break;
    }
    if (frame.depth > maxDepth) {
      truncated = true;
      notes.push(`下钻层数超过上限 ${maxDepth} 层，停止`);
      break;
    }
    const key = frame.nodeAddress.toString(16);
    if (seen.has(key)) {
      cycle = true;
      violations.push(`节点 ${toHex(frame.nodeAddress)} 被访问了两次：树里有环，或遍历中途被并发改写`);
      continue;
    }
    seen.add(key);
    nodesVisited += 1;
    observedDepth = Math.max(observedDepth, frame.depth);

    if (frame.type !== MAPLE_DENSE && frame.nodeAddress % 256n !== 0n) {
      violations.push(`节点 ${toHex(frame.nodeAddress)} 不是 256 字节对齐：编码指针解出来的地址不对`);
    }

    let node: MapleNodeFacts;
    try {
      node = await readMapleNode(view, nodeLayout, frame.nodeAddress, frame.type, frame.max);
    } catch (error) {
      violations.push(
        `读节点 ${toHex(frame.nodeAddress)}（类型 ${MAPLE_TYPE_NAMES[frame.type] ?? frame.type}）失败：`
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    nodes.push({
      address: frame.nodeAddress,
      type: node.type,
      typeName: node.typeName,
      dataEnd: node.dataEnd,
      dumpEnd: node.dumpEnd,
      min: frame.min,
      max: frame.max,
      depth: frame.depth,
    });
    notes.push(...node.notes);
    if (!node.dataEndAgrees) {
      violations.push(...node.notes.filter((note) => note.includes('两条')));
    }
    if (frame.type === MAPLE_DENSE) {
      notes.push(
        `节点 ${toHex(frame.nodeAddress)} 是 maple_dense：本内核（6.12）不创建 dense 节点，`
        + '遇到它说明读到的东西不是本内核的 maple 节点',
      );
    }
    if (node.type === MAPLE_ARANGE_64 && !tree.allocRange && frame.depth > 1) {
      notes.push(
        `${toHex(frame.nodeAddress)} 是 arange 节点，但树标志里没有 MT_FLAGS_ALLOC_RANGE：`
        + '分配型的树内部节点才是 arange，这一点对不上',
      );
    }

    // 逐槽走一遍，规则照搬 mt_dump_range64/mt_dump_arange64。
    const children: WalkFrame[] = [];
    let first = frame.min;
    for (let index = 0; index < node.slotCount; index += 1) {
      let upper: bigint;
      if (node.type === MAPLE_DENSE) {
        upper = frame.min + BigInt(index);
        if (upper > frame.max) {
          violations.push(`dense 节点 ${toHex(frame.nodeAddress)} 的槽 ${index} 越出了本节点的上界`);
          break;
        }
      } else if (index < node.pivotCount) {
        upper = node.pivots[index];
      } else if (node.type === MAPLE_ARANGE_64) {
        if (node.slots[index] === 0n) break;
        upper = frame.max;
      } else {
        if (node.slots[index] === 0n && frame.max !== ULONG_MAX) break;
        upper = frame.max;
      }
      if (upper === 0n && index > 0 && node.type !== MAPLE_DENSE) break;

      if (node.type !== MAPLE_DENSE && index > 0 && index < node.pivotCount) {
        const previous = node.pivots[index - 1];
        if (node.pivots[index] !== frame.max && node.pivots[index] <= previous) {
          violations.push(
            `节点 ${toHex(frame.nodeAddress)} 的 pivot 不单调：pivot[${index - 1}]=${previous} `
            + `>= pivot[${index}]=${node.pivots[index]}`,
          );
        }
      }
      if (upper < first && node.type !== MAPLE_DENSE) {
        violations.push(
          `节点 ${toHex(frame.nodeAddress)} 的槽 ${index} 区间上界 ${upper} 小于下界 ${first}：区间反了`,
        );
      }

      const value = node.slots[index];
      const slot: MapleEntry = {
        min: first,
        max: upper,
        value,
        depth: frame.depth + 1,
        nodeAddress: frame.nodeAddress,
        nodeType: node.type,
        slotIndex: index,
        path: [...frame.path, index],
      };

      if (node.isLeaf) {
        if (value === 0n) {
          nullSlots += 1;
        } else {
          // 下标区间过滤：只要交叠就收，交叠多少由调用方判断。
          if (slot.max >= indexMin && slot.min <= indexMax) {
            entries.push(slot);
            if (options.verifyEntry) {
              const message = options.verifyEntry(slot, node);
              if (message !== null) violations.push(message);
            }
          }
        }
      } else if (value === 0n) {
        notes.push(
          `内部节点 ${toHex(frame.nodeAddress)} 的槽 ${index} 是空的（区间 [${slot.min}, ${slot.max}]）：`
          + '成型的树里内部节点的槽都应当指向子节点',
        );
      } else if (isMapleNode(value)) {
        const childMin = slot.min;
        const childMax = slot.max;
        if (childMax >= indexMin && childMin <= indexMax) {
          children.push({
            nodeAddress: mapleNodeAddress(value),
            type: mapleNodeType(value),
            min: childMin,
            max: childMax,
            depth: frame.depth + 1,
            path: slot.path,
          });
        }
      } else {
        violations.push(
          `内部节点 ${toHex(frame.nodeAddress)} 的槽 ${index} 里是 ${toHex(value)}：`
          + '既不是空、也不是编码后的节点指针（低两位不是 0b10 或地址太小）',
        );
      }

      if (upper === frame.max) break;
      first = upper + 1n;
    }

    // 反向压栈，弹出来就是从左到右的顺序。
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }

  notes.push(
    `树标志：ma_flags=${toHex(BigInt(tree.maFlags))}，高度字段=${tree.heightField}，`
    + `alloc_range=${tree.allocRange}；实测层数=${observedDepth}`,
  );
  if (rootKind === 'node' && tree.heightField !== observedDepth) {
    notes.push(
      `树标志里的高度（${tree.heightField}）与实测层数（${observedDepth}）不同：`
      + '高度字段由内核在改动后维护，并发改写时可能暂时滞后；实测层数来自这次遍历，以它为准',
    );
  }
  if (tree.allocRange !== true) {
    notes.push('树的 ma_flags 里没有 MT_FLAGS_ALLOC_RANGE：VMA 树（MM_MT_FLAGS）应当带这个标志');
  }

  const capture = view.evidenceSource;
  return {
    tree,
    rootKind,
    entries,
    nullSlots,
    nodesVisited,
    maxDepth: observedDepth,
    truncated,
    cycle,
    violations,
    notes,
    nodes,
    evidence: memoryEvidence(capture, treeAddress, 16, [
      `maple-tree:${toHex(treeAddress)}`,
      `root:${toHex(tree.rootRaw)}`,
      `nodes:${nodesVisited}`,
      `entries:${entries.length}`,
    ]),
  };
}
