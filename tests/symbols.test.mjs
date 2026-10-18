/**
 * T03e 验收测试：多阶段符号解析与同名符号处理。
 *
 * 运行：node --test tests/symbols.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  SymbolRegistry,
  parseNmOutput,
  symbolStages,
} from '../services/lab-server/src/adapters/symbols.mjs';

const ROOT = '/data/os-learn';

test('解析 nm 输出并按地址排序', () => {
  const symbols = parseNmOutput(
    ['0000000000000200 T startup_64', '0000000000000000 T _head', 'ffffffff82056d20 T start_kernel', ''].join('\n'),
  );
  assert.equal(symbols.length, 3);
  assert.equal(symbols[0].name, '_head');
  assert.equal(symbols[0].address, 0n);
  assert.equal(symbols[2].name, 'start_kernel');
  assert.equal(symbols[2].address, 0xffffffff82056d20n);
  assert.equal(symbols[2].global, true);
});

test('startup_64 在同名时必须报告歧义', () => {
  const registry = new SymbolRegistry({ root: ROOT });
  const resolved = registry.resolve('startup_64');
  assert.equal(resolved.found, true);
  assert.equal(resolved.ambiguous, true, 'startup_64 在解压器与主内核中都存在，必须判为歧义');
  const modules = resolved.candidates.map((entry) => entry.module).sort();
  assert.deepEqual(modules, ['linux-decompressor', 'linux-kernel']);
});

test('按模块限定后可以唯一解析同名符号', () => {
  const registry = new SymbolRegistry({ root: ROOT });
  const decompressor = registry.resolve('startup_64', { module: 'linux-decompressor' });
  assert.equal(decompressor.ambiguous, false);
  assert.equal(decompressor.candidates.length, 1);
  assert.equal(decompressor.candidates[0].address, '0x200');

  const kernel = registry.resolve('startup_64', { module: 'linux-kernel' });
  assert.equal(kernel.ambiguous, false);
  assert.equal(kernel.candidates[0].address, '0xffffffff81000000');
});

test('歧义符号生成断点时报告候选', () => {
  const registry = new SymbolRegistry({ root: ROOT });
  const spec = registry.breakpointSpec('startup_64');
  assert.equal(spec.ok, false);
  assert.match(spec.reason, /多个模块/);
  assert.ok(spec.candidates.length >= 2);

  const scoped = registry.breakpointSpec('start_kernel', { module: 'linux-kernel' });
  assert.equal(scoped.ok, true);
  assert.equal(scoped.address, '0xffffffff82056d20');
});

test('未找到的符号给出明确原因', () => {
  const registry = new SymbolRegistry({ root: ROOT });
  const spec = registry.breakpointSpec('definitely_not_a_kernel_symbol');
  assert.equal(spec.ok, false);
  assert.match(spec.reason, /未找到符号/);
});

test('SeaBIOS 与 GRUB 的符号文件缺口被明确标注', () => {
  const registry = new SymbolRegistry({ root: ROOT });
  const availability = registry.availability();
  const seabios = availability.find((entry) => entry.id === 'seabios');
  const grub = availability.find((entry) => entry.id === 'grub');
  assert.equal(seabios.hasSymbols, false);
  assert.match(seabios.reason, /裸 ROM/);
  assert.equal(grub.hasSymbols, false);
  assert.match(grub.reason, /可重定位/);
});

test('有符号的阶段被识别为可用', () => {
  const registry = new SymbolRegistry({ root: ROOT });
  for (const id of ['linux-setup', 'linux-decompressor', 'linux-kernel']) {
    assert.equal(registry.available(id), true, `${id} 应有符号文件`);
  }
});

test('装载地址待实测时 add-symbol-file 命令列表为空', () => {
  const registry = new SymbolRegistry({ root: ROOT });
  const plan = registry.addSymbolFileCommands();
  // setup 与解压器具备符号，装载地址为待实测状态。
  assert.deepEqual(plan.commands, []);
  const pendingModules = plan.pending.map((entry) => entry.module).sort();
  assert.deepEqual(pendingModules, ['grub', 'linux-decompressor', 'linux-setup', 'seabios']);
  assert.ok(plan.pending.every((entry) => entry.reason.length > 0));
});

test('登记实测装载地址后才生成 add-symbol-file 命令', () => {
  const registry = new SymbolRegistry({ root: ROOT });
  registry.setLoadAddress('linux-decompressor', 0x100000n);
  const plan = registry.addSymbolFileCommands();
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.commands[0].module, 'linux-decompressor');
  assert.match(plan.commands[0].command, /add-symbol-file/);
  assert.match(plan.commands[0].command, /0x100000/);
});

test('按地址判定阶段', () => {
  const registry = new SymbolRegistry({ root: ROOT });
  const kernel = registry.stageForAddress(0xffffffff82056d20n);
  assert.equal(kernel.stage, 'linux-kernel');
  assert.equal(kernel.measured, true);

  const romArea = registry.stageForAddress(0xfe05bn);
  assert.equal(romArea.stage, 'seabios');
  assert.equal(romArea.measured, false);
  assert.match(romArea.reason, /未实测/);

  const elsewhere = registry.stageForAddress(0x7ffff7ff6000n);
  assert.equal(elsewhere.stage, null);
  assert.match(elsewhere.reason, /装载地址/);
});

test('阶段定义全部包含说明或原因', () => {
  for (const stage of symbolStages(ROOT)) {
    assert.ok(typeof stage.id === 'string' && stage.id.length > 0);
    assert.ok(typeof stage.note === 'string' && stage.note.length > 0);
    if (stage.symbolFile === null) {
      assert.ok(typeof stage.symbolFileReason === 'string' && stage.symbolFileReason.length > 0);
    }
  }
});
