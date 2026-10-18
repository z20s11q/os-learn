/**
 * 会话的只读视图/导出（T08/T09）。
 *
 * 这些方法只从会话已有状态派生，只读取已有会话状态：
 * - 课程目录（按当前产物符号表判断可用性）
 * - 帧绑定的 ext2 盘面
 * - 录制包导出
 * - OS 解析状态
 *
 * 抽出来是为了让 session.mjs 只保留“执行/采集/命令队列”这条主链，视图和导出
 * 可以独立测试、独立演进。
 */

import crypto from 'node:crypto';
import { summarizeLessons } from '../curriculum/engine.mjs';

export function buildLessonCatalog(session) {
  if (session.lessonCatalogCache !== null) return session.lessonCatalogCache;
  const unavailable = [...session.curriculum.unavailable];
  const moduleNames = new Map();
  const lessons = summarizeLessons(session.curriculum).map((lesson) => {
    const trigger = lesson.trigger ?? {};
    const symbols = trigger.symbol === undefined
      ? []
      : Array.isArray(trigger.symbol) ? trigger.symbol : [trigger.symbol];
    let reason = null;
    if (symbols.length > 0 && trigger.module !== undefined) {
      try {
        const module = trigger.module;
        let names = moduleNames.get(module);
        if (names === undefined) {
          names = session.symbols.table(module).map((entry) => entry.name);
          moduleNames.set(module, names);
        }
        // 编译器会把 static 函数改名成 `foo.isra.0`、`foo.part.9`，或整个函数
        // 内联掉；课程按前缀识别，兼容编译器生成的符号后缀。
        const missing = symbols.filter(
          (name) => !names.some((entry) => entry === name || entry.startsWith(`${name}.`)),
        );
        if (missing.length > 0) reason = `符号未在当前产物中解析到：${missing.join('、')}`;
      } catch (error) {
        reason = `符号表读取失败：${error.message}`;
      }
    }
    if (trigger.module === 'seabios' || trigger.module === 'grub') {
      reason = session.symbols.stage(trigger.module)?.symbolFileReason ?? '该阶段没有可解析符号';
    }
    if (reason !== null) unavailable.push({ lessonId: lesson.id, reason });
    return { ...lesson, available: reason === null, ...(reason === null ? {} : { reason }) };
  });
  session.lessonCatalogCache = {
    schema: 'oslab.curriculum/1',
    version: session.curriculum.version ?? null,
    profileId: session.profile,
    lessons,
    unavailable,
    note: session.curriculum.reason,
  };
  return session.lessonCatalogCache;
}

/** 盘面视图：按帧记录的逻辑版本，或显式 versionId；来源为帧绑定的逻辑版本。 */
export async function buildFilesystem(session, {
  path: wanted = '/',
  depth = 1,
  maxEntries = 64,
  frameId = null,
  versionId = null,
} = {}) {
  const frame = frameId === null
    ? session.frames.at(-1) ?? null
    : session.frames.find((entry) => entry.frameId === Number(frameId)) ?? null;
  // 优先用帧里记录的逻辑版本；没有显式版本时才看当前可见版本。
  const requestedVersion = versionId ?? frame?.diskVersions?.[session.disk.diskId] ?? null;
  const result = await session.diskViewer.tree({
    path: wanted,
    depth,
    maxEntries,
    versionId: requestedVersion,
  });
  result.frameId = frame?.frameId ?? null;
  result.frameDiskVersion = frame?.diskVersions?.[session.disk.diskId] ?? null;
  result.currentDiskVersion = session.disk.version({ createdAt: null })?.versionId ?? null;
  if (result.frameDiskVersion !== null && result.versionId !== null
    && result.frameDiskVersion !== result.versionId) {
    result.note =
      `帧 ${frame.frameId} 记录盘面版本 ${result.frameDiskVersion}，本次解析得到 ${result.versionId}；`
      + '版本不一致时界面不会把它当成该历史帧的盘面';
  } else if (result.historical) {
    result.note = `按帧 ${frame?.frameId ?? '历史'} 记录的逻辑版本 ${result.versionId} 重建（按该帧版本快照读取）`;
  }
  return result;
}

/**
 * 导出录制包（T09）。
 *
 * 只导出已经提交的帧及实验产物散列；没有记录的指令区间/内存页在每帧
 * `recording` 字段里已经明确标注，导出时原样保留，只保留实际记录的数据。
 */
export function exportSessionRecording(session) {
  const manifest = {
    schema: 'oslab.recording-manifest/1',
    session: {
      id: session.id,
      profile: session.profile,
      epoch: session.epoch,
      createdAt: session.frames[0]?.committedAt ?? null,
    },
    artifacts: {
      kernelRelease: session.osCollector.status().linuxRelease,
      buildId: session.osCollector.status().buildId,
      layoutFile: session.osCollector.status().layoutFile,
      vmlinuxSha256: null,
    },
    coverage: {
      memory: session.frames.some((frame) => frame.coverage.memory === 'full-ram-delta')
        ? 'full-ram-delta'
        : 'selected-pages',
      execution: 'recorded-stops-only',
      events: 'filtered',
      note: '只包含已提交停止帧；两个停止点之间的指令流未逐条保存',
    },
    curriculum: {
      version: session.curriculum.version ?? null,
      lessons: session.curriculum.lessons.map((lesson) => lesson.id),
    },
    frameCount: session.frames.length,
  };
  const payload = {
    kind: 'oslab-recording',
    schemaVersion: 1,
    manifest,
    frames: session.frames,
    source: {
      service: 'linux-observatory',
      decoderVersion: session.osCollector.status().decoderVersion,
    },
  };
  const data = JSON.stringify(payload);
  return {
    data,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    manifest,
  };
}

export function buildOsStatus(session) {
  return {
    schema: 'oslab.os-status/1',
    collector: session.osCollector.status(),
    last: session.t08.last,
    selectedPid: session.selectedPid,
    curriculum: {
      version: session.curriculum.version ?? null,
      lessons: session.curriculum.lessons.length,
      unavailable: session.curriculum.unavailable.length,
      reason: session.curriculum.reason ?? null,
    },
  };
}
