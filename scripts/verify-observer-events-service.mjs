#!/usr/bin/env node
/**
 * T05b 服务层接入验证（事件序列）。
 *
 * 分工说明：事件本身的**发射点与语义**（哪条指令、什么宽度、什么值、异常不误报
 * 成正常完成）由 `instrumentation/qemu-observer/verify-observer-events.mjs` 用真实
 * 单步的自造指令序列证明（48 项）。本脚本要证明的是**服务**没有把这份数据接错：
 *
 *   N1–N2  默认关闭时如实上报（水位线 0，而不是假装有一个空事件流）
 *   N3     客体事件通道与服务自身事件通道不互相冒充
 *   N4–N6  epoch / 序号 / limit / kinds 的拒绝路径，原因原样透出
 *   N7–N8  开关只在 VM 停止时可改；有活动快照时的拒绝语义
 *   N9a–N9e 从复位点逐条单步：统一序号、begin/retire 归属、访存与端口的形状
 *   N9f–N9h T05e 服务端接线：帧分界（fenceSeq/eventWatermark/frameBoundary 与两个
 *           序号域之间的绑定）、待完成块请求台账（判据与 15 个字段形状）、
 *           缺口收窄与 capabilities 口径
 *   N10    E04：事件报出的地址/宽度/值与**独立通道**（GDB 线性读）逐字节一致
 *   N11    自由运行后水位线推进，环满时的 dropped/oldest/total 关系精确成立
 *   N12    limit 分片按 nextSeq 续读，与一次性读取完全一致
 *   N13    水位线之外的区间为空且不谎报 truncated
 *   N14    capabilities 的事件覆盖表如实分档（T05b 八类 + T05c 四类 verified / T05d 起 unavailable）
 *   N15–N17 关闭采集保留水位线、会话可关闭、无残留 QEMU/GDB 进程
 *
 * dma.* / block.* 的发射点、字段与请求关联由
 * instrumentation/qemu-observer/verify-observer-dma.mjs 在真实 Linux 客体上验收；
 * 本脚本只核对它们在能力表里的分档。
 *
 * 运行：node scripts/verify-observer-events-service.mjs
 * 证据：artifacts/verify/t05b-service.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildServer } from '../services/lab-server/main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t05b-service.json');

/** 复位点起单步的次数：够走到 BIOS 真正读写内存与键盘控制器的代码。 */
const STEP_COUNT = 260;
/** 回读交叉核对的最大样本数（每次回读都是一条真实 GDB 请求）。 */
const READBACK_SAMPLE = 8;

/**
 * 不作为回读目标的线性地址窗口：这些区间的读写有设备语义（VGA 文本缓冲、
 * PCI/APIC/HPET），读它们要么有副作用，要么不能代表「CPU 写进 RAM 的值」。
 * 线性地址空间里其余位置在本次验证的场景中都是常规内存或 BIOS ROM。
 */
const DEVICE_WINDOWS = [
  [0x000a0000n, 0x00100000n],
  [0xe0000000n, 0x100000000n],
];
function isSafeLinear(address) {
  const value = BigInt(address);
  return !DEVICE_WINDOWS.some(([start, end]) => value >= start && value < end);
}

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: ok === true, detail: detail ?? null });
  console.log(`[${ok ? '通过' : '未通过'}] ${id}${detail ? ` :: ${detail}` : ''}`);
  return ok === true;
}

async function call(app, method, url, payload) {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  let body = null;
  try {
    body = response.json();
  } catch {
    body = response.body;
  }
  return { status: response.statusCode, body };
}

function describe(body) {
  if (body === null || body === undefined) return '（空响应）';
  if (typeof body === 'string') return body.slice(0, 300);
  if (body.error) return `code=${body.error.code} message=${body.error.message}`;
  return JSON.stringify(body).slice(0, 300);
}

function countSessionProcesses(sessionId) {
  try {
    const output = execFileSync('bash', [
      '-c',
      `ps -eo args | grep -F '${sessionId}' | grep -v grep | wc -l`,
    ], { encoding: 'utf8' });
    return Number(output.trim());
  } catch {
    return -1;
  }
}

/** 观察者把 u64 一律编成十进制字符串；服务必须原样透出而不是过 Number。 */
const SEQ_FIELDS = ['watermark', 'oldest', 'total', 'droppedInRange', 'requestedFrom', 'requestedTo', 'nextSeq'];
const NUM_FIELDS = ['capacity', 'limit', 'scanned', 'filtered', 'returned'];

function isDecimalString(value) {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

/** 事件的 bytes 是 little-endian 原始字节（base64）；解码后长度必须等于 size。 */
function decodeBytes(event) {
  if (typeof event?.bytes !== 'string') return null;
  return Buffer.from(event.bytes, 'base64');
}

/** value 的低 size 字节必须等于 bytes（两者是同一份数值的两种表达）。 */
function valueMatchesBytes(event) {
  const raw = decodeBytes(event);
  if (raw === null || typeof event?.size !== 'number' || raw.length !== event.size) return false;
  const value = event.detail?.value;
  if (value === undefined || value === null) return true;
  let decoded = 0n;
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    decoded = (decoded << 8n) | BigInt(raw[index]);
  }
  return decoded === BigInt(value);
}

