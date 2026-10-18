/** 录制包完整性校验与内容寻址工具；导入内容按数据处理。 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 对文件计算 sha256。 */
export async function hashFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return sha256Hex(buffer);
}

/** 稳定的 JSON 序列化：键排序，避免同一对象产生不同散列。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, sortKeys(inner)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function hashObject(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export interface BlobRecord {
  sha256: string;
  length: number;
  /** 相对包根的路径，按散列前两位分目录，避免单目录过大 */
  relPath: string;
}

export function blobRelPath(sha256: string): string {
  return path.join('blobs', sha256.slice(0, 2), sha256);
}

/** 写入内容寻址 blob，已存在则跳过（散列去重）。 */
export async function writeBlob(root: string, bytes: Buffer): Promise<BlobRecord> {
  const digest = sha256Hex(bytes);
  const relPath = blobRelPath(digest);
  const absolute = path.join(root, relPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  try {
    await readFile(absolute);
    return { sha256: digest, length: bytes.length, relPath };
  } catch {
    await writeFile(absolute, bytes);
    return { sha256: digest, length: bytes.length, relPath };
  }
}

export async function readBlob(root: string, sha256: string): Promise<Buffer | null> {
  const absolute = path.join(root, blobRelPath(sha256));
  try {
    const bytes = await readFile(absolute);
    const digest = sha256Hex(bytes);
    if (digest !== sha256) {
      // 内容寻址文件名与内容的散列冲突，按损坏处理
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

/** 校验一个 blob 文件：长度与散列都要匹配。 */
export async function verifyBlob(
  root: string,
  record: { sha256: string; length: number; relPath: string },
): Promise<{ ok: boolean; reason?: string }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(root, record.relPath));
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (bytes.length !== record.length) {
    return { ok: false, reason: `length ${bytes.length} != ${record.length}` };
  }
  const digest = sha256Hex(bytes);
  if (digest !== record.sha256) {
    return { ok: false, reason: `sha256 ${digest} != ${record.sha256}` };
  }
  return { ok: true };
}
