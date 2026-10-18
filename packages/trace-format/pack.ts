/** 录制包读写与回放：帧索引定位数据检查点与增量，导入时校验散列与 schema。 */

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  FrameIndexEntry,
  RecordingFileEntry,
  RecordingManifest,
  RecordingVerification,
} from '../contracts/recording.ts';
import { RECORDING_SCHEMA_VERSION } from '../contracts/recording.ts';
import type { ViewMode } from '../contracts/frame.ts';
import { hashObject, hashFile, sha256Hex, writeBlob } from './hash.ts';

export interface RecordingLayout {
  root: string;
  framesDir: string;
  eventsDir: string;
  blobsDir: string;
  manifestPath: string;
  indexPath: string;
}

export function layout(root: string): RecordingLayout {
  return {
    root,
    framesDir: path.join(root, 'frames'),
    eventsDir: path.join(root, 'events'),
    blobsDir: path.join(root, 'blobs'),
    manifestPath: path.join(root, 'manifest.json'),
    indexPath: path.join(root, 'frames', 'index.jsonl'),
  };
}

export async function initRecording(root: string): Promise<RecordingLayout> {
  const paths = layout(root);
  await mkdir(paths.framesDir, { recursive: true });
  await mkdir(paths.eventsDir, { recursive: true });
  await mkdir(paths.blobsDir, { recursive: true });
  return paths;
}

function padFrame(frameId: number): string {
  return frameId.toString().padStart(10, '0');
}

/**
 * 追加一帧。帧数据与事件分块分别写文件，索引追加到 JSONL。
 * checkpoint 为 true 时记录一份完整数据，用于随机定位。
 */
export async function appendFrame(
  paths: RecordingLayout,
  input: {
    frameId: number;
    parentFrameId: number | null;
    epoch: number;
    frame: unknown;
    events: unknown[];
    committedAt: string;
    checkpoint: boolean;
  },
): Promise<{ frameEntry: FrameIndexEntry; files: RecordingFileEntry[] }> {
  const frameRel = path.join('frames', `${padFrame(input.frameId)}.json`);
  const eventRel = path.join('events', `${padFrame(input.frameId)}.jsonl`);
  const frameJson = JSON.stringify(input.frame);
  const eventJsonl = input.events.map((event) => JSON.stringify(event)).join('\n');

  await writeFile(path.join(paths.root, frameRel), frameJson);
  if (eventJsonl) {
    await writeFile(path.join(paths.root, eventRel), eventJsonl);
  }

  const files: RecordingFileEntry[] = [
    { path: frameRel, sha256: sha256Hex(frameJson), length: Buffer.byteLength(frameJson), role: 'frame', frameId: input.frameId },
  ];
  if (eventJsonl) {
    files.push({
      path: eventRel,
      sha256: sha256Hex(eventJsonl),
      length: Buffer.byteLength(eventJsonl),
      role: 'event-chunk',
      frameId: input.frameId,
    });
  }

  const frameEntry: FrameIndexEntry = {
    frameId: input.frameId,
    parentFrameId: input.parentFrameId,
    epoch: input.epoch,
    checkpoint: input.checkpoint,
    framePath: frameRel,
    eventChunkPath: eventJsonl ? eventRel : null,
    deltaPaths: [],
    committedAt: input.committedAt,
  };
  await appendFile(paths.indexPath, `${JSON.stringify(frameEntry)}\n`);
  return { frameEntry, files };
}

export async function readIndex(paths: RecordingLayout): Promise<FrameIndexEntry[]> {
  try {
    const raw = await readFile(paths.indexPath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as FrameIndexEntry);
  } catch {
    return [];
  }
}