/**
 * 逐条单步。每步都返回新帧，expectedFrameId 必须跟着走，否则服务返回 frame-mismatch。
 * 任何一步失败都记下来并停止推进，而不是把失败藏进下一次成功里。
 */
async function stepCampaign(app, base, { epoch, frameId, count }) {
  const failures = [];
  let current = frameId;
  let steps = 0;
  let lastFrame = null;
  for (let index = 0; index < count; index += 1) {
    const response = await call(app, 'POST', `${base}/commands`, {
      type: 'step',
      granularity: 'instruction',
      count: 1,
      requestId: `t05b-step-${index}`,
      epoch,
      expectedFrameId: current,
    });
    if (response.status !== 200 || typeof response.body?.frame?.frameId !== 'number') {
      failures.push({ index, status: response.status, body: response.body });
      break;
    }
    lastFrame = response.body.frame;
    current = lastFrame.frameId;
    steps += 1;
  }
  return { steps, lastFrameId: current, lastFrame, failures };
}

/** 从 seq=from 开始按 nextSeq 续读，直到取完 to（含）。 */
async function drainEvents(app, base, from, to) {
  const events = [];
  const pages = [];
  let cursor = from;
  for (let guard = 0; guard < 400; guard += 1) {
    const page = await call(app, 'GET', `${base}/events?from=${cursor}&to=${to}&limit=65536`);
    if (page.status !== 200) return { events, pages, error: page.body };
    pages.push({
      from: cursor,
      returned: page.body.returned,
      scanned: page.body.scanned,
      nextSeq: page.body.nextSeq,
      truncated: page.body.truncated,
    });
    events.push(...(page.body.events ?? []));
    if ((page.body.returned ?? 0) === 0) break;
    if (BigInt(page.body.nextSeq) > BigInt(to)) break;
    cursor = page.body.nextSeq;
  }
  return { events, pages };
}

/**
 * 用独立通道（GDB 线性读，走 /memory?addressSpace=linear）核对事件报出的字节。
 * 只有「GDB 读不到」与「读到了但对不上」分开计数，后者才是真实的不一致。
 */
async function readBack(app, base, event) {
  const response = await call(
    app,
    'GET',
    `${base}/memory?addressSpace=linear&address=${event.address}&length=${event.size}`,
  );
  if (response.status !== 200 || typeof response.body?.hex !== 'string') {
    return { unreadable: `${response.status}/${response.body?.error?.code ?? 'unknown'}` };
  }
  const expected = decodeBytes(event);
  const actual = Buffer.from(response.body.hex, 'hex');
  if (expected !== null && actual.equals(expected)) return { ok: true };
  return {
    mismatch: {
      address: event.address,
      size: event.size,
      event: expected?.toString('hex') ?? null,
      gdb: actual.toString('hex'),
    },
  };
}

