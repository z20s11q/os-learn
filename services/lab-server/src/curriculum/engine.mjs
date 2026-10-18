/**
 * 课程加载与匹配（T10–T12 的运行时部分）。
 *
 * 课程数据是静态说明，运行状态只从当前 Frame 读取：
 * - `trigger` 只描述「在什么真实状态下命中」，以实际帧为唯一输入；
 * - `checks` 是对 Frame 字段的确定性断言，失败时把实际值写进 `checksDiff`；
 * - 匹配失败时返回 null，界面显示当前停点的讲解缺省状态。
 *
 * 支持两类停点：
 * 1. 内核源码停点：GDB 给出 `source.module/symbol/line`，按模块 + 符号 + 行区间匹配；
 * 2. 用户程序停点：内核符号仍是 `entry_SYSCALL_64` 之类，但 `os.selected.comm`
 *    能识别 `lab-read`/`lab-cow` 等；这类课程用 `comm` + 可选 `stopReason` 匹配。
 */

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = 'oslab.curriculum/1';

export function curriculumPath(root) {
  return path.join(root, 'curriculum/linux-x86_64/lessons.json');
}

/** 读取课程文件；失败时返回明确原因和课程读取状态。 */
export function loadCurriculum(root) {
  const file = curriculumPath(root);
  if (!fs.existsSync(file)) {
    return { lessons: [], unavailable: [], reason: `缺少课程文件 ${path.relative(root, file)}` };
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { lessons: [], unavailable: [], reason: `课程文件不是合法 JSON：${error.message}` };
  }
  if (document.schema !== SCHEMA || !Array.isArray(document.lessons)) {
    return { lessons: [], unavailable: [], reason: `课程文件 schema 必须是 ${SCHEMA}` };
  }
  const unavailable = [];
  const lessons = [];
  for (const raw of document.lessons) {
    const problem = validateLesson(raw);
    if (problem !== null) {
      unavailable.push({ lessonId: raw?.id ?? '(unknown)', reason: problem });
      continue;
    }
    lessons.push(raw);
  }
  return { lessons, unavailable, reason: null, version: document.version ?? null };
}

function validateLesson(raw) {
  if (!raw || typeof raw !== 'object') return '课程项不是对象';
  for (const field of ['id', 'title', 'stage', 'trigger', 'explain']) {
    if (raw[field] === undefined || raw[field] === null) return `缺少字段 ${field}`;
  }
  const trigger = raw.trigger;
  if (typeof trigger !== 'object') return 'trigger 必须是对象';
  if (
    trigger.symbol === undefined
    && trigger.comm === undefined
    && trigger.address === undefined
    && trigger.addressRange === undefined
  ) {
    return 'trigger 至少要有 symbol、comm、address 或 addressRange 之一';
  }
  if (typeof raw.explain !== 'object') return 'explain 必须是对象';
  return null;
}

/** 从 Frame 里按点号路径取值；取不到返回 undefined（缺失结果类型为 undefined）。 */
export function fieldValue(frame, pathText) {
  let cursor = frame;
  for (const part of String(pathText).split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    if (part === 'length') {
      cursor = Array.isArray(cursor) ? cursor.length : undefined;
    } else {
      cursor = cursor[part];
    }
  }
  return cursor;
}

