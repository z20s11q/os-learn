/** 能力描述来自实际探测；界面与解析器依据能力状态和缺口原因展示字段。 */

export type CapabilityStatus = 'verified' | 'unavailable' | 'unknown';

export interface CapabilityEntry {
  status: CapabilityStatus;
  /** verified 必须有证据路径或命令 */
  evidence?: string;
  /** unavailable 必须说明原因，作为 T05 的明确清单 */
  note?: string;
}

/** 观察扩展协议版本。补丁与宿主协议必须匹配才允许连接。 */
export interface ObserverProtocol {
  /** 本方案定义的版本，例如 1 */
  version: number;
  /** 实际 QEMU 版本，例如 8.2.10 */
  qemuVersion: string;
  /** 补丁是否已编入当前二进制 */
  patched: boolean;
}

export interface Capabilities {
  schema: 'oslab.capabilities/1';
  observer: ObserverProtocol;
  /** 标准接口即可提供的能力 */
  standard: {
    singleStep: CapabilityEntry;
    breakpoint: CapabilityEntry;
    registerRead: CapabilityEntry;
    memoryRead: CapabilityEntry;
    physicalMemoryRead: CapabilityEntry;
    qmpBlockQuery: CapabilityEntry;
    terminalSerial: CapabilityEntry;
    terminalVgaInput: CapabilityEntry;
  };
  /** 需要观察扩展的能力，对应 x-oslab-* 接口 */
  observer_: {
    capabilities: CapabilityEntry;
    captureSnapshot: CapabilityEntry;
    readPhysical: CapabilityEntry;
    events: CapabilityEntry;
    release: CapabilityEntry;
  };
  /** 事件覆盖：某类事件是否可采，以及字段是否齐全 */
  events: Record<string, CapabilityEntry>;
  /** 设备快照支持的无副作用只读字段 */
  devices: Record<string, CapabilityEntry>;
  /** 采集过程中累计丢失的事件数，界面据此显示失真提示 */
  droppedEvents: number;
  /** 已知缺口，与 T05 任务清单对应 */
  knownGaps: string[];
}

/** 能力缺口的降级原因，供面板展示提示。 */
export interface CapabilityGap {
  field: string;
  reason: string;
  /** 负责该字段能力的任务编号，便于追踪 */
  plannedTask?: string;
}
