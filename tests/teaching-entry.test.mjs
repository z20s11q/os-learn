import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('the retired lyrics page is removed and the current boot page remains', () => {
  assert.equal(fs.existsSync(path.join(root, 'docs/animation/slides.html')), false);
  assert.equal(fs.existsSync(path.join(root, 'docs/animation/boot.html')), true);
  assert.equal(fs.existsSync(path.join(root, 'docs/animation/boot/story-timing.js')), true);
});

test('debugger links use the current boot teaching page', () => {
  for (const file of ['apps/debugger-web/src/App.tsx', 'apps/debugger-web/src/components/ControlBar.tsx']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /href="\/animation\/boot\.html"/);
    assert.doesNotMatch(source, /\/animation\/slides\.html/);
  }
});