function text(value) {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function equalLoose(actual, expected) {
  if (actual === undefined) return false;
  if (typeof actual === 'number' && /^-?\d+$/.test(String(expected))) {
    return actual === Number(expected);
  }
  if (typeof actual === 'boolean') return String(actual) === String(expected);
  return String(actual) === String(expected);
}

/** 一条 trigger 是否描述当前停点。返回 `{matched, reason, score}`。 */
export function triggerMatches(trigger, frame) {
  const source = frame.source ?? null;
  const os = frame.os ?? null;
  let score = 0;
  const reasons = [];

  if (trigger.address !== undefined) {
    const pc = frame.stop?.pc ?? frame.cpu?.linearPc ?? null;
    if (pc === null) return { matched: false, reason: null, score: -1 };
    const want = BigInt(trigger.address);
    const actual = BigInt(pc);
    if (actual !== want) return { matched: false, reason: null, score: -1 };
    score += 45;
    reasons.push(`PC=${trigger.address}`);
  }

  if (trigger.addressRange !== undefined) {
    const pc = frame.stop?.pc ?? frame.cpu?.linearPc ?? null;
    if (pc === null) return { matched: false, reason: null, score: -1 };
    const actual = BigInt(pc);
    const [start, end] = trigger.addressRange;
    if (actual < BigInt(start) || actual >= BigInt(end)) return { matched: false, reason: null, score: -1 };
    score += 20;
    reasons.push(`PC 区间 [${start},${end})`);
  }

  if (trigger.module !== undefined) {
    if (source?.module !== trigger.module) return { matched: false, reason: null, score: -1 };
    score += 20;
    reasons.push(`模块 ${trigger.module}`);
  }

  if (trigger.symbol !== undefined) {
    const wanted = Array.isArray(trigger.symbol) ? trigger.symbol : [trigger.symbol];
    const symbol = source?.symbol ?? null;
    const hit = wanted.find((name) =>
      symbol !== null && (symbol === name || symbol.startsWith(`${name}.`) || symbol.includes(name)),
    );
    if (hit === undefined) return { matched: false, reason: null, score: -1 };
    score += hit === symbol ? 40 : 25;
    reasons.push(`符号 ${symbol}`);
  }

  if (trigger.sourcePath !== undefined && source?.path !== undefined) {
    const wanted = String(trigger.sourcePath);
    if (!String(source.path).endsWith(wanted)) return { matched: false, reason: null, score: -1 };
    score += 10;
    reasons.push(`源文件 ${wanted}`);
  }

  if (trigger.lines !== undefined) {
    const [from, to] = trigger.lines;
    const line = source?.line ?? 0;
    if (line < from || line > to) return { matched: false, reason: null, score: -1 };
    score += 15;
    reasons.push(`行 ${line} ∈ [${from},${to}]`);
  }

  if (trigger.comm !== undefined) {
    const wanted = Array.isArray(trigger.comm) ? trigger.comm : [trigger.comm];
    const comm = os?.selected?.comm ?? os?.current?.comm ?? null;
    if (comm === null || !wanted.includes(comm)) return { matched: false, reason: null, score: -1 };
    score += 35;
    reasons.push(`进程 ${comm}`);
  }

  if (trigger.stopReason !== undefined) {
    const wanted = Array.isArray(trigger.stopReason) ? trigger.stopReason : [trigger.stopReason];
    if (!wanted.includes(frame.stop?.reason)) return { matched: false, reason: null, score: -1 };
    score += 10;
    reasons.push(`停止原因 ${frame.stop?.reason}`);
  }

  if (trigger.preconditions !== undefined) {
    for (const entry of trigger.preconditions) {
      const actual = fieldValue(frame, entry.field);
      if (!equalLoose(actual, entry.equals)) return { matched: false, reason: null, score: -1 };
      score += 5;
    }
    reasons.push('前置状态匹配');
  }

  return { matched: true, reason: reasons.join(' + '), score };
}

/**
 * 在全部课程里选最具体的一条。
 *
 * 排序按 `priority`（课程作者显式指定）→ 匹配分 → 文件顺序；
 * 优先级和匹配分相同时保留文件顺序中的第一条。
 */
export function matchLesson(frame, curriculum) {
  let best = null;
  for (const lesson of curriculum.lessons ?? []) {
    // 课程的 profileId 是产物/架构标识（linux-x86_64），会话的 profile 是启动模式
    // （kernel-fast/full-boot）；两者分别描述产物架构和启动模式，课程匹配以 trigger 为准。
    const result = triggerMatches(lesson.trigger, frame);
    if (!result.matched) continue;
    const priority = Number(lesson.priority ?? 0);
    const candidate = { lesson, ...result, priority };
    if (
      best === null
      || candidate.priority > best.priority
      || (candidate.priority === best.priority && candidate.score > best.score)
    ) {
      best = candidate;
    }
  }
  if (best === null) return null;

  const checksDiff = [];
  for (const check of best.lesson.checks ?? []) {
    for (const expect of check.expect ?? []) {
      const actual = fieldValue(frame, expect.field);
      if (!equalLoose(actual, expect.equals)) {
        checksDiff.push(
          `${check.description ?? expect.field}：期望 ${expect.field}=${expect.equals}，实际=${text(actual) ?? '未采集'}`,
        );
      }
    }
  }
  return {
    lessonId: best.lesson.id,
    stage: best.lesson.stage,
    title: best.lesson.title,
    reason: best.reason,
    checksPassed: checksDiff.length === 0,
    ...(checksDiff.length > 0 ? { checksDiff } : {}),
    // 界面直接消费的静态说明；所有数字仍必须来自 frame 的字段引用。
    explain: best.lesson.explain,
    focus: best.lesson.focus ?? null,
    questions: best.lesson.questions ?? [],
    evidence: best.lesson.evidence ?? [],
    observe: best.lesson.observe ?? null,
    execution: best.lesson.execution ?? null,
    priority: best.priority,
  };
}

/** 课程列表（界面用）；把运行期才会知道的符号可用性交给调用方补充。 */
export function summarizeLessons(curriculum) {
  return (curriculum.lessons ?? []).map((lesson) => ({
    id: lesson.id,
    title: lesson.title,
    stage: lesson.stage,
    profileId: lesson.profileId ?? null,
    trigger: lesson.trigger,
    execution: lesson.execution ?? null,
    purpose: lesson.explain?.purpose ?? null,
    priority: lesson.priority ?? 0,
  }));
}
