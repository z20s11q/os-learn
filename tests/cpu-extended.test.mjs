import test from 'node:test';
import assert from 'node:assert/strict';
import { collectExtendedCpu, decodeCpuExecutionMode, parseQemuRegisterDump, registerBits } from '../services/lab-server/src/collect/cpu-extended.mjs';

// These fixtures exercise the exact QEMU 8.2/GDB formats seen in a live reset
// probe. Deliberately nonzero payloads expose endian, TOP, and precision errors.
test('128-bit GDB union selects uint128 and preserves low bits', () => {
  const raw = '{v4_float = {0x1, 0x2, 0x3, 0x4}, v2_int64 = {0x1122334455667788, 0x99aabbccddeeff00}, uint128 = 0x99aabbccddeeff001122334455667788}';
  assert.equal(registerBits(raw, 128, { vector: true }), '0x99aabbccddeeff001122334455667788');
  assert.equal(registerBits(raw, 128), null);
  assert.equal(registerBits('0x100000000', 32), null, 'overflow must not truncate');
  assert.equal(registerBits('unavailable', 128), null);
});

test('raw binary80 preserves all 80 payload bits', () => {
  assert.equal(registerBits('0x3fffc000000000000001', 80), '0x3fffc000000000000001');
  assert.equal(registerBits('1.5', 80), null);
  assert.equal(registerBits('0x0', 80), '0x00000000000000000000');
});

test('QEMU physical FPR slots map to logical ST using FSW.TOP; abridged FTW stays separate', () => {
  const parsed = parseQemuRegisterDump('DR0=0000000000000001 DR6=00000000ffff0ff0\r\nFCW=037f FSW=1800 [ST=3] FTW=09 MXCSR=00001f80\r\nFPR0=0123456789abcdef 4000 FPR3=c000000000000001 3fff\r\nXMM00=99aabbccddeeff00 1122334455667788');
  assert.equal(parsed.get('dr0').value, '0x0000000000000001');
  assert.equal(parsed.get('st0').value, '0x3fffc000000000000001');
  assert.equal(parsed.get('st5').value, '0x40000123456789abcdef');
  assert.equal(parsed.get('ftwAbridged').value, '0x09');
  assert.equal(parsed.has('ftw'), false);
  assert.equal(parsed.get('xmm0').value, '0x99aabbccddeeff001122334455667788');
});

test('mode uses LMA and CS.L/D, including 16-bit compatibility code', () => {
  const ctx = { cr0: '0x80000001', efer: '0x500', csAttributes: '0xc09b00' };
  assert.deepEqual(decodeCpuExecutionMode(ctx), { mode: 'protected-32', modeDetail: 'long-compat-32' });
  assert.deepEqual(decodeCpuExecutionMode({ ...ctx, csAttributes: '0x209b00' }), { mode: 'long-64', modeDetail: 'long-64' });
  assert.deepEqual(decodeCpuExecutionMode({ ...ctx, csAttributes: '0x9b00' }), { mode: 'protected-16', modeDetail: 'long-compat-16' });
  assert.equal(decodeCpuExecutionMode({ ...ctx, csAttributes: null }).mode, 'unknown');
  assert.equal(decodeCpuExecutionMode({ cr0: '0x60000010', efer: null, csAttributes: null }).mode, 'real-16');
});

test('supplementary reads keep captureId and explicit gaps; GDB fake ftag is rejected', async () => {
  const value = await collectExtendedCpu({
    mi: { async readRegisters() { throw new Error('GDB long double must not be used as binary80'); } },
    qmp: { async queryStatus() { return { running: false }; }, async hmp() { return 'DR7=0000000000000400 FCW=037f FSW=0000 FTW=00 MXCSR=00001f80 FPR0=c000000000000001 3fff'; } },
    byName: new Map([['st0', '0x1'], ['ftag', '0x0'], ['k_gs_base', '0xffff888000001000'], ['xmm15', '{uint128 = 0xfedcba98765432100123456789abcdef}']]),
    observer: { captureId: 'observer-7', cpus: [] }, captureId: 'cap-test-7',
  });
  const reg = (name) => value.registers.find((entry) => entry.name === name);
  assert.equal(value.barrier, 'vm-stopped-before-and-after-read');
  assert.equal(reg('st0').value, '0x3fffc000000000000001');
  assert.equal(reg('xmm15').value, '0xfedcba98765432100123456789abcdef');
  assert.equal(reg('kernelGsBase').value, '0xffff888000001000');
  assert.equal(reg('ftw').value, null);
  assert.match(reg('ftw').reason, /hard-coded zero/);
  assert.equal(reg('star').value, null);
  for (const entry of value.registers) assert.equal(entry.captureId, value.captureId);
});

test('missing QMP FPR leaves raw x87 payloads unavailable', async () => {
  const value = await collectExtendedCpu({
    qmp: { async queryStatus() { return { running: false }; }, async hmp() { return 'FSW=0000'; } },
    byName: new Map([['st0', '0x2']]), captureId: 'cap-fpr-missing',
  });
  const st0 = value.registers.find((entry) => entry.name === 'st0');
  assert.equal(st0.value, null);
  assert.match(st0.reason, /cast long double/);
});

test('a resumed VM invalidates all supplemental fields', async () => {
  let statuses = 0;
  const value = await collectExtendedCpu({
    mi: { async readRegisters() { return []; } },
    qmp: { async queryStatus() { return { running: statuses++ > 0 }; }, async hmp() { return 'DR7=0000000000000400'; } },
    byName: new Map(), captureId: 'cap-resumed',
  });
  assert.equal(value.barrier, 'unverified');
  assert.ok(value.registers.every((entry) => entry.value === null && entry.reason.startsWith('stop-barrier-unverified')));
});
