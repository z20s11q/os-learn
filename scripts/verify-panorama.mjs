#!/usr/bin/env node
/** Real-file and Chromium acceptance checks for the boot teaching panorama. */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { machine, stages, steps, registerGroups, flagDefinitions, recordedFrames, lowMemorySamples, getStepState, decodeFlags } from '../docs/animation/panorama-data.js';
import { splitCues, cueTargets } from '../docs/animation/panorama-cues.js';
import { annotate } from '../docs/animation/panorama-glossary.js';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/verify/panorama.json');
const base = process.env.LAB_URL || 'http://21.6.194.149:13029';
const report = { schema: 'oslab.panorama-acceptance/2', testedAt: new Date().toISOString(), url: `${base}/animation/slides.html#s08`, checks: [], browserErrors: [], failedResponses: [], audioRequests: [], screenshots: [] };
const originalFiles = new Map();
function originalDocument(file) {
  if (!originalFiles.has(file)) originalFiles.set(file, JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
  return originalFiles.get(file);
}
function check(id, ok, detail) {
  report.checks.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}
function originalFrame(frame) {
  const [file, fragment] = frame.originalPath.split('#');
  const raw = originalDocument(file);
  if (fragment?.startsWith('/')) return fragment.slice(1).split('/').reduce((value, token) => value[token.replaceAll('~1', '/').replaceAll('~0', '~')], raw);
  return fragment ? raw[fragment] : raw;
}
function originalPhysicalReads(frame) {
  const file = frame.originalPath.split('#')[0];
  return (originalDocument(file).physicalReads || [])
    .filter(read => read.attribution?.captureId === frame.captureId && read.attribution?.sessionId === frame.sessionId);
}
function beforeFrame(delta) {
  return delta.fromEvidenceKey ? recordedFrames[delta.fromEvidenceKey] : getStepState(delta.fromStepId).frame;
}
function registersOf(frame) {
  const cpu = frame.cpu;
  return {
    ...Object.fromEntries(cpu.general.map(register => [register.name, register.value])), ...cpu.control,
    rip: cpu.rip, linearPc: cpu.linearPc, rflags: cpu.eflags, efer: cpu.efer, cpl: cpu.cpl,
    ...Object.fromEntries(Object.entries(cpu.segments).map(([id, segment]) => [id, segment.selector])),
    gdtrBase: cpu.gdt.base, gdtrLimit: cpu.gdt.limit, idtrBase: cpu.idt.base, idtrLimit: cpu.idt.limit,
    ...Object.fromEntries((cpu.extended?.registers || []).map(register => [register.name, register.value])),
  };
}
function wordEqual(a, b) {
  try { return BigInt(a) === BigInt(b); } catch { return a === b; }
}

check('data.curriculum', steps.length >= 50 && stages.length >= 12 && new Set(steps.map(step => step.id)).size === steps.length,
  `${stages.length} stages, ${steps.length} unique microsteps`);
check('data.hardware', machine.ramBytes === 512 * 1024 * 1024 && machine.cores === 1,
  `${machine.architecture}, ${machine.cores} vCPU, ${machine.ramBytes} RAM bytes`);

for (const [name, frame] of Object.entries(recordedFrames)) {
  const raw = originalFrame(frame);
  const differences = Object.keys(frame.cpu).filter(key => key !== 'evidence' && JSON.stringify(frame.cpu[key]) !== JSON.stringify(raw.cpu[key]));
  const originalMemory = [...raw.memory, ...originalPhysicalReads(frame)];
  const memoryMatches = frame.memory.length === originalMemory.length && frame.memory.every(entry => originalMemory.some(original => original.addressSpace === entry.addressSpace
    && original.address === entry.address && original.length === entry.length
    && (entry.coverage === 'read-failed' ? original.coverage === 'read-failed' && original.reason === entry.reason && entry.bytes == null
      : (original.hex || original.bytes) === entry.bytes)
    && (!entry.captureId || original.attribution?.captureId === entry.captureId))
    && (entry.coverage === 'read-failed' ? typeof entry.reason === 'string' && entry.reason.length > 0
      : typeof entry.bytes === 'string' && entry.bytes.length === entry.length * 2 && /^[0-9a-f]+$/i.test(entry.bytes)));
  check(`recording.${name}`, frame.sessionId === raw.sessionId && frame.frameId === raw.frameId && frame.captureId === raw.captureId && differences.length === 0 && memoryMatches,
    `${frame.originalPath}; mismatching CPU fields: ${differences.join(', ') || 'none'}; memory bytes and address-space metadata match: ${memoryMatches}`);
}

const inferred = steps.filter(step => !step.evidenceKey).map(step => getStepState(step.id));
check('data.unknown-isolation', inferred.every(state => Object.values(state.registers).every(value => value === null)),
  `${inferred.length} unrecorded microsteps retain unknown full register words`);
check('data.pseudocode-labelled', steps.every(step => step.codeKind === 'teaching-pseudocode' && /教学简码/.test(step.codeNote)),
  'Every rewritten code excerpt is explicitly labelled as teaching pseudocode');
check('data.no-cross-session-delta', steps.every(step => {
  const state = getStepState(step.id);
  return !state.sampleDelta || state.frame.sessionId === beforeFrame(state.sampleDelta)?.sessionId;
}), 'Every measured delta compares captured endpoints from the same session');
const wrongMemoryOwners = steps.flatMap(step => {
  const state = getStepState(step.id);
  return state.lowMemory.filter(sample => sample.addressSpace === 'physical' && (!state.frame
    || (sample.captureId || sample.attribution?.captureId) !== state.frame.captureId
    || (sample.sessionId || sample.attribution?.sessionId) !== state.frame.sessionId)).map(sample => `${step.id}:${sample.address}`);
});
check('data.low-memory-provenance', wrongMemoryOwners.length === 0
  && lowMemorySamples.every(sample => sample.addressSpace === 'physical' ? Boolean((sample.captureId || sample.attribution?.captureId) && (sample.sessionId || sample.attribution?.sessionId)) : sample.addressSpace === 'unknown-in-export' && /captureId/.test(sample.note)),
  `Physical reads belong to their displayed frame; foreign capture references: ${wrongMemoryOwners.join(', ') || 'none'}`);

const reset = getStepState('reset-vector');
const startup32 = getStepState('startup32');
const startup64 = getStepState('startup64');
const flagValue = (state, id) => state.flags.find(flag => flag.id === id)?.value;
check('data.reset-address', wordEqual(reset.registers.rip, '0xfff0') && wordEqual(reset.registers.linearPc, '0xfffffff0')
  && wordEqual(reset.segments.cs.base, '0xffff0000') && flagValue(reset, 'cr0.PG') === 0,
  'Reset CS hidden base explains the observed top-of-address-space instruction address');
check('data.mode-transition', flagValue(startup32, 'cr0.PE') === 1 && flagValue(startup32, 'cr0.PG') === 0
  && flagValue(startup64, 'cr0.PG') === 1 && flagValue(startup64, 'cr4.PAE') === 1 && flagValue(startup64, 'efer.LMA') === 1,
  'Recorded 32-bit and 64-bit decompressor entries agree with the mode explanation');
const inconsistentFlags = steps.filter(step => step.evidenceKey).flatMap(step => {
  const state = getStepState(step.id);
  return Object.entries(step.cpu.bits || {}).filter(([id, value]) => flagValue(state, id) !== value).map(([id]) => `${step.id}:${id}`);
});
check('data.source-constraints-match-captures', inconsistentFlags.length === 0,
  `Source-derived bit conditions conflicting with their attached real capture: ${inconsistentFlags.join(', ') || 'none'}`);
const shell = getStepState('shell-ready');
check('data.shell-current-is-captured', Boolean(shell.frame) && JSON.stringify(shell.currentTask) === JSON.stringify(originalFrame(shell.frame).os?.current)
  && shell.registers.cpl === originalFrame(shell.frame).cpu.cpl,
  `Terminal-ready CPU snapshot retains the actual current task (PID ${shell.currentTask?.pid ?? 'unknown'}, CPL ${shell.registers.cpl})`);
const missingDeltas = [];
const invalidDeltas = [];
const invalidMemoryDeltas = [];
for (const step of steps) {
  const state = getStepState(step.id);
  if (!state.sampleDelta) continue;
  const priorFrame = beforeFrame(state.sampleDelta);
  const previous = { registers: registersOf(priorFrame), segments: priorFrame.cpu.segments };
  for (const [id, value] of Object.entries(state.registers)) {
    const before = previous.registers[id];
    if (before != null && value != null && !wordEqual(before, value) && !state.sampleDelta.registers.some(change => change.id === id)) missingDeltas.push(`${step.id}:${id}`);
  }
  for (const change of state.sampleDelta.registers) {
    if (previous.registers[change.id] == null || state.registers[change.id] == null
      || wordEqual(previous.registers[change.id], state.registers[change.id])
      || !wordEqual(change.before, previous.registers[change.id]) || !wordEqual(change.after, state.registers[change.id])) invalidDeltas.push(`${step.id}:${change.id}`);
  }
  for (const [id, segment] of Object.entries(state.segments || {})) for (const [field, value] of Object.entries(segment)) {
    const before = previous.segments?.[id]?.[field];
    if (before != null && value !== before && !state.sampleDelta.segments?.some(change => change.id === id && change.fields.some(change => change.field === field))) missingDeltas.push(`${step.id}:${id}.${field}`);
  }
  const expectedFlags = decodeFlags(previous.registers).filter(before => {
    const after = state.flags.find(flag => flag.id === before.id);
    return before.value != null && after?.value != null && before.value !== after.value;
  });
  if (expectedFlags.length !== state.sampleDelta.flags.length || expectedFlags.some(before => {
    const change = state.sampleDelta.flags.find(flag => flag.id === before.id);
    return !change || change.before !== before.value || change.after !== state.flags.find(flag => flag.id === before.id).value;
  })) invalidDeltas.push(`${step.id}:flags`);
  if (state.sampleDelta.scope !== 'between-recorded-checkpoints' || !/净变化/.test(state.sampleDelta.note)
    || state.sampleDelta.fromFrameId !== priorFrame.frameId || state.sampleDelta.toFrameId !== state.frame.frameId
    || priorFrame.frameId >= state.frame.frameId) invalidDeltas.push(`${step.id}:endpoints`);
  const key = memory => `${memory.addressSpace}:${BigInt(memory.address)}:${memory.length}`;
  const oldMemory = new Map(priorFrame.memory.filter(memory => typeof memory.bytes === 'string').map(memory => [key(memory), memory]));
  const comparable = state.memory.filter(memory => typeof memory.bytes === 'string' && oldMemory.has(key(memory)));
  const delta = state.memoryDelta;
  if (!delta || delta.fromFrameId !== priorFrame.frameId || delta.toFrameId !== state.frame.frameId
    || !/净变化/.test(delta.note) || delta.windows.length !== comparable.length) invalidMemoryDeltas.push(`${step.id}:endpoints`);
  for (const memory of comparable) {
    const prior = oldMemory.get(key(memory));
    const expected = Array.from({ length: memory.length }, (_, offset) => offset).filter(offset =>
      prior.bytes.slice(offset * 2, offset * 2 + 2).toLowerCase() !== memory.bytes.slice(offset * 2, offset * 2 + 2).toLowerCase());
    const window = delta?.windows.find(window => key(window) === key(memory));
    if (!window || window.beforeBytes !== prior.bytes || JSON.stringify(window.changedOffsets) !== JSON.stringify(expected)
      || window.changedBytes !== expected.length || window.beforeCaptureId !== priorFrame.captureId
      || window.afterCaptureId !== state.frame.captureId) invalidMemoryDeltas.push(`${step.id}:${key(memory)}`);
  }
  if (delta && delta.changedBytes !== delta.windows.reduce((sum, window) => sum + window.changedBytes, 0)) invalidMemoryDeltas.push(`${step.id}:total`);
}
check('data.delta-completeness', missingDeltas.length === 0, `Changed captured register words and hidden segment fields omitted from deltas: ${missingDeltas.join(', ') || 'none'}`);
check('data.delta-values-and-scope', invalidDeltas.length === 0, `Spurious changes, wrong values or invalid checkpoint endpoints: ${invalidDeltas.join(', ') || 'none'}`);
check('data.memory-delta-bytes', invalidMemoryDeltas.length === 0, `Common-window byte differences, offsets, capture owners and totals agree with raw endpoints: ${invalidMemoryDeltas.join(', ') || 'none'}`);
const wideFields = registerGroups.flatMap(group => group.items).filter(register => register.width > 64);
const invalidWideValues = steps.flatMap(step => {
  const state = getStepState(step.id);
  return wideFields.filter(register => state.registers[register.id] != null && (typeof state.registers[register.id] !== 'string'
    || !new RegExp(`^0x[0-9a-f]{${Math.ceil(register.width / 4)}}$`, 'i').test(state.registers[register.id]))).map(register => `${step.id}:${register.id}`);
});
check('data.wide-registers-lossless', invalidWideValues.length === 0, `80/128-bit sampled values remain full-width hexadecimal strings: ${invalidWideValues.join(', ') || 'none'}`);

const snippetsPath = path.join(root, 'docs/animation/data/source-code.json');
if (fs.existsSync(snippetsPath)) {
  const snippets = JSON.parse(fs.readFileSync(snippetsPath, 'utf8'));
  const refs = [...new Map(steps.flatMap(step => step.sourceRefs.map(ref => [`${ref.path}:${ref.line}`, ref]))).entries()];
  const invalid = refs.filter(([key, ref]) => {
    const snippet = snippets[key];
    if (!snippet?.available || snippet.path !== ref.path || snippet.line !== ref.line) return true;
    const original = fs.readFileSync(path.join(root, ref.path), 'utf8').split('\n');
    return snippet.lines.some((line, index) => original[snippet.startLine - 1 + index] !== line);
  });
  check('data.source-verbatim', invalid.length === 0, `${refs.length} source references; invalid snippets: ${invalid.map(([key]) => key).join(', ') || 'none'}`);
} else check('data.source-verbatim', false, 'source-code.json is missing');

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser', timeout: 15000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) report.failedResponses.push(`${response.status()} ${response.url()}`);
    if (/\.mp3(?:\?|$)/.test(response.url())) report.audioRequests.push({ status: response.status(), url: response.url() });
  });
  await page.goto(report.url, { waitUntil: 'networkidle', timeout: 20000 });
  check('browser.loaded', /Linux|启动/.test(await page.title()), await page.title());
  await page.waitForSelector('#lessonTitle');
  const expectedRegisterCount = Object.keys(reset.registers).length;
  check('browser.panorama-components', await page.locator('#registers [data-register]').count() === expectedRegisterCount
    && await page.locator('#ramGrid .ram-cell').count() === 512 && await page.locator('#stageTrack button').count() === stages.length,
    `${expectedRegisterCount} register entries, 32 × 16 RAM cells, ${stages.length} stage controls`);
  const registerLayout = await page.locator('[data-group="general"] .register-grid').evaluate(element => ({
    columns: getComputedStyle(element).gridTemplateColumns.split(/\s+/).length,
    firstRow: [...element.querySelectorAll('[data-register]')].map(button => button.getBoundingClientRect()).filter(rect => Math.abs(rect.top - element.firstElementChild.getBoundingClientRect().top) < 2).length,
  }));
  check('browser.cpu-dense-grid', registerLayout.columns >= 3 && registerLayout.firstRow >= 3,
    `Desktop CPU general registers use ${registerLayout.columns} columns and ${registerLayout.firstRow} buttons in the first row`);
  check('browser.legacy-link', await page.locator('body').getAttribute('data-step') === 'enable-pae',
    'The original #s08 URL still resolves to a teaching step');
  async function visit(id) {
    await page.evaluate(stepId => { location.hash = stepId; }, id);
    await page.waitForFunction(([stepId, beat]) => document.body.dataset.step === stepId && (beat == null || document.body.dataset.beat === beat), [id.split('@')[0], /@\d+$/.test(id) ? String(Number(id.split('@')[1]) - 1) : null]);
  }
  await visit('reset-vector');
  check('browser.reset-values', /0xfffffff0/.test(await page.locator('[data-register="linearPc"]').textContent())
    && /0xfff0/.test(await page.locator('[data-register="rip"]').textContent())
    && /实测.*frame|历史真实停点/.test(await page.locator('#cpuSample').textContent()),
    'The reset instruction address and exact-sample provenance render in the CPU panel');
  const initialFacts = await page.locator('#startupFacts').textContent();
  check('browser.reset-initial-state', initialFacts.includes('0x60000010') && initialFacts.includes('0x60fb1')
    && initialFacts.includes('0x1f80') && initialFacts.includes('0x37f') && initialFacts.includes('窗口外')
    && await page.locator('#registers .initialized').count() > 60,
    'Reset values are explicitly initial states, including RDX, CR0, x87/SSE controls and limited RAM samples');
  check('browser.full-memory-layout', /1 MiB/.test(await page.locator('#memoryUnit').textContent())
    && await page.locator('#memoryEnd').textContent() === '0x1fffffff'
    && await page.locator('#memoryScale, #memoryBack, #memoryForward').count() === 0,
    'All 512 MiB remain visible without zoom or window navigation');
  check('browser.reset-rom-byte', await page.locator('#resetRomBytes [data-address="0xfffffff0"]').textContent() === 'ea'
    && await page.locator('#resetRomBytes span').count() === 16,
    'The reset ROM bytes remain expanded alongside the whole memory layout');
  await page.locator('#ramGrid .ram-cell').first().click();
  check('browser.memory-selection-retains-overview', await page.locator('#ramGrid .ram-cell').count() === 512
    && await page.locator('#memoryEnd').textContent() === '0x1fffffff',
    'Selecting a region never replaces the complete overview with a small window');
  await page.locator('[data-register="cs"]').click();
  await page.waitForSelector('#inspectDialog[open]');
  check('browser.segment-cache', /0xffff0000/.test(await page.locator('#inspectBody').textContent()),
    'Clicking CS exposes its recorded hidden base');
  await page.locator('#inspectDialog [data-close]').click();
  await page.locator('[data-register="rax"]').focus();
  await page.keyboard.press('Tab');
  check('browser.cpu-keyboard-focus', await page.locator('[data-register="rbx"]').evaluate(element => element === document.activeElement
    && getComputedStyle(element).outlineStyle !== 'none' && parseFloat(getComputedStyle(element).outlineWidth) > 0),
    'CPU buttons retain keyboard Tab order and a visible focus outline');
  await visit('decompress-placement@end');
  const beforeCr4 = page.locator('[data-register="cr4"]');
  const beforeStyle = await beforeCr4.evaluate(element => ({ className: element.className, border: getComputedStyle(element).borderTopStyle,
    outline: getComputedStyle(element).outlineStyle, animation: getComputedStyle(element).animationName, title: element.title }));
  check('browser.cpu-before-change', /\bwill-change\b/.test(beforeStyle.className)
    && (beforeStyle.border === 'dashed' || beforeStyle.outline === 'dashed') && beforeStyle.animation !== 'none'
    && /下一|将|变化/.test(beforeStyle.title),
    `CR4 previews its next measured transition with an explained blinking dashed marker: ${JSON.stringify(beforeStyle)}`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check('browser.cpu-reduced-motion', await beforeCr4.evaluate(element => getComputedStyle(element).animationName === 'none'
    && (getComputedStyle(element).borderTopStyle === 'dashed' || getComputedStyle(element).outlineStyle === 'dashed')),
    'Reduced-motion preference disables flashing while retaining the dashed before-change marker');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await visit('enable-pae@end');
  const afterCr4 = await page.locator('[data-register="cr4"]').evaluate(element => ({ className: element.className,
    border: getComputedStyle(element).borderTopStyle, outline: getComputedStyle(element).outlineStyle, value: element.querySelector('.register-value').textContent }));
  const highlightState = getStepState('enable-pae');
  const expectedHighlights = new Set([...highlightState.changedRegisters, ...(highlightState.sampleDelta?.segments || []).map(segment => segment.id)]);
  const renderedHighlights = await page.locator('#registers [data-register].changed').evaluateAll(elements => elements.map(element => element.dataset.register));
  check('browser.cpu-after-change', /\bchanged\b/.test(afterCr4.className)
    && (afterCr4.border === 'solid' || afterCr4.outline === 'solid') && afterCr4.value === highlightState.registers.cr4
    && renderedHighlights.every(id => expectedHighlights.has(id)) && renderedHighlights.length === expectedHighlights.size,
    `Measured CR4 transition is solidly highlighted; every highlighted register has a real delta: ${JSON.stringify(afterCr4)}`);
  const registerIdSet = new Set(registerGroups.flatMap(group => group.items.map(item => item.id)));
  const staged = steps.map(step => {
    const state = getStepState(step.index);
    const cues = splitCues(step.narration);
    for (const change of state.sampleDelta?.registers || []) {
      const ownFlags = (state.sampleDelta.flags || []).filter(flag => flag.register === change.id);
      const beat = cues.findIndex(cue => { const t = cueTargets(cue.text, registerIdSet); return t.registers.has(change.id) || ownFlags.some(flag => t.flags.has(flag.id) || t.flags.has(flag.en)); });
      if (beat > 0 && !['rip', 'linearPc'].includes(change.id)) return { step, change, beat, cue: cues[beat] };
    }
    return null;
  }).find(Boolean);
  if (staged) {
    await visit(staged.step.id);
    const before = await page.locator(`[data-register="${staged.change.id}"]`).evaluate(element => ({ className: element.className, value: element.querySelector('.register-value').textContent, title: element.title }));
    await visit(`${staged.step.id}@${staged.beat + 1}`);
    const after = await page.locator(`[data-register="${staged.change.id}"]`).evaluate(element => ({ className: element.className, value: element.querySelector('.register-value').textContent }));
    const chips = await page.locator('#beatChanges').textContent();
    check('browser.beat-sync', /\bwill-change\b/.test(before.className) && before.value === staged.change.before && /稍后/.test(before.title)
      && /\bchanged\b/.test(after.className) && /\bflip\b/.test(after.className) && after.value === staged.change.after
      && chips.includes(`${staged.change.before} → ${staged.change.after}`)
      && (await page.locator('#lyrics li.current .lyric-text').textContent()) === annotate(staged.cue.text),
      `${staged.step.id}: ${staged.change.id} keeps ${staged.change.before} until line ${staged.beat + 1} ("${staged.cue.text}") flips it to ${staged.change.after}`);
  } else check('browser.beat-sync', false, 'No step stages a register change on a later subtitle line');
  await visit('reset-vector');
  await page.locator('#allFlagsBtn').click();
  check('browser.all-flags', await page.locator('#inspectBody tbody tr').count() === flagDefinitions.length,
    `${await page.locator('#inspectBody tbody tr').count()} independently explained flag/control-bit fields`);
  await page.locator('#inspectDialog [data-close]').click();
  await page.locator('#sourceRefs [data-source]').first().click();
  await page.waitForSelector('#inspectDialog[open] pre');
  check('browser.source-original', /reset_vector/.test(await page.locator('#inspectBody pre').textContent())
    && /源码的原文/.test(await page.locator('#inspectBody').textContent()), 'Source-reference click loads the original reset-vector assembly');
  await page.locator('#inspectDialog [data-close]').click();
  const shot = async name => {
    const target = path.join(root, `artifacts/verify/${name}.png`);
    await page.evaluate(() => { document.getElementById('cpuScroll').scrollTop = 0; });
    await page.screenshot({ path: target, fullPage: false });
    report.screenshots.push(path.relative(root, target));
  };
  await shot('panorama-reset');
  const inferredStep = steps.find(step => !step.evidenceKey && step.index > 1 && Object.keys(step.cpu.bits || {}).length);
  if (inferredStep) {
    await visit(inferredStep.id);
    check('browser.inferred-provenance', /数值保留/.test(await page.locator('#cpuSample').textContent()),
      `${inferredStep.id}: retained historical CPU words remain labelled as unavailable for this step`);
  }
  const brokenSteps = [];
  let sourceFocusCount = 0;
  const badSourceFocus = [];
  for (const step of steps) {
    await visit(step.id);
    const rendered = await page.locator('#lessonTitle').textContent();
    if (rendered !== annotate(step.title) || await page.locator('#registers [data-register]').count() !== expectedRegisterCount
      || await page.locator('#ramGrid .ram-cell').count() !== 512) brokenSteps.push(step.id);
    const focused = await page.locator('#registers .focus-field').evaluateAll(elements => elements.map(element => ({ id: element.dataset.register, title: element.title, measured: element.classList.contains('changed') })));
    sourceFocusCount += focused.length;
    for (const field of focused) if (field.measured || !/关注|推导|示意/.test(field.title)) badSourceFocus.push(`${step.id}:${field.id}`);
  }
  check('browser.every-step', brokenSteps.length === 0, `${steps.length} actual hash navigations; broken: ${brokenSteps.join(', ') || 'none'}`);
  const expectedSourceFocus = steps.some(step => !step.evidenceKey && Object.keys(step.cpu.bits || {}).length > 0);
  check('browser.cpu-source-focus', (!expectedSourceFocus || sourceFocusCount > 0) && badSourceFocus.length === 0,
    `${sourceFocusCount} source-attention markers remain explained and separate from measured changes: ${badSourceFocus.join(', ') || 'none'}`);
  const extendedSteps = steps.filter(step => recordedFrames[step.evidenceKey]?.cpu.extended?.registers?.some(register => register.value != null));
  const brokenExtendedValues = [];
  for (const step of extendedSteps) {
    await visit(`${step.id}@end`);
    for (const register of recordedFrames[step.evidenceKey].cpu.extended.registers.filter(register => register.value != null)) {
      const row = page.locator(`[data-register="${register.name}"] .register-value`);
      if (await row.count() !== 1 || (await row.textContent()).trim() !== register.value) brokenExtendedValues.push(`${step.id}:${register.name}`);
    }
  }
  check('browser.extended-register-values', brokenExtendedValues.length === 0,
    `${extendedSteps.length} real extended CPU checkpoints rendered without truncation: ${brokenExtendedValues.join(', ') || 'none'}`);
  await page.locator('#outlineBtn').click();
  await page.locator('#outlineSearch').fill('CR3');
  const searchCount = await page.locator('#outlineList [data-step]').count();
  check('browser.outline-search', searchCount > 0 && searchCount < steps.length, `CR3 finds ${searchCount} matching steps`);
  await page.locator(`#outlineList [data-step="${steps.find(step => step.id === 'load-cr3').index}"]`).click();
  check('browser.outline-navigation', await page.locator('body').getAttribute('data-step') === 'load-cr3'
    && !await page.locator('#outlineDialog').isVisible(), 'Choosing a result navigates and closes the directory');
  await page.locator('#nextStepBtn').click();
  check('browser.next', await page.locator('body').getAttribute('data-step') === 'enable-lme', 'Next-step advances by one teaching step');
  await page.keyboard.press('ArrowRight');
  check('browser.next-line', await page.locator('body').getAttribute('data-step') === 'enable-lme' && await page.locator('body').getAttribute('data-beat') === '1'
    && (await page.locator('#lyrics li.current .lyric-text').textContent()) === annotate(splitCues(steps.find(step => step.id === 'enable-lme').narration)[1].text),
    'The right arrow advances one subtitle line inside the step and highlights that line');
  await page.keyboard.press('PageDown');
  check('browser.keyboard-after-click', await page.locator('body').getAttribute('data-step') === 'enable-paging',
    'PageDown keeps step navigation working after a pointer click leaves focus on a button');
  await page.keyboard.press('PageUp');
  await page.locator('#prevStepBtn').click();
  check('browser.previous', await page.locator('body').getAttribute('data-step') === 'load-cr3', 'Previous-step restores the earlier teaching step');
  await page.locator('#prevBtn').click();
  const precedingStep = steps[steps.findIndex(step => step.id === 'load-cr3') - 1];
  check('browser.previous-line-crosses-step', await page.locator('body').getAttribute('data-step') === precedingStep.id
    && await page.locator('body').getAttribute('data-beat') === String(splitCues(precedingStep.narration).length - 1),
    'Previous-line at the first line moves to the last line of the preceding step');
  await page.locator('#seek').focus();
  await page.locator('#seek').press('Home');
  check('browser.seek-and-unknown', await page.locator('#prevBtn').isDisabled()
    && /未采样/.test(await page.locator('[data-register="rip"]').textContent()), 'Seeking to power-off clears unavailable CPU register values');
  await page.locator('#stageTrack button').last().click();
  check('browser.stage-navigation', await page.locator('body').getAttribute('data-step') === stages.at(-1).steps[0].id,
    'Stage navigation enters the first microstep of the selected phase');
  await visit('shell-ready');
  check('browser.shell-endpoint', /linux-lab:\/root#/.test(await page.locator('#terminalOutput').textContent())
    && (shell.currentTask == null || (await page.locator('#processes').textContent()).includes(`PID ${shell.currentTask.pid}`))
    && (await page.locator('#privilege').textContent()).includes(`CPL ${shell.registers.cpl}`),
    'The terminal prompt coexists with the actual sampled CPU task and privilege');
  const lowBootSample = [...shell.lowMemory, ...shell.memory, ...lowMemorySamples].find(sample => wordEqual(sample.address, '0x7c00') && sample.addressSpace === 'physical');
  const bootOption = await page.locator('#memorySelect option').evaluateAll(options => options.find(option => /0x7c00\b/.test(option.textContent))?.value);
  if (bootOption) await page.locator('#memorySelect').selectOption(bootOption);
  const memoryProvenance = [await page.locator('#memoryProvenance').textContent(), await page.locator('#memoryProvenance').getAttribute('title')].filter(Boolean).join(' · ');
  check('browser.memory-inspector', Boolean(bootOption && lowBootSample) && /00007c00/.test(await page.locator('#hexDump').textContent())
    && memoryProvenance.includes(lowBootSample?.captureId || lowBootSample?.attribution?.captureId) && /物理|physical/.test(memoryProvenance),
    `The hex inspector identifies the address and available source attribution: ${memoryProvenance}`);
  await shot('panorama-shell');
  await visit('enable-pae');
  await page.locator('#narrateToggle').uncheck();
  await page.locator('#speedSelect').selectOption('2');
  await page.locator('#playBtn').click();
  check('browser.play', await page.locator('body').evaluate(element => element.classList.contains('is-playing')),
    'Continuous playback starts through the visible control');
  await page.waitForFunction(() => document.body.dataset.step === 'identity-pages', undefined, { timeout: 9000 });
  await page.locator('#playBtn').click();
  const pausedAt = await page.locator('body').getAttribute('data-step');
  await page.waitForTimeout(700);
  check('browser.pause', await page.locator('body').getAttribute('data-step') === pausedAt
    && !await page.locator('body').evaluate(element => element.classList.contains('is-playing')), 'Playback advances at the selected speed and remains paused');
  await visit('power-off');
  await page.locator('#narrateToggle').check();
  await page.locator('#speedSelect').selectOption('1');
  await page.locator('#speakBtn').click();
  await page.waitForFunction(() => /播放中|朗读中|失败|不可用/.test(document.getElementById('speechStatus').textContent), undefined, { timeout: 18000 });
  check('browser.narration', /中文神经网络配音 · 播放中/.test(await page.locator('#speechStatus').textContent()),
    await page.locator('#speechStatus').textContent());
  await page.locator('#speakBtn').click();
  await page.waitForFunction(() => /暂停/.test(document.getElementById('speechStatus').textContent), undefined, { timeout: 3000 });
  check('browser.narration-pause', /暂停/.test(await page.locator('#speechStatus').textContent()), await page.locator('#speechStatus').textContent());
  if (await page.locator('#narratorSelect').count()) for (const voice of ['xiaoyi', 'xiaoxiao', 'yunxi']) {
    await page.locator('#voiceSettingsBtn').click();
    await page.locator('#narratorSelect').selectOption(voice);
    await page.waitForFunction(count => document.getElementById('audioInfo').textContent.includes(`${count} 个步骤已配音`), steps.length, { timeout: 10000 });
    await page.locator('#voiceDialog [data-close]').click();
    await page.locator('#speakBtn').click();
    await page.waitForFunction(() => /配音 · 播放中/.test(document.getElementById('speechStatus').textContent), undefined, { timeout: 10000 });
    check(`browser.voice-${voice}`, true, `The selected ${voice} manifest loads and its real MP3 starts playback`);
    await page.locator('#speakBtn').click();
    await page.waitForFunction(() => /暂停/.test(document.getElementById('speechStatus').textContent), undefined, { timeout: 3000 });
  }
  await visit('shell-ready');
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.evaluate(() => { document.getElementById('cpuScroll').scrollTop = 0; });
  await shot('panorama-laptop');
  report.laptopGeometry = await page.evaluate(() => Object.fromEntries(['cpuTitle', 'ramGrid', 'lowMap', 'code', 'terminalTitle', 'playBtn'].map(id => {
    const r = document.getElementById(id).getBoundingClientRect(); return [id, { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }];
  })));
  check('browser.laptop-panorama', report.laptopGeometry.playBtn.bottom <= 768
    && report.laptopGeometry.terminalTitle.bottom <= 768 && report.laptopGeometry.lowMap.bottom <= 768,
    'Playback, terminal, low-memory map and the global matrix remain on screen at 1366 × 768');
  await page.setViewportSize({ width: 390, height: 844 });
  await visit('reset-vector');
  await page.evaluate(() => window.scrollTo(0, 0));
  check('browser.mobile-width', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `${await page.evaluate(() => document.documentElement.scrollWidth)} px document width on a 390 px viewport`);
  await shot('panorama-mobile');
  check('browser.no-runtime-errors', report.browserErrors.length === 0, report.browserErrors.join(' | ') || 'none');
  check('browser.no-failed-resources', report.failedResponses.length === 0, report.failedResponses.join(' | ') || 'none');
} catch (error) {
  report.browserErrors.push(error.message);
  check('browser.execution', false, error.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  report.passed = report.checks.filter(entry => entry.ok).length;
  report.failed = report.checks.filter(entry => !entry.ok).length;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.passed} passed, ${report.failed} failed -> ${output}`);
}
process.exitCode = report.failed === 0 ? 0 : 1;
