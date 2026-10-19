// Keep the displayed assembly and downloadable NASM source identical.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'docs/animation/boot/descriptor-example.asm'), 'utf8');
const sections = {};
let current = null;
source.split(/\r?\n/).forEach((text, i) => {
  const start = text.match(/^; @section (\w+)$/);
  if (start) {
    if (current || sections[start[1]]) throw Error(`Duplicate/nested assembly section at line ${i + 1}`);
    current = start[1];
    sections[current] = [];
  } else if (text === '; @end') {
    if (!current) throw Error(`Unexpected section end at line ${i + 1}`);
    current = null;
  } else if (current) sections[current].push({ n: i + 1, t: text });
});
if (current) throw Error('Unclosed assembly section');
fs.writeFileSync(path.join(root, 'docs/animation/boot/descriptor-assembly.js'),
  '// Generated from descriptor-example.asm by scripts/build-descriptor-example.mjs.\n'
  + `export const ASSEMBLY = ${JSON.stringify(sections, null, 2)};\n`);
console.log(`Descriptor example: ${Object.keys(sections).length} assembly sections`);
