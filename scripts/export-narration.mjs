#!/usr/bin/env node
// Export narration without requiring the Linux kernel build tree on this host.
import fs from 'node:fs';
import path from 'node:path';
import { ACTS } from '../docs/animation/boot/story-data.js';
import { steps } from '../docs/animation/panorama-data.js';
import { splitCues } from '../docs/animation/panorama-cues.js';

const root = path.resolve(import.meta.dirname, '..');
const target = process.argv[2] || 'all';
const bundles = {
  boot: ACTS.flatMap(act => act.ops.map((op, index) => ({
    id: `${act.id}-${index}`, text: op.tts || op.say,
  }))),
  panorama: steps.map(step => ({
    id: step.id, text: step.narration || `${step.title}。${step.summary}${step.detail}`,
    cues: splitCues(step.narration || `${step.title}。${step.summary}${step.detail}`),
  })),
};
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
for (const [name, entries] of Object.entries(bundles)) {
  if (target !== 'all' && target !== name) continue;
  const file = path.join(root, `tmp/${name}-narration.json`);
  fs.writeFileSync(file, JSON.stringify(entries, null, 2) + '\n');
  console.log(`${name}: ${entries.length} clips, ${entries.reduce((n, e) => n + e.text.length, 0)} characters → ${file}`);
}
