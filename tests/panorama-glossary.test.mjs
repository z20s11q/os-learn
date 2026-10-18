import test from 'node:test';
import assert from 'node:assert/strict';
import { annotate, annotateHtml, glossary } from '../docs/animation/panorama-glossary.js';
import { splitCues } from '../docs/animation/panorama-cues.js';
import { steps, stages } from '../docs/animation/panorama-data.js';

test('registers, bits and dotted fields get one Chinese gloss each', () => {
  assert.equal(annotate('CS 选择子为 0xf000，IP=0xfff0'), 'CS（代码段寄存器） 选择子为 0xf000，IP（指令指针）=0xfff0');
  assert.equal(annotate('CR0.PE 置 1，EFER.LMA=1，CS.L=1，GS.base'), 'CR0.PE（保护模式使能位） 置 1，EFER.LMA（长模式已激活位）=1，CS.L（64 位代码段标志）=1，GS.base（GS 段基址）');
  assert.equal(annotate('CS/DS 与 GDT/IDT'), 'CS（代码段寄存器）/DS（数据段寄存器） 与 GDT（全局描述符表）/IDT（中断描述符表）');
  assert.equal(annotate('CR3（页表根）已写入'), 'CR3（页表根）已写入');
  assert.equal(annotateHtml('RSP<', s => s.replace('<', '&lt;')), 'RSP<span class="gloss">（栈指针）</span>&lt;');
});

test('identifiers, paths and ordinary words stay untouched', () => {
  const text = 'start_kernel、CR0_STATE、local_irq_disable、x86_64、/dev/vda、head_64.S、GRUB、BIOS、QEMU、CPU';
  assert.equal(annotate(text), text);
});

test('every register term in teaching text is glossed', () => {
  const names = [...Object.keys(glossary.terms)].sort((a, b) => b.length - a.length).join('|');
  const bare = new RegExp(`(?<![A-Za-z0-9_.\\-])(?:${names})(?:\\.[A-Za-z][A-Za-z0-9]*)?(?![A-Za-z0-9_])`, 'g');
  const texts = [...stages.map(s => s.title), ...steps.flatMap(s => [s.title, s.summary, s.detail, ...splitCues(s.narration).map(c => c.text)])];
  let glossed = 0;
  for (const text of texts) {
    const out = annotate(text).replace(/（[^）]*）/g, '（）');
    for (const m of out.matchAll(bare)) {
      assert.equal(out[m.index + m[0].length], '（', `"${m[0]}" glossed in: ${out}`);
      glossed++;
    }
  }
  assert.ok(glossed > 150, `${glossed} glossed mentions`);
});