async function main() {
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  const { app } = await buildServer({ logger: false });
  await app.ready();

  const evidence = { schema: 'oslab.t05b-service-evidence/1', startedAt: new Date().toISOString() };
  let session = null;

  try {
    console.log('创建会话（加载 vmlinux 符号，可能需要 1-2 分钟）...');
    const created = await call(app, 'POST', '/api/sessions', { profile: 'kernel-fast' });
    if (created.status !== 201) {
      check('session.create', false, `status=${created.status} ${describe(created.body)}`);
      evidence.create = created;
      throw new Error('会话创建失败，无法继续');
    }
    session = created.body;
    const base = `/api/sessions/${session.id}`;
    const epoch = session.epoch;
    evidence.session = { id: session.id, profile: session.profile, observer: session.observer };
    console.log(`会话 ${session.id} epoch=${epoch} frame0=${session.firstFrame?.frameId} `
      + `linearPc=${session.firstFrame?.cpu?.linearPc}`);

    /* ---------- N1/N2：默认状态与字段形状 ---------- */

    const initial = await call(app, 'GET', `${base}/events?epoch=${epoch}`);
    evidence.initial = initial.body;
    check(
      'N1 默认关闭时如实上报：水位线 0、没有事件、nextSeq 指向 1 而不是假装有内容',
      initial.status === 200
        && initial.body?.source === 'observer'
        && initial.body?.enabled === false
        && initial.body?.watermark === '0' && initial.body?.oldest === '0'
        && initial.body?.total === '0' && BigInt(initial.body?.dropped ?? '-1') === 0n
        && (initial.body?.events ?? []).length === 0
        && initial.body?.requestedFrom === '1' && initial.body?.requestedTo === '0'
        && initial.body?.returned === 0 && initial.body?.nextSeq === '1',
      `source=${initial.body?.source} enabled=${initial.body?.enabled} watermark=${initial.body?.watermark} `
        + `oldest=${initial.body?.oldest} requestedFrom=${initial.body?.requestedFrom} `
        + `requestedTo=${initial.body?.requestedTo} nextSeq=${initial.body?.nextSeq} dropped=${initial.body?.dropped}`,
    );
    check(
      'N2 大计数一律十进制字符串（不过 Number），容量/限制字段是数字，且如实声明本响应不携带的数据',
      initial.status === 200
        && SEQ_FIELDS.every((field) => isDecimalString(initial.body?.[field]))
        && NUM_FIELDS.every((field) => typeof initial.body?.[field] === 'number')
        && initial.body?.capacity === 65536
        && (initial.body?.unavailable ?? []).some((entry) => String(entry).includes('devices'))
        && (initial.body?.unavailable ?? []).some((entry) => String(entry).includes('T06')),
      `watermark=${typeof initial.body?.watermark} capacity=${initial.body?.capacity}(${typeof initial.body?.capacity}) `
        + `limit=${typeof initial.body?.limit} unavailable=${JSON.stringify(initial.body?.unavailable)}`,
    );

    /* ---------- N3：两条事件通道不互相冒充 ---------- */

    const serviceSide = await call(app, 'GET', `${base}/events?source=service&limit=5`);
    evidence.serviceSide = serviceSide.body;
    const badSource = await call(app, 'GET', `${base}/events?source=bogus`);
    check(
      'N3 source=service 是服务自身记录（不是客体事件流），非法 source 被拒绝',
      serviceSide.status === 200
        && serviceSide.body?.source === 'service'
        && typeof serviceSide.body?.note === 'string'
        && serviceSide.body.note.includes('不是客体事件流')
        && serviceSide.body?.watermark === undefined
        && badSource.status === 400 && badSource.body?.error?.code === 'invalid-request',
      `service source=${serviceSide.body?.source} watermark=${serviceSide.body?.watermark} `
        + `bogus=${badSource.status}/${badSource.body?.error?.code}`,
    );

    /* ---------- N4：迟到 epoch ---------- */

    const staleEpoch = await call(app, 'GET', `${base}/events?epoch=${epoch + 7}`);
    check(
      'N4 epoch 不符按迟到消息拒绝（不静默截取另一代的事件区间）',
      staleEpoch.status === 400 && staleEpoch.body?.error?.code === 'stale-epoch',
      `status=${staleEpoch.status} code=${staleEpoch.body?.error?.code}`,
    );

    /* ---------- N5：参数校验 ---------- */

    const badFrom = await call(app, 'GET', `${base}/events?from=abc`);
    const zeroLimit = await call(app, 'GET', `${base}/events?limit=0`);
    const overLimit = await call(app, 'GET', `${base}/events?limit=65537`);
    evidence.paramRefusals = {
      from: badFrom.body, zeroLimit: zeroLimit.body, overLimit: overLimit.body,
    };
    check(
      'N5 非法序号与 0 由服务挡下；容量越界由观察者判定 invalid-limit 并原样透出',
      badFrom.status === 400 && badFrom.body?.error?.code === 'invalid-request'
        && zeroLimit.status === 400 && zeroLimit.body?.error?.code === 'invalid-request'
        && overLimit.status === 400 && overLimit.body?.error?.code === 'invalid-request'
        && overLimit.body?.error?.detail?.observerReason === 'invalid-limit',
      `from=abc→${badFrom.body?.error?.code} limit=0→${zeroLimit.body?.error?.code} `
        + `limit=65537→${overLimit.body?.error?.code}/${overLimit.body?.error?.detail?.observerReason}`,
    );

    /* ---------- N6：kinds 过滤与未知 kind ---------- */

    const filtered = await call(app, 'GET', `${base}/events?kinds=memory.read,not.a.kind&limit=8`);
    check(
      'N6 认不出的 kind 如实进 unknownKinds，过滤只按认得的 kind 生效',
      filtered.status === 200
        && JSON.stringify(filtered.body?.unknownKinds) === JSON.stringify(['not.a.kind'])
        && JSON.stringify(filtered.body?.kinds) === JSON.stringify(['memory.read', 'not.a.kind'])
        && (filtered.body?.events ?? []).every((event) => event.kind === 'memory.read'),
      `unknownKinds=${JSON.stringify(filtered.body?.unknownKinds)} kinds=${JSON.stringify(filtered.body?.kinds)}`,
    );

    /* ---------- N7：打开采集（VM 停在复位点） ---------- */

    const enable1 = await call(app, 'POST', `${base}/events`, {
      epoch, enable: true, requestId: 't05b-enable-1',
    });
    evidence.enable = {
      enabled: enable1.body?.enabled,
      enabledChanged: enable1.body?.enabledChanged,
      watermark: enable1.body?.watermark,
    };
    check(
      'N7 停止态可以打开事件采集，观察者报告 enabledChanged',
      enable1.status === 200 && enable1.body?.ok === true
        && enable1.body?.enabled === true && enable1.body?.enabledChanged === true,
      `status=${enable1.status} ${describe(enable1.body)}`,
    );
    const enable2 = await call(app, 'POST', `${base}/events`, {
      epoch, enable: true, requestId: 't05b-enable-2',
    });
    check(
      'N7b 重复打开不谎报状态变化（enabledChanged=false）',
      enable2.status === 200 && enable2.body?.enabled === true && enable2.body?.enabledChanged === false,
      `enabled=${enable2.body?.enabled} enabledChanged=${enable2.body?.enabledChanged}`,
    );

    /* ---------- N8：有活动快照时 reset 被拒 ---------- */

    const resetRefused = await call(app, 'POST', `${base}/events`, {
      epoch, reset: true, requestId: 't05b-reset-1',
    });
    evidence.resetRefused = resetRefused.body;
    const afterReset = await call(app, 'GET', `${base}/events?limit=1`);
    check(
      'N8 有活动快照时 reset 被拒（capture-active），且开关状态没有被部分改动',
      resetRefused.status === 400
        && resetRefused.body?.error?.code === 'control-busy'
        && resetRefused.body?.error?.detail?.observerReason === 'capture-active'
        && afterReset.body?.enabled === true
        && BigInt(afterReset.body?.dropped ?? '-1') === 0n
        && afterReset.body?.enabledChanged === false,
      `status=${resetRefused.status} reason=${resetRefused.body?.error?.detail?.observerReason} `
        + `enabled=${afterReset.body?.enabled} dropped=${afterReset.body?.dropped}`,
    );

    /* ---------- N9：从复位点逐条单步（真实客体代码） ---------- */

    const campaign = await stepCampaign(app, base, {
      epoch, frameId: session.firstFrame?.frameId ?? 0, count: STEP_COUNT,
    });
    evidence.campaign = {
      steps: campaign.steps, lastFrameId: campaign.lastFrameId, failures: campaign.failures,
    };
    check(
      `N9a 从复位点连续单步 ${campaign.steps} 次全部成功（每次一步一帧）`,
      campaign.failures.length === 0 && campaign.steps === STEP_COUNT,
      campaign.failures.length === 0
        ? `steps=${campaign.steps} lastFrameId=${campaign.lastFrameId}`
        : `失败于第 ${campaign.failures[0].index} 步: ${describe(campaign.failures[0].body)}`,
    );

    const campaignState = (await call(app, 'GET', `${base}/events?limit=1`)).body;
    const watermark = campaignState?.watermark ?? '0';
    const drained = await drainEvents(app, base, '1', watermark);
    const kinds = drained.events.reduce((acc, event) => {
      acc[event.kind] = (acc[event.kind] ?? 0) + 1;
      return acc;
    }, {});
    evidence.window = {
      from: '1', to: watermark, pages: drained.pages, returned: drained.events.length, kinds,
    };
    evidence.sampleEvents = drained.events.slice(0, 6);
    check(
      'N9b 单步窗口里读到客体事件（指令 + 访存 + 端口）',
      drained.error === undefined && drained.events.length > 0
        && kinds['instruction.begin'] > 0 && kinds['instruction.retire'] > 0
        && kinds['memory.read'] > 0
        && (kinds['io.read'] ?? 0) + (kinds['io.write'] ?? 0) > 0,
      `returned=${drained.events.length} kinds=${JSON.stringify(kinds)} `
        + `${drained.error ? `error=${describe(drained.error)}` : ''}`,
    );

    const first = drained.events[0];
    check(
      'N9c 事件序号从 1 开始且全程连续：第一条就是客体复位点那条指令，末条等于水位线',
      drained.events.length > 0 && BigInt(campaignState?.dropped ?? '-1') === 0n
        && first?.seq === '1' && first?.kind === 'instruction.begin' && first?.pc === '0xfffffff0'
        && BigInt(drained.events.at(-1)?.seq ?? '0') === BigInt(watermark)
        && drained.events.every((event, index, all) => (
          index === 0 || BigInt(event.seq) === BigInt(all[index - 1].seq) + 1n
        )),
      `窗口内 dropped=${campaignState?.dropped} 首条 seq=${first?.seq} kind=${first?.kind} pc=${first?.pc} `
        + `末条=${drained.events.at(-1)?.seq} 水位线=${watermark}`,
    );

    const begins = new Map(
      drained.events.filter((event) => event.kind === 'instruction.begin')
        .map((event) => [event.instructionId, event]),
    );
    const orphans = drained.events.filter(
      (event) => event.kind === 'instruction.retire' && !begins.has(event.instructionId),
    );
    const misattributed = drained.events.filter((event) => {
      if (!event.instructionId || event.kind === 'instruction.begin') return false;
      const begin = begins.get(event.instructionId);
      if (!begin) return true; // 带 instructionId 却找不到 begin，就是把事件归到了不存在的指令
      return begin.pc !== event.pc;
    });
    /*
     * capture.fence 是 T05e 引入的帧分界：按契约它不带 pc（不是 CPU 访存，也没有
     * 归属指令）。单步战术是「每步一帧」，窗口里会出现若干条 fence，把它们算进
     * 「pc 可信」会假失败。反过来也要守住：窗口里没有 pc 的事件必须只能是 fence。
     */
    const fences = drained.events.filter((event) => event.kind === 'capture.fence');
    const pcLess = drained.events.filter((event) => !event.pc || BigInt(event.pc) <= 0n);
    const missingPc = pcLess.filter((event) => event.kind !== 'capture.fence');
    check(
      'N9d retire 都能回到对应的 begin；带 instructionId 的事件其 pc 与 begin 一致；窗口里没有 pc 的只有帧分界 capture.fence',
      orphans.length === 0 && misattributed.length === 0 && missingPc.length === 0
      && fences.length > 0 && pcLess.length === fences.length
      && fences.every((event) => event.pc === undefined),
      `孤立 retire=${orphans.length} 归属不符=${misattributed.length} 非帧分界缺 pc=${missingPc.length} `
      + `帧分界=${fences.length} `
      + `样例=${misattributed.slice(0, 2).map((event) => `${event.kind}@${event.pc}`).join(',')}`,
    );

    const access = drained.events.filter((event) => (
      event.kind === 'memory.read' || event.kind === 'memory.write'
      || event.kind === 'io.read' || event.kind === 'io.write'
    ));
    const badShape = access.filter((event) => {
      if (typeof event.size !== 'number' || event.size <= 0) return true;
      const raw = decodeBytes(event);
      if (raw === null || raw.length !== event.size) return true;
      if (!valueMatchesBytes(event)) return true;
      if (event.kind.startsWith('io.')) {
        return event.addressSpace !== 'io-port' || BigInt(event.address) >= 0x10000n;
      }
      return event.addressSpace !== 'linear';
    });
    check(
      'N9e 访存/端口事件的宽度、地址空间与 bytes 自洽（value 低 size 字节等于 bytes）',
      access.length > 0 && badShape.length === 0,
      `访存/端口事件=${access.length} 形状不符=${badShape.length} `
        + `io 端口=${[...new Set(access.filter((event) => event.kind.startsWith('io.')).map((event) => event.address))].join(',')} `
        + `样例=${badShape.slice(0, 2).map((event) => JSON.stringify({ kind: event.kind, size: event.size, addressSpace: event.addressSpace })).join(',')}`,
    );

    /* ---------- N9f–N9h：T05e 帧分界与待完成块请求台账的接入 ---------- */

    const frame = campaign.lastFrame;
    const boundary = frame?.frameBoundary ?? null;
    const pending = frame?.pendingIo ?? null;
    evidence.t05e = {
      captureId: frame?.captureId,
      fenceSeq: frame?.fenceSeq,
      eventWatermark: frame?.eventWatermark,
      eventRange: frame?.eventRange,
      frameBoundary: boundary,
      coverageUnavailable: frame?.coverage?.unavailable ?? null,
      pendingIo: pending === null ? null : {
        pendingCriterion: pending.pendingCriterion,
        count: pending.count,
        hostIoDoneCount: pending.hostIoDoneCount,
        ledgerCapacity: pending.ledgerCapacity,
        ledgerOverflow: pending.ledgerOverflow,
        resubmitCount: pending.resubmitCount,
        entries: pending.blockRequests?.length ?? null,
      },
    };
    /* 两个序号域必须分清，别拿数值直接比：
     * - `frame.eventRange` 指向**服务编排记录**（session.events，source=service，
     *   计数器是服务的 lastEventSeq）；
     * - `frame.fenceSeq` / `eventWatermark` 指向**客体事件环**（x-oslab-events，
     *   计数器在 QEMU 观察扩展里）。
     * 两者是不同的计数器，数值本来就不该相等。真正要证明的是「帧把两个域绑在一起」：
     * 服务侧 `eventRange.last` 那条记录就是本帧的 capture.fence，且它自述的
     * `observerFenceSeq` 正好等于帧的 `fenceSeq`。 */
    const svcFence = await call(app, 'GET',
      `${base}/events?source=service&from=${frame?.eventRange?.last}&to=${frame?.eventRange?.last}&limit=1`);
    const fenceEvent = svcFence.body?.events?.[0] ?? null;
    check(
      'N9f 每帧都带 T05e 帧分界：fenceSeq 与 eventWatermark 相等且非 0，frameBoundary 说明边界规则与采集不做什么，且 eventRange.last 那条服务记录就是本帧 fence 并自述同一个 observerFenceSeq',
      frame != null
      && typeof frame.fenceSeq === 'string' && BigInt(frame.fenceSeq) > 0n
      && frame.fenceSeq === frame.eventWatermark
      && boundary?.fenceRecorded === true && boundary?.fenceSeq === frame.fenceSeq
      && typeof boundary?.rule === 'string' && boundary.rule.includes('属于本帧')
      && typeof boundary?.serializationPoint === 'string' && boundary.serializationPoint.includes('BQL')
      && typeof boundary?.captureDoesNot === 'string'
      && boundary.captureDoesNot.includes('不 drain') && boundary.captureDoesNot.includes('不让任何')
      && boundary.pendingBlockRequests === pending?.count
      && boundary.pendingHostIoDone === pending?.hostIoDoneCount
      && isDecimalString(frame.eventRange?.first) && isDecimalString(frame.eventRange?.last)
      && BigInt(frame.eventRange.first) <= BigInt(frame.eventRange.last)
      && svcFence.status === 200 && svcFence.body?.source === 'service'
      && fenceEvent?.kind === 'capture.fence' && String(fenceEvent.seq) === frame.eventRange.last
      && fenceEvent?.observerFenceSeq === frame.fenceSeq
      && fenceEvent?.pendingBlockRequests === pending?.count,
      `fenceSeq=${frame?.fenceSeq} eventWatermark=${frame?.eventWatermark} `
      + `serviceEventRange=[${frame?.eventRange?.first},${frame?.eventRange?.last}] `
      + `该记录 kind=${fenceEvent?.kind} observerFenceSeq=${fenceEvent?.observerFenceSeq} `
      + `pendingBlockRequests=${fenceEvent?.pendingBlockRequests} captureDoesNot=${boundary?.captureDoesNot}`,
    );

    /* 台账条目的键集是契约：少一个字段读取方就没法把条目关联到事件上。 */
    const REQUEST_KEYS = ['deviceId', 'deviceIndex', 'requestId', 'requestIdRaw', 'lba', 'byteOffset',
      'length', 'reqType', 'op', 'outSeg', 'inSeg', 'hostIoDone', 'state', 'submitSeq', 'hostDoneSeq'];
    check(
      'N9g 帧同时带上待完成块请求台账：判据是 guest visibility，条目 15 个字段齐全，state 与 hostIoDone 一一对应',
      pending != null && typeof pending.count === 'number'
      && typeof pending.hostIoDoneCount === 'number' && pending.hostIoDoneCount <= pending.count
      && typeof pending.ledgerCapacity === 'number' && pending.ledgerCapacity > 0
      && isDecimalString(pending.ledgerOverflow) && isDecimalString(pending.resubmitCount)
      && typeof pending.pendingCriterion === 'string' && pending.pendingCriterion.includes('guest-visibility')
      && Array.isArray(pending.blockRequests) && pending.blockRequests.length === pending.count
      && pending.blockRequests.every((item) => REQUEST_KEYS.every((key) => key in item)
        && typeof item.hostIoDone === 'boolean'
        && item.state === (item.hostIoDone ? 'host-io-done-awaiting-visibility' : 'host-io-pending')
        && isDecimalString(item.submitSeq) && isDecimalString(item.hostDoneSeq)),
      `count=${pending?.count} hostIoDoneCount=${pending?.hostIoDoneCount} `
      + `条目=${pending?.blockRequests?.length} capacity=${pending?.ledgerCapacity} `
      + `overflow=${pending?.ledgerOverflow} resubmit=${pending?.resubmitCount} `
      + `缺字段=${JSON.stringify((pending?.blockRequests ?? []).filter((item) => (
        REQUEST_KEYS.some((key) => !(key in item))
      )).length)}`,
    );

    // 本段在 N14 之前，不能引用那时才声明的 `caps`（同一个 try 块里的 const 有 TDZ），
    // 所以这里自己取一次 capabilities；N14 仍按原样另取，两处互不影响。
    const t05eCaps = (await call(app, 'GET', `${base}/capabilities`)).body;
    const pendingCap = t05eCaps?.observer_?.pendingIo;
    check(
      'N9h 缺口如实收窄：帧 coverage 不再列 device.pending-block-io，capabilities.observer_.pendingIo 带判据（引观察者原话）与停机屏障说明，knownGaps 也写明',
      Array.isArray(frame?.coverage?.unavailable)
      && !frame.coverage.unavailable.includes('device.pending-block-io')
      && frame.coverage.unavailable.length > 0
      && pendingCap?.status === 'verified'
      // capabilities 侧的 pendingCriterion 是长句原话（「状态字节有没有回写客体…」），
      // 不带 capture 侧那个 `guest-visibility：` 前缀；两处措辞不同但都不许改写，
      // 所以这里核对的是它真的带着判据词，而不是我们自己转述的一句话。
      && /状态字节/.test(pendingCap?.evidence ?? '')
      && /停机屏障上的可观测性/.test(pendingCap?.evidence ?? '')
      // blk_drain 是观察者 barrierObservability 原文里的调用链一环：出现它说明
      // 这段说明是原样引用的，不是服务端另写的摘要。
      && /blk_drain/.test(pendingCap?.evidence ?? '')
      && (t05eCaps?.knownGaps ?? []).some((gap) => gap.includes('停机屏障') && gap.includes('drain')),
      `unavailable=${JSON.stringify(frame?.coverage?.unavailable)} status=${pendingCap?.status} `
      + `evidence=${String(pendingCap?.evidence ?? '').slice(0, 60)}…`,
    );

    /* ---------- N10：E04，用独立通道核对事件报出的地址/宽度/值 ---------- */

    const lastWriteByAddress = new Map();
    const wroteAddresses = new Set();
    for (const event of drained.events) {
      if (event.kind !== 'memory.write' || !event.address) continue;
      if (isSafeLinear(event.address)) lastWriteByAddress.set(event.address, event);
      wroteAddresses.add(event.address);
    }
    const storeCandidates = [...lastWriteByAddress.values()]
      .filter((event) => [1, 2, 4, 8].includes(event.size))
      .slice(-READBACK_SAMPLE);
    const writeEvents = drained.events.filter((event) => event.kind === 'memory.write' && event.address);
    const overwrittenAfter = (read) => writeEvents.some((write) => (
      BigInt(write.seq) > BigInt(read.seq)
      && BigInt(write.address) < BigInt(read.address) + BigInt(read.size)
      && BigInt(read.address) < BigInt(write.address) + BigInt(write.size)
    ));
    const loadCandidates = drained.events
      .filter((event) => event.kind === 'memory.read' && event.address
        && isSafeLinear(event.address) && [1, 2, 4, 8].includes(event.size)
        && !overwrittenAfter(event))
      .slice(-READBACK_SAMPLE);

    const storeResult = { checked: storeCandidates.length, ok: 0, mismatches: [], unreadable: [] };
    for (const event of storeCandidates) {
      const outcome = await readBack(app, base, event);
      if (outcome.ok) storeResult.ok += 1;
      else if (outcome.mismatch) storeResult.mismatches.push(outcome.mismatch);
      else storeResult.unreadable.push({ address: event.address, reason: outcome.unreadable });
    }
    const loadResult = { checked: loadCandidates.length, ok: 0, mismatches: [], unreadable: [] };
    for (const event of loadCandidates) {
      const outcome = await readBack(app, base, event);
      if (outcome.ok) loadResult.ok += 1;
      else if (outcome.mismatch) loadResult.mismatches.push(outcome.mismatch);
      else loadResult.unreadable.push({ address: event.address, reason: outcome.unreadable });
    }
    evidence.readback = { stores: storeResult, loads: loadResult };
    check(
      'N10a E04（store）：每个地址的最后一次写事件与 GDB 独立读回的字节逐字节一致',
      storeCandidates.length > 0 && storeResult.mismatches.length === 0 && storeResult.ok > 0,
      `回读 ${storeCandidates.length} 个地址：一致 ${storeResult.ok}、不符 ${storeResult.mismatches.length}、`
        + `独立通道读不到 ${storeResult.unreadable.length} `
        + `${storeResult.mismatches.slice(0, 2).map((entry) => `${entry.address}[${entry.size}] event=${entry.event} gdb=${entry.gdb}`).join(' | ')}`,
    );
    check(
      'N10b E04（load）：其后未被改写的读事件与 GDB 独立读回的字节逐字节一致',
      loadCandidates.length > 0 && loadResult.mismatches.length === 0 && loadResult.ok > 0,
      `回读 ${loadCandidates.length} 个地址：一致 ${loadResult.ok}、不符 ${loadResult.mismatches.length}、`
        + `独立通道读不到 ${loadResult.unreadable.length} `
        + `${loadResult.mismatches.slice(0, 2).map((entry) => `${entry.address}[${entry.size}] event=${entry.event} gdb=${entry.gdb}`).join(' | ')}`,
    );

    /* ---------- N11：自由运行中的开关拒绝 + 环满记账 ---------- */

    const beforeRun = await call(app, 'GET', base);
    const cont = await call(app, 'POST', `${base}/commands`, {
      type: 'continue', requestId: 't05b-continue', epoch,
      expectedFrameId: beforeRun.body?.latestFrameId,
    });
    check('N11a continue 被接受', cont.status === 200, `status=${cont.status} ${describe(cont.body)}`);
    const duringRun = await call(app, 'POST', `${base}/events`, {
      epoch, enable: false, requestId: 't05b-enable-run',
    });
    evidence.duringRun = duringRun.body;
    check(
      'N11b 运行中改开关被拒（vm-running），不做没有 tb_flush 的静默切换',
      duringRun.status === 400 && duringRun.body?.error?.detail?.observerReason === 'vm-running'
        && duringRun.body?.error?.detail?.runState === 'running'
        && duringRun.body?.error?.code === 'control-busy',
      `status=${duringRun.status} code=${duringRun.body?.error?.code} `
        + `reason=${duringRun.body?.error?.detail?.observerReason} runState=${duringRun.body?.error?.detail?.runState}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const beforePause = await call(app, 'GET', base);
    const paused = await call(app, 'POST', `${base}/commands`, {
      type: 'pause', requestId: 't05b-pause', epoch, expectedFrameId: beforePause.body?.latestFrameId,
    });
    check(
      'N11c 自由运行 1.5s 后暂停并提交新帧',
      paused.status === 200 && typeof paused.body?.frameId === 'number',
      `status=${paused.status} frameId=${paused.body?.frameId} reason=${paused.body?.stop?.reason}`,
    );

    const afterRun = await call(app, 'GET', `${base}/events?limit=8`);
    evidence.afterRun = {
      watermark: afterRun.body?.watermark, oldest: afterRun.body?.oldest,
      total: afterRun.body?.total, dropped: afterRun.body?.dropped,
      enabled: afterRun.body?.enabled, events: afterRun.body?.events?.map((event) => event.seq),
    };
    const wm = BigInt(afterRun.body?.watermark ?? '0');
    const oldest = BigInt(afterRun.body?.oldest ?? '0');
    const dropped = BigInt(afterRun.body?.dropped ?? '0');
    check(
      'N11d 环满后的 dropped/oldest/total 关系精确成立（统一序号 + 丢失记账）',
      afterRun.status === 200 && afterRun.body?.enabled === true
        && wm > 0n && afterRun.body?.total === afterRun.body?.watermark
        && dropped > 0n && oldest === wm - 65535n && dropped === oldest - 1n
        && afterRun.body?.events?.[0]?.seq === oldest.toString()
        && afterRun.body?.events?.length === 8,
      `watermark=${wm} oldest=${oldest} dropped=${dropped} total=${afterRun.body?.total} `
        + `期望 oldest=${wm > 65535n ? wm - 65535n : 0n} 首条返回=${afterRun.body?.events?.[0]?.seq}`,
    );

    /* ---------- N12：分片续读 ---------- */

    const watermarkNow = (await call(app, 'GET', `${base}/events?limit=1`)).body?.watermark ?? '0';
    const tail = BigInt(watermarkNow) - 300n > 0n ? (BigInt(watermarkNow) - 300n).toString() : watermarkNow;
    const oneShot = await call(app, 'GET', `${base}/events?from=${tail}&to=${watermarkNow}&limit=1024`);
    const pages = [];
    let cursor = tail;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await call(app, 'GET', `${base}/events?from=${cursor}&to=${watermarkNow}&limit=7`);
      pages.push(...(page.body?.events ?? []));
      if ((page.body?.returned ?? 0) === 0 || BigInt(page.body.nextSeq) > BigInt(watermarkNow)) break;
      cursor = page.body.nextSeq;
    }
    evidence.paging = { tail, oneShot: (oneShot.body?.events ?? []).length, chunked: pages.length };
    check(
      'N12 limit=7 按 nextSeq 续读与一次性读取完全一致（不跳号、不重复）',
      oneShot.status === 200 && pages.length === (oneShot.body?.events ?? []).length
        && pages.length > 0
        && JSON.stringify(pages.map((event) => event.seq))
          === JSON.stringify((oneShot.body?.events ?? []).map((event) => event.seq)),
      `一次性=${(oneShot.body?.events ?? []).length} 分片=${pages.length}`,
    );

    /* ---------- N13：水位线之外的区间 ---------- */

    const future = await call(app, 'GET', `${base}/events?from=${BigInt(watermarkNow) + 1n}`);
    const inverted = await call(app, 'GET', `${base}/events?from=${BigInt(watermarkNow) + 5n}&to=${BigInt(watermarkNow) + 1n}`);
    evidence.bounds = { future: future.body, inverted: inverted.body };
    check(
      'N13 水位线之外返回空且 nextSeq 指回请求起点，from>to 不报 truncated',
      future.status === 200 && (future.body?.returned ?? -1) === 0
        && (future.body?.events ?? []).length === 0 && future.body?.truncated === false
        && BigInt(future.body?.nextSeq) === BigInt(watermarkNow) + 1n
        && inverted.status === 200 && (inverted.body?.returned ?? -1) === 0
        && inverted.body?.scanned === 0 && inverted.body?.truncated === false,
      `future nextSeq=${future.body?.nextSeq} returned=${future.body?.returned} `
        + `inverted scanned=${inverted.body?.scanned} truncated=${inverted.body?.truncated}`,
    );

    /* ---------- N14：capabilities 分档 ---------- */

    const live = await call(app, 'GET', `${base}/events?limit=1`);
    const caps = await call(app, 'GET', `${base}/capabilities`);
    const eventTable = caps.body?.events ?? {};
    const verifiedKinds = [
      'instruction.begin', 'instruction.retire', 'memory.read', 'memory.write',
      'io.read', 'io.write', 'exception.raise', 'interrupt.accept',
      'dma.read', 'dma.write', 'block.submit', 'block.complete',
    ];
    const deliveredKinds = ['dma.read', 'dma.write', 'block.submit', 'block.complete'];
    evidence.capabilities = {
      observer_: caps.body?.observer_?.events, events: eventTable, droppedEvents: caps.body?.droppedEvents,
      liveDropped: live.body?.dropped,
    };
    check(
      'N14 能力表如实分档：T05b 八类 + T05c 四类 verified 带观察点，T05d 起仍 unavailable，droppedEvents 用真实丢失数',
      caps.status === 200
        && caps.body?.observer_?.events?.status === 'verified'
        && verifiedKinds.every((kind) => eventTable[kind]?.status === 'verified'
          && /:/.test(eventTable[kind]?.evidence ?? ''))
        && deliveredKinds.every((kind) => /T05c/.test(eventTable[kind]?.evidence ?? ''))
        && eventTable['irq.raise']?.status === 'unavailable'
        && eventTable['input.accept']?.status === 'unavailable'
        && caps.body?.droppedEvents === Number(live.body?.dropped),
      `observer_.events=${caps.body?.observer_?.events?.status} droppedEvents=${caps.body?.droppedEvents} `
        + `(同一时刻观察者报 ${live.body?.dropped}) dma.read=${eventTable['dma.read']?.status} `
        + `irq.raise=${eventTable['irq.raise']?.status}`,
    );

    /* ---------- N15：关闭采集 ---------- */

    const lastBeforeDisable = (await call(app, 'GET', `${base}/events?limit=1`)).body;
    const disable = await call(app, 'POST', `${base}/events`, {
      epoch, enable: false, requestId: 't05b-disable',
    });
    const afterDisable = await call(app, 'GET', `${base}/events?limit=1`);
    check(
      'N15 停止态可以关闭采集，水位线保留（关闭不等于清空）',
      disable.status === 200 && disable.body?.enabled === false && disable.body?.enabledChanged === true
        && afterDisable.body?.enabled === false
        && afterDisable.body?.watermark === lastBeforeDisable?.watermark,
      `enabled=${disable.body?.enabled} 关闭前水位线=${lastBeforeDisable?.watermark} `
        + `关闭后水位线=${afterDisable.body?.watermark}`,
    );

    evidence.machine = {
      qemuVersion: caps.body?.observer?.qemuVersion ?? null,
      observerSchema: caps.body?.observer?.schema ?? null,
      observerProtocolVersion: caps.body?.observer?.version ?? null,
      buildLock: JSON.parse(
        fs.readFileSync(path.join(ROOT, 'instrumentation/qemu-observer/build.lock.json'), 'utf8'),
      ),
    };
  } finally {
    if (session) {
      const closed = await call(app, 'DELETE', `/api/sessions/${session.id}`);
      check('N16 会话关闭成功', closed.status === 200 && closed.body?.closed === true, JSON.stringify(closed.body));
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const leftover = countSessionProcesses(session.id);
      check('N17 无残留 QEMU/GDB 进程', leftover === 0, `残留进程数=${leftover}`);
    }
    await app.close();
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.checks = results;
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过，失败 ${failed.length} 项`);
  console.log(`证据：${path.relative(ROOT, EVIDENCE)}`);
  if (failed.length > 0) {
    for (const entry of failed) console.log(`  - ${entry.id}: ${entry.detail}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('验证脚本异常:', error);
  process.exit(2);
});