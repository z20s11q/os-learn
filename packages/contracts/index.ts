/** 协议包入口，导出类型与纯函数校验器。 */

export * from './common.ts';
export * from './cpu.ts';
export * from './memory.ts';
export * from './device.ts';
export * from './os.ts';
export * from './event.ts';
export * from './frame.ts';
export * from './command.ts';
export * from './capabilities.ts';
export * from './lesson.ts';
export * from './recording.ts';
export * from './errors.ts';
export * from './validate.ts';

/** 协议版本；与 Frame.schemaVersion 保持一致，变更时同步递增。 */
export const CONTRACT_SCHEMA_VERSION = 1 as const;
