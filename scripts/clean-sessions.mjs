#!/usr/bin/env node
/**
 * 清理 var/sessions 下的会话目录（默认只预览）。
 *
 *   node scripts/clean-sessions.mjs                 # 列出可清理项
 *   node scripts/clean-sessions.mjs --keep 3        # 保留最近 3 个，预览其余
 *   node scripts/clean-sessions.mjs --keep 3 --force# 真正删除
 *
 * 安全边界：
 * - 只处理 `<repo>/var/sessions` 的直接子目录；
 * - 保留目录名出现在运行中 QEMU/GDB 命令行里的活动会话；
 * - 显式 --force 执行删除。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SESSIONS = path.join(ROOT, 'var/sessions');

const args = process.argv.slice(2);
const force = args.includes('--force');
const keepIndex = args.indexOf('--keep');
const keep = keepIndex >= 0 ? Number(args[keepIndex + 1]) : 5;
if (!Number.isInteger(keep) || keep < 0) {
  console.error('--keep 必须是非负整数');
  process.exit(2);
}
if (!fs.existsSync(SESSIONS)) {
  console.log('没有 var/sessions，无需清理');
  process.exit(0);
}

function dirSize(directory) {
  let total = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) total += fs.statSync(target).size;
    }
  }
  return total;
}

function activeProcesses() {
  try {
    return execFileSync('bash', ['-c', "ps -eo pid,args | grep -E 'qemu-system-x86_64|gdb -q' | grep -v grep"], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

const active = activeProcesses();
const dirs = fs.readdirSync(SESSIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = path.join(SESSIONS, entry.name);
    return { name: entry.name, directory, mtime: fs.statSync(directory).mtimeMs };
  })
  .sort((a, b) => b.mtime - a.mtime);

const removable = [];
const skipped = [];
for (const [index, entry] of dirs.entries()) {
  const resolved = path.resolve(entry.directory);
  if (!resolved.startsWith(`${path.resolve(SESSIONS)}${path.sep}`)) {
    skipped.push({ ...entry, reason: '路径不在 var/sessions 下' });
    continue;
  }
  if (index < keep) {
    skipped.push({ ...entry, reason: `保留最近 ${keep} 个之一` });
    continue;
  }
  if (active.includes(entry.name)) {
    skipped.push({ ...entry, reason: '活动会话（QEMU/GDB 正在使用）' });
    continue;
  }
  removable.push(entry);
}

let bytes = 0;
for (const entry of removable) {
  const size = dirSize(entry.directory);
  bytes += size;
  console.log(`${force ? '删除' : '可删除'} ${entry.name}  ${(size / 1024 / 1024).toFixed(1)} MiB`);
}
for (const entry of skipped) {
  console.log(`跳过 ${entry.name}  ${entry.reason}`);
}

if (force) {
  for (const entry of removable) {
    const resolved = path.resolve(entry.directory);
    if (!resolved.startsWith(`${path.resolve(SESSIONS)}${path.sep}`)) continue;
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log(`\n已删除 ${removable.length} 个目录，释放约 ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
} else {
  console.log(`\n共 ${removable.length} 个目录可清理，约 ${(bytes / 1024 / 1024).toFixed(1)} MiB；加 --force 执行`);
}