export async function writeManifest(
  paths: RecordingLayout,
  manifest: Omit<RecordingManifest, 'manifestSha256'>,
): Promise<RecordingManifest> {
  const manifestSha256 = hashObject(manifest);
  const full: RecordingManifest = { ...manifest, manifestSha256 };
  await writeFile(paths.manifestPath, `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

export async function readManifest(paths: RecordingLayout): Promise<RecordingManifest | null> {
  try {
    return JSON.parse(await readFile(paths.manifestPath, 'utf8')) as RecordingManifest;
  } catch {
    return null;
  }
}

/** 按 manifest 校验录制数据文件的散列、schema 和帧索引。 */
export async function verifyRecording(root: string): Promise<RecordingVerification> {
  const paths = layout(root);
  const manifest = await readManifest(paths);
  const failures: RecordingVerification['failures'] = [];

  if (!manifest) {
    return {
      manifestOk: false,
      failures: [{ path: 'manifest.json', expected: '', actual: null, reason: 'missing' }],
      schemaCompatible: false,
      missingFrames: [],
      scriptsExecuted: false,
    };
  }

  const schemaCompatible = manifest.schema === RECORDING_SCHEMA_VERSION;

  for (const entry of manifest.files) {
    const absolute = path.join(root, entry.path);
    let actual: string | null = null;
    try {
      actual = await hashFile(absolute);
    } catch {
      failures.push({ path: entry.path, expected: entry.sha256, actual: null, reason: 'missing' });
      continue;
    }
    if (actual !== entry.sha256) {
      failures.push({ path: entry.path, expected: entry.sha256, actual, reason: 'checksum-mismatch' });
    }
  }

  const index = await readIndex(paths);
  const present = new Set(index.map((entry) => entry.frameId));
  const missingFrames: number[] = [];
  for (const entry of manifest.frames) {
    if (!present.has(entry.frameId)) missingFrames.push(entry.frameId);
  }

  return {
    manifestOk: failures.length === 0,
    failures,
    schemaCompatible,
    missingFrames,
    scriptsExecuted: false,
  };
}

/** 从存档索引定位目标帧及其最近的数据检查点，返回按帧顺序排列的路径。 */
export async function resolveViewFrame(
  paths: RecordingLayout,
  targetFrameId: number,
): Promise<{ checkpointFrameId: number; path: FrameIndexEntry[]; note: string } | null> {
  const index = await readIndex(paths);
  const sorted = [...index].sort((a, b) => a.frameId - b.frameId);
  const target = sorted.find((entry) => entry.frameId === targetFrameId);
  if (!target) return null;
  const checkpoint = [...sorted]
    .filter((entry) => entry.checkpoint && entry.frameId <= targetFrameId)
    .at(-1);
  if (!checkpoint) {
    return {
      checkpointFrameId: targetFrameId,
      path: [target],
      note: '目标帧之前没有数据检查点；可能无法重建完整画面',
    };
  }
  const path_ = sorted.filter(
    (entry) => entry.frameId >= checkpoint.frameId && entry.frameId <= targetFrameId,
  );
  return {
    checkpointFrameId: checkpoint.frameId,
    path: path_,
    note: path_.length === targetFrameId - checkpoint.frameId + 1 ? '连续增量' : '增量区间不完整',
  };
}

/** 构造 recorded 视图状态，保留实时帧 ID 和调用方传入的暂停状态。 */
export function enterHistory(state: { liveFrameId: number; paused: boolean }, targetFrameId: number): ViewMode {
  return {
    mode: 'recorded',
    liveFrameId: state.liveFrameId,
    viewFrameId: targetFrameId,
    pausedBeforeHistory: state.paused,
  };
}

export function returnToLive(state: ViewMode): ViewMode {
  return {
    mode: 'live',
    liveFrameId: state.liveFrameId,
    viewFrameId: state.liveFrameId,
    pausedBeforeHistory: state.pausedBeforeHistory,
  };
}

/** 配额判断：占用字节数达到上限时返回 true。 */
export function quotaExceeded(bytesUsed: number, quotaBytes: number): boolean {
  return bytesUsed >= quotaBytes;
}

/** 写一个 blob 并返回目录记录，供帧内大对象引用。 */
export async function storeBlob(root: string, bytes: Buffer) {
  return writeBlob(root, bytes);
}
