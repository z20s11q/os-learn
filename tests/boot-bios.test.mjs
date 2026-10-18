import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTS, CODE_REFS } from '../docs/animation/boot/story-data.js';
import { CODE } from '../docs/animation/boot/story-code.js';

const bios = ACTS.find(act => act.id === 'bios').ops;
const normalized = text => text.replace(/\s+/g, ' ').trim();

test('BIOS enters protected mode before loading a 32-bit code segment', () => {
  const prepare = bios.findIndex(op => op.line === 'lgdtw %cs:rombios32_gdt_48');
  const enable = bios.findIndex(op => op.line === 'movl %ecx, %cr0');
  const jump = bios.findIndex(op => op.line === 'ljmpl $SEG32_MODE32_CS');
  const data = bios.findIndex(op => op.line === 'movw %cx, %ss');
  assert.ok(prepare < enable && enable < jump && jump < data);
  assert.equal(bios[enable].mode, 'prot16');
  assert.equal(bios[jump].mode, 'prot');
  assert.equal(BigInt(bios[enable].set.cr0) & 1n, 1n);
  assert.equal(BigInt(bios[enable].set.cr0) & (1n << 31n), 0n);
  assert.deepEqual(bios[jump].seg.cs, ['0x8', '0x0']);
  assert.deepEqual(bios[data].seg.ds, ['0x10', '0x0']);
  assert.deepEqual(bios[data].seg.ss, ['0x10', '0x0']);
  assert.ok(bios.every(op => !op.paging && op.mode !== 'long'));
});

test('BIOS explains the purpose and the return to real mode', () => {
  assert.match(bios[0].say, /平坦地址/);
  assert.match(bios[0].say, /C 语言本身不要求/);
  const returning = bios.find(op => op.code === 'sb-trans16');
  assert.equal(returning.mode, 'prot16');
  assert.match(returning.say, /先收回数据段范围，再远跳转/);
  assert.match(returning.say, /清掉 CR0.PE/);
  assert.equal(bios.at(-1).mode, 'real');
  assert.equal(BigInt(bios.at(-1).set.cr0) & 1n, 0n);
  assert.deepEqual(bios.at(-1).seg.ss, ['0x0', '0x0']);
});

test('every boot lesson code highlight exists in its source excerpt', () => {
  for (const act of ACTS) for (const op of act.ops) {
    if (!op.code) continue;
    assert.ok(CODE_REFS[op.code], op.code);
    assert.ok(CODE[op.code], op.code);
    if (op.line) assert.ok(CODE[op.code].lines.some(line => line.t
      && normalized(line.t).includes(normalized(op.line))), `${act.id}: ${op.line}`);
  }
});
