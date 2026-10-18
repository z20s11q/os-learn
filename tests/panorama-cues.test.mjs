import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitCues, cueTargets, planBeats, startsFromWords, estimateStarts, cueAt } from '../docs/animation/panorama-cues.js';
import { steps, registerGroups, getStepState } from '../docs/animation/panorama-data.js';

const registerIds = new Set(registerGroups.flatMap(group => group.items.map(item => item.id)));
const animation = path.resolve(import.meta.dirname, '../docs/animation');

test('every narration splits into ordered lines that cover the whole text', () => {
  for (const step of steps) {
    const cues = splitCues(step.narration);
    assert.ok(cues.length >= 2, `${step.id} has several lines`);
    const gap = (from, to) => /^[\s。；，]*$/.test(step.narration.slice(from, to));
    assert.ok(gap(0, cues[0].start));
    for (let i = 1; i < cues.length; i++) assert.ok(cues[i].start >= cues[i - 1].end && gap(cues[i - 1].end, cues[i].start), `${step.id} line ${i} drops no words`);
    assert.ok(gap(cues.at(-1).end, step.narration.length));
    assert.ok(cues.every(cue => cue.text.length > 0 && !/[。；]$/.test(cue.text)));
  }
});

test('lines mention registers, flags and machine parts', () => {
  const t = cueTargets('CS 选择子为 0xf000，IP=0xfff0，取指地址来自 ROM', registerIds);
  assert.ok(t.registers.has('cs') && t.registers.has('rip') && t.registers.has('linearPc'));
  assert.ok(t.components.has('rom'));
  assert.ok(cueTargets('第一步：CR4.PAE = 1', registerIds).flags.has('cr4.PAE'));
  assert.ok(cueTargets('进入长模式', registerIds).flags.has('efer.LME'));
});

test('a register change appears on the line that names it and its flags flip together', () => {
  const state = getStepState('boot-image');
  const cues = splitCues(state.step.narration);
  const targets = cues.map(cue => cueTargets(cue.text, registerIds));
  const plan = planBeats({ targets, registerIds: state.sampleDelta.registers.map(r => r.id), flags: state.sampleDelta.flags, memoryChanges: state.step.memoryChanges, position: state.provenance.position });
  const line = cues.findIndex(cue => /IF=1/.test(cue.text));
  assert.equal(plan.registers.get('rflags'), line);
  assert.equal(plan.flags.get('rflags.IF'), plan.registers.get('rflags'));
  assert.ok(plan.memory.every(beat => beat >= 0 && beat <= plan.last));
});

test('narration manifests carry word timings that line up with every line', () => {
  for (const narrator of ['panorama', 'panorama-xiaoxiao', 'panorama-yunxi']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(animation, 'audio', narrator, 'manifest.json'), 'utf8'));
    const entries = Object.fromEntries(manifest.entries.map(entry => [entry.id, entry]));
    for (const step of steps) {
      const entry = entries[step.id];
      assert.equal(entry?.text, step.narration, `${narrator}/${step.id} audio speaks the current narration`);
      assert.ok(fs.existsSync(path.join(animation, manifest.audioMap[step.id])), `${narrator}/${step.id} MP3 exists`);
      const cues = splitCues(step.narration);
      const starts = startsFromWords(cues, step.narration, entry.words);
      assert.ok(starts, `${narrator}/${step.id} has word timings`);
      for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], `${narrator}/${step.id} line ${i + 1} starts later`);
    }
  }
});

test('estimated timing and lookup stay within the narration', () => {
  const cues = splitCues(steps[1].narration);
  const starts = estimateStarts(cues, 30, 0.2, 0.5);
  assert.equal(starts[0], 0);
  assert.ok(starts.at(-1) < 30);
  assert.equal(cueAt(starts, 0), 0);
  assert.equal(cueAt(starts, 29.9), cues.length - 1);
});
