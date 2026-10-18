import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryOverview, memoryCell, physicalSamples } from '../docs/animation/panorama-memory.js';
import { getStepState, steps } from '../docs/animation/panorama-data.js';

test('overview always covers all RAM in 1 MiB cells', () => {
  const view = memoryOverview(512 * 1024 * 1024);
  assert.deepEqual(view, { start: 0, end: 0x20000000, cellBytes: 0x100000, count: 512 });
  assert.equal(memoryCell(view, 0).start, 0);
  assert.equal(memoryCell(view, 511).end, view.end);
  assert.equal(memoryCell(memoryOverview(0x100001), 1).end, 0x100001);
  for (const value of [-1, 0, 1.5, 'bad']) assert.throws(() => memoryOverview(value));
});

test('unknown bytes stay unknown and measured zero bytes remain visible', () => {
  const reset = getStepState('reset-vector');
  const samples = physicalSamples(reset.frame);
  assert.equal(memoryCell({ start: 0, end: 128, cellBytes: 1 }, 0, samples).value, '00');
  assert.equal(memoryCell({ start: 0x80000, end: 0x80080, cellBytes: 1 }, 0, samples).value, null);
  const view = { start: 0xfffffff0, end: 0x100000000, cellBytes: 1 };
  assert.equal(memoryCell(view, 0, samples).value, 'ea');
  assert.equal(memoryCell(view, 0, []).value, null);
  assert.equal(physicalSamples(null).length, 0);
  assert.equal(physicalSamples({ ...reset.frame, cpu: { ...reset.frame.cpu, control: { cr0: '0x80000001' } } }).some(m => m.label === 'pc'), false);
});

test('byte highlighting selects only changed offsets', () => {
  const delta = [{ addressSpace: 'physical', address: '0x0', changedOffsets: [1, 3] }];
  const view = { start: 0, end: 128, cellBytes: 1 };
  assert.equal(memoryCell(view, 0, [], delta).changed, false);
  assert.equal(memoryCell(view, 1, [], delta).changed, true);
  assert.equal(memoryCell(view, 2, [], delta).changed, false);
});

test('opening steps distinguish unpowered hardware, reset initialization and later loads', () => {
  const off = getStepState('power-off');
  assert.equal(off.frame, null);
  assert.equal(off.registers.rip, null);
  assert.match(off.step.detail, /无电.*没有.*逻辑值/);
  assert.ok(off.step.startupFacts.some(f => /linux16.*bzImage.*initrd16/.test(f.text)));
  const reset = getStepState('reset-vector');
  assert.equal(reset.sampleDelta, null);
  assert.match(reset.step.detail, /第一条客户机指令执行前/);
  assert.match(reset.step.detail, /窗口外未采样/);
  assert.equal(reset.registers.rdx, '0x60fb1');
  assert.equal(reset.registers.cr0, '0x60000010');
  assert.ok(steps.find(s => s.id === 'bios-stack').detail.includes('复位之后'));
});
