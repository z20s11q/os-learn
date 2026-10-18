/**
 * T03b 验收测试：GDB/MI 记录解析。
 *
 * 运行：node --test tests/mi-parse.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  errorMessageOf,
  isRunningRecord,
  isStopRecord,
  memoryBlocksOf,
  parseRecord,
  parseResults,
  parseValue,
  registerNamesOf,
  registerValuesOf,
  stopReasonOf,
  unescapeCString,
} from '../services/lab-server/src/adapters/mi-parse.mjs';

test('解析带 token 的结果记录', () => {
  const record = parseRecord('1^done,bkpt={number="1",type="hw breakpoint"}');
  assert.equal(record.token, 1);
  assert.equal(record.type, '^');
  assert.equal(record.cls, 'done');
  assert.equal(record.results.bkpt.number, '1');
  assert.equal(record.results.bkpt.type, 'hw breakpoint');
});

test('解析无 token 的异步记录', () => {
  const record = parseRecord('*stopped,reason="breakpoint-hit",bkptno="1",frame={addr="0xffffffff82056d20",func="start_kernel"}');
  assert.equal(record.token, null);
  assert.equal(record.type, '*');
  assert.equal(record.cls, 'stopped');
});

test('解析 C 字符串转义', () => {
  assert.equal(unescapeCString('a\\nb'), 'a\nb');
  assert.equal(unescapeCString('quote\\"inside'), 'quote"inside');
  assert.equal(unescapeCString('back\\\\slash'), 'back\\slash');
  assert.equal(unescapeCString('tab\\there'), 'tab\there');
  assert.equal(unescapeCString('oct\\101'), 'octA');
  assert.equal(unescapeCString('esc\\033[0m'), 'esc\x1b[0m');
});

test('解析流输出（含转义与换行）', () => {
  const record = parseRecord('~"Reading symbols from /data/os-learn/artifacts/build/linux/vmlinux...\\n"');
  assert.equal(record.type, 'stream');
  assert.equal(record.stream, 'console');
  assert.equal(record.text, 'Reading symbols from /data/os-learn/artifacts/build/linux/vmlinux...\n');
  const log = parseRecord('&"warning: something\\n"');
  assert.equal(log.stream, 'log');
});

test('解析结果列表中的字符串与嵌套元组', () => {
  const { results } = parseResults('msg="No symbol \\"foo\\" in current context",code="undefined-command"');
  assert.equal(results.msg, 'No symbol "foo" in current context');
  assert.equal(results.code, 'undefined-command');
});

test('数字型 token 与 flush 记录', () => {
  assert.equal(parseRecord('42^running').token, 42);
  const flush = parseRecord('(gdb)');
  assert.equal(flush, null);
  assert.equal(parseRecord('#').type, 'flush');
});

test('解析寄存器名列表', () => {
  const record = parseRecord('5^done,register-names=["rax","rbx","rcx","rip","eflags","cs"]');
  const names = registerNamesOf(record);
  assert.deepEqual(names, ['rax', 'rbx', 'rcx', 'rip', 'eflags', 'cs']);
});

test('寄存器名中的空占位符必须保留位置', () => {
  // 真实 GDB 输出里存在大段空名字（保留位），过滤掉会让 cr0 之类的编号整体错位
  const record = parseRecord('5^done,register-names=["rax","rip","","","cr0","efer"]');
  const names = registerNamesOf(record);
  assert.equal(names.length, 6);
  assert.deepEqual(names, ['rax', 'rip', '', '', 'cr0', 'efer']);

  const values = parseRecord(
    '6^done,register-values=[{number="0",value="0x0"},{number="1",value="0xfff0"},{number="2",value="0xdead"},{number="3",value="0xbeef"},{number="4",value="0x60000010"},{number="5",value="0x0"}]',
  );
  const parsed = registerValuesOf(values, names);
  // 保留位(2,3)被跳过，cr0 仍能正确对上 4 号寄存器
  assert.deepEqual(parsed, [
    { name: 'rax', value: '0x0', number: 0 },
    { name: 'rip', value: '0xfff0', number: 1 },
    { name: 'cr0', value: '0x60000010', number: 4 },
    { name: 'efer', value: '0x0', number: 5 },
  ]);
});

test('解析寄存器值并按名字对齐', () => {
  const names = ['rax', 'rip', 'cr3'];
  const record = parseRecord('6^done,register-values=[{number="0",value="0x0"},{number="1",value="0xffffffff82056d20"},{number="2",value="0x20d6000"}]');
  const values = registerValuesOf(record, names);
  assert.deepEqual(values, [
    { name: 'rax', value: '0x0', number: 0 },
    { name: 'rip', value: '0xffffffff82056d20', number: 1 },
    { name: 'cr3', value: '0x20d6000', number: 2 },
  ]);
});

test('稀疏寄存器编号按原编号对齐', () => {
  const names = ['rax', 'rbx'];
  // 只返回 1 号寄存器，值保留在 1 号位置。
  const record = parseRecord('7^done,register-values=[{number="1",value="0xdead"}]');
  const values = registerValuesOf(record, names);
  assert.deepEqual(values, [{ name: 'rbx', value: '0xdead', number: 1 }]);
});

test('解析内存读取块', () => {
  const record = parseRecord('8^done,memory=[{begin="0xfffffff0",offset="0x0",end="0xffffffff",contents="ea5be000f0"}]');
  const blocks = memoryBlocksOf(record);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].begin, '0xfffffff0');
  assert.equal(blocks[0].contents, 'ea5be000f0');
  assert.equal(blocks[0].length, 5);
});

test('停止原因映射到协议取值', () => {
  const breakpoint = stopReasonOf(parseRecord('*stopped,reason="breakpoint-hit",bkptno="1",frame={addr="0xffffffff82056d20",func="start_kernel",line="875"},thread-id="1",core="0"'));
  assert.equal(breakpoint.reason, 'breakpoint');
  assert.equal(breakpoint.rawReason, 'breakpoint-hit');
  assert.equal(breakpoint.cpuId, 0);
  assert.equal(breakpoint.breakpointId, 1);
  assert.equal(breakpoint.function, 'start_kernel');
  assert.equal(breakpoint.line, 875);

  const step = stopReasonOf(parseRecord('*stopped,reason="end-stepping-range",frame={addr="0xe05b"},thread-id="1"'));
  assert.equal(step.cpuId, 0, 'GDB thread-id=1 is not QEMU CPU index 1');
  assert.equal(step.reason, 'step');

  const unknown = stopReasonOf(parseRecord('*stopped,reason="something-new",frame={addr="0x1000"}'));
  assert.equal(unknown.reason, 'unknown');
  // 未知原因必须保留原始文本
  assert.equal(unknown.rawReason, 'something-new');

  const exited = stopReasonOf(parseRecord('*stopped,reason="exited-normally"'));
  assert.equal(exited.reason, 'exited');
  assert.equal(exited.pc, null);
});

test('区分停止与运行通知', () => {
  assert.equal(isStopRecord(parseRecord('*stopped,reason="signal-received"')), true);
  assert.equal(isRunningRecord(parseRecord('*running,thread-id="all"')), true);
  assert.equal(isStopRecord(parseRecord('*running,thread-id="all"')), false);
  assert.equal(isStopRecord(parseRecord('=thread-created,id="1"')), false);
});

test('解析错误记录', () => {
  const record = parseRecord('9^error,msg="Cannot access memory at address 0x0"');
  assert.equal(record.cls, 'error');
  assert.equal(errorMessageOf(record), 'Cannot access memory at address 0x0');
});

test('解析通知与状态记录', () => {
  const notify = parseRecord('=breakpoint-created,bkpt={number="2",addr="0x1000"}');
  assert.equal(notify.type, '=');
  assert.equal(notify.cls, 'breakpoint-created');
  assert.equal(notify.results.bkpt.addr, '0x1000');

  const status = parseRecord('+download,section=".text"');
  assert.equal(status.type, '+');
  assert.equal(status.cls, 'download');
});

test('解析空元组与空列表', () => {
  assert.deepEqual(parseValue('{}', 0).value, []);
  assert.deepEqual(parseValue('[]', 0).value, []);
  const { results } = parseResults('stack=[]');
  assert.deepEqual(results.stack, []);
});

test('解析元组里的未命名值', () => {
  // MI 裸词保留为字符串；数值解释由上层按目标描述完成。
  const parsed = parseValue('{1,2,3}', 0).value;
  assert.deepEqual(parsed, ['1', '2', '3']);
  const mixed = parseValue('{name="x",42}', 0).value;
  assert.equal(mixed.name, 'x');
  assert.equal(mixed['0'], '42');
});
