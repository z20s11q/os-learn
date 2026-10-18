/**
 * T07a 单元测试：布局清单的绑定、查表与按位取值。
 *
 * 这里用**合成数据**：手工拼一份最小 ELF（只含 GNU build ID note）和一份合成布局清单，
 * 覆盖镜像绑定拒绝、点号字段路径与跨字节位域读取。
 * scripts/verify-t07a.mjs 使用 GDB 逐项对照真实 vmlinux 的 DWARF。
 *
 * 最后一段是"产物真的能加载"的集成检查：跑在真实布局清单与真实 vmlinux 上，缺失时跳过。
 *
 * 运行：node --test tests/linux-layout.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KernelLayout,
  LayoutBindingError,
  LAYOUT_SCHEMA,
  isSignedTypeName,
  layoutArtifactName,
  liveBuildId,
  readBitfield,
  readField,
  readSigned,
  readUnsigned,
} from '../packages/linux-decoder/index.ts';

/* -------------------------------------------------------------------------- */
/* 合成一份最小 ELF64（小端），只有一个 .notes 段装 build ID                     */
/* -------------------------------------------------------------------------- */

const BUILD_ID = Buffer.from('f5e5edc1c57291e28322ccce9a9c2af2c4c76428', 'hex');

/**
 * 手工拼 ELF：64 字节头 + note 段 + 段名字符串表 + 段表，共 3 个段（空段、.shstrtab、.notes）。
 *
 * 合成 ELF 提供可控 build ID，覆盖 KernelLayout.verifyAgainst 的绑定成功与拒绝分支。
 */
function makeElf(buildIdBytes) {
  const headerSize = 64;
  const notesOffset = headerSize;
  const noteSize = 12 + 4 + buildIdBytes.length;
  const strtabOffset = notesOffset + noteSize;
  const strtab = Buffer.from('\0.notes\0.shstrtab\0', 'latin1');
  const sectionHeadersOffset = (strtabOffset + strtab.length + 7) & ~7;

  const bytes = new Uint8Array(sectionHeadersOffset + 3 * 64);
  const view = new DataView(bytes.buffer);

  // ELF 头
  bytes.set([0x7f, 0x45, 0x4c, 0x46], 0);
  bytes[4] = 2; // ELFCLASS64
  bytes[5] = 1; // ELFDATA2LSB
  bytes[6] = 1; // EV_CURRENT
  view.setUint16(0x10, 1, true); // e_type = ET_REL
  view.setUint16(0x12, 0x3e, true); // e_machine = x86-64
  view.setBigUint64(0x28, BigInt(sectionHeadersOffset), true); // e_shoff
  view.setUint16(0x3a, 64, true); // e_shentsize
  view.setUint16(0x3c, 3, true); // e_shnum
  view.setUint16(0x3e, 1, true); // e_shstrndx → 段 1 = .shstrtab

  // .notes 内容：namesz / descsz / type=NT_GNU_BUILD_ID(3) / "GNU\0" / build ID
  view.setUint32(notesOffset, 4, true);
  view.setUint32(notesOffset + 4, buildIdBytes.length, true);
  view.setUint32(notesOffset + 8, 3, true);
  bytes.set([0x47, 0x4e, 0x55, 0x00], notesOffset + 12);
  bytes.set(buildIdBytes, notesOffset + 16);

  bytes.set(strtab, strtabOffset);

  const writeSection = (index, nameOffset, type, offset, size) => {
    const base = sectionHeadersOffset + index * 64;
    view.setUint32(base, nameOffset, true);
    view.setUint32(base + 4, type, true);
    view.setBigUint64(base + 0x18, BigInt(offset), true);
    view.setBigUint64(base + 0x20, BigInt(size), true);
  };
  writeSection(0, 0, 0, 0, 0); // SHT_NULL
  writeSection(1, 8, 3, strtabOffset, strtab.length); // .shstrtab
  writeSection(2, 1, 7, notesOffset, noteSize); // .notes，类型 SHT_NOTE

  return bytes;
}

/* -------------------------------------------------------------------------- */
/* 合成一份布局清单                                                             */
/* -------------------------------------------------------------------------- */

const EVIDENCE = {
  die: 100,
  definitionCount: 3,
  declarationCount: 0,
  comparedCount: 3,
  consistent: true,
  inconsistentAt: [],
};

function makeLayout(overrides = {}) {
  return {
    schema: LAYOUT_SCHEMA,
    generatedAt: '2026-10-16T02:00:00.000Z',
    source: {
      vmlinux: 'artifacts/build/linux/vmlinux',
      bytes: 243405952,
      sha256: 'e14918275626bf30'.padEnd(64, '0'),
      buildId: BUILD_ID.toString('hex'),
      linuxRelease: '6.12.112-observatory',
      dwarfVersion: 4,
      compileUnits: 1690,
      diesScanned: 12217480,
      typeNames: 4,
      anonymousDepthLimit: 4,
      generator: 'packages/linux-decoder/tools/gen-layout.mjs',
    },
    types: {
      task_struct: {
        kind: 'struct',
        name: 'task_struct',
        cTypeName: 'struct task_struct',
        byteSize: 7296,
        alignment: 64,
        declaration: false,
        evidence: EVIDENCE,
        members: [{ name: 'pid', byteOffset: 1408, bitOffset: 11264, bitSize: null, byteSize: 4, typeName: 'pid_t', typeDie: 900, anonymous: false }],
        enumerators: [],
        fields: {
          pid: {
            byteOffset: 1408, bitOffset: 11264, bitSize: null, byteSize: 4,
            typeName: 'pid_t', typeDie: 900, viaAnonymous: false, path: ['pid'],
          },
          'mm.mmap_base': {
            byteOffset: 1280, bitOffset: 10240, bitSize: null, byteSize: 8,
            typeName: 'unsigned long', typeDie: 901, viaAnonymous: true, path: ['mm', 'mmap_base'],
          },
          'flags.in_iowait': {
            byteOffset: 1336, bitOffset: 10692, bitSize: 1, byteSize: 4,
            typeName: 'unsigned int', typeDie: 902, viaAnonymous: true, path: ['flags', 'in_iowait'],
          },
          opaque: {
            byteOffset: 16, bitOffset: 128, bitSize: null, byteSize: null,
            typeName: 'struct <anonymous>', typeDie: 903, viaAnonymous: false, path: ['opaque'],
          },
          comm: {
            byteOffset: 1896, bitOffset: 15168, bitSize: null, byteSize: 16,
            typeName: 'char[16]', typeDie: 904, viaAnonymous: false, path: ['comm'],
          },
        },
      },
      mm_struct: {
        kind: 'struct',
        name: 'mm_struct',
        cTypeName: 'struct mm_struct',
        byteSize: 1216,
        alignment: 64,
        declaration: false,
        evidence: EVIDENCE,
        members: [],
        enumerators: [],
        fields: {},
      },
      pid_type: {
        kind: 'enum',
        name: 'pid_type',
        cTypeName: 'enum pid_type',
        byteSize: 4,
        alignment: 4,
        declaration: false,
        evidence: EVIDENCE,
        members: [],
        enumerators: [{ name: 'PIDTYPE_PID', value: 0 }, { name: 'PIDTYPE_TGID', value: 1 }, { name: 'PIDTYPE_NOBODY', value: null }],
        fields: {},
      },
      maple_enode: {
        kind: 'struct',
        name: 'maple_enode',
        cTypeName: 'struct maple_enode',
        byteSize: null,
        alignment: null,
        declaration: true,
        evidence: { ...EVIDENCE, definitionCount: 0, comparedCount: 0, consistent: null },
        members: [],
        enumerators: [],
        fields: {},
      },
    },
    missing: [{ name: 'xas_state_flags', kind: 'enum', required: false, why: '用法', reason: 'DWARF 里找不到定义' }],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 小端写整数（给位域测试造字节）                                                */
/* -------------------------------------------------------------------------- */

function writeLEBig(bytes, offset, value, width) {
  let rest = value;
  for (let i = 0; i < width; i += 1) {
    bytes[offset + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

/* -------------------------------------------------------------------------- */

test('schema 错误时拒绝解析', () => {
  assert.throws(
    () => KernelLayout.parse(JSON.stringify(makeLayout({ schema: 'oslab.linux-layout/2' }))),
    /只认/,
  );
});

test('字段用点号路径查，穿过匿名成员的也能查到', () => {
  const layout = new KernelLayout(makeLayout());
  assert.equal(layout.byteOffset('task_struct', 'mm.mmap_base'), 1280);
  assert.equal(layout.byteOffset('task_struct', 'flags.in_iowait'), 1336);
  assert.equal(layout.field('task_struct', 'mm.mmap_base').viaAnonymous, true);
  assert.equal(layout.field('task_struct', 'pid').viaAnonymous, false);
  assert.equal(layout.hasField('task_struct', 'pid'), true);
  assert.equal(layout.hasField('task_struct', 'nope'), false);
  assert.equal(layout.has('maple_enode'), true);
  assert.equal(layout.has('no_such_type'), false);
});

test('字段名写错时，报错要指出这个类型里有多少路径可查', () => {
  const layout = new KernelLayout(makeLayout());
  assert.throws(
    () => layout.field('task_struct', 'pidd'),
    (error) => {
      assert.equal(error.name, 'LayoutError');
      assert.equal(error.detail.fieldCount, 5);
      assert.deepEqual(error.detail.samples.slice(0, 2), ['pid', 'mm.mmap_base']);
      return true;
    },
  );
});

test('类型名写错与"只有前向声明"要分开报，因为处置不同', () => {
  const layout = new KernelLayout(makeLayout());
  assert.throws(() => layout.field('nope_struct', 'x'), /布局清单里没有类型 nope_struct/);
  assert.throws(() => layout.field('maple_enode', 'x'), /只有前向声明/);
});

test('枚举值：0 是合法取值，缺失与"没有常量值"各自报错', () => {
  const layout = new KernelLayout(makeLayout());
  assert.equal(layout.enumValue('pid_type', 'PIDTYPE_PID'), 0);
  assert.equal(layout.enumValue('pid_type', 'PIDTYPE_TGID'), 1);
  assert.throws(() => layout.enumValue('pid_type', 'PIDTYPE_NOPE'), /没有枚举项/);
  assert.throws(() => layout.enumValue('pid_type', 'PIDTYPE_NOBODY'), /没有取值/);
});

test('清单文件名把内核版本与 build ID 写进去', () => {
  assert.equal(
    layoutArtifactName({ linuxRelease: '6.12.112-observatory', buildId: 'f5e5edc1c57291e28322ccce9a9c2af2c4c76428' }),
    'linux-6.12.112-observatory-f5e5edc1c572.json',
  );
  assert.equal(layoutArtifactName({}), 'linux-unknown-nobuildid.json');
});

test('读 8 字节返回 bigint：内核地址超过 2^53，Number 会静默丢低位', () => {
  const bytes = new Uint8Array(16);
  const pointer = 0xffff888012345678n;
  writeLEBig(bytes, 0, pointer, 8);
  const value = readUnsigned(bytes, 0, 8);
  assert.equal(typeof value, 'bigint');
  assert.equal(value, pointer);
  assert.ok(value > BigInt(Number.MAX_SAFE_INTEGER));
  // Number 超过精确整数范围时丢失低位，bigint 保留原始值。
  assert.notEqual(BigInt(Number(pointer)), pointer);

  writeLEBig(bytes, 8, 0x1234n, 2);
  assert.equal(readUnsigned(bytes, 8, 2), 0x1234);
  assert.equal(typeof readUnsigned(bytes, 8, 2), 'number');
});

test('符号扩展按字段宽度计算', () => {
  const bytes = new Uint8Array(8);
  bytes[0] = 0xff;
  bytes[1] = 0x80;
  assert.equal(readSigned(bytes, 0, 1), -1);
  assert.equal(readUnsigned(bytes, 0, 1), 255);
  assert.equal(readSigned(bytes, 0, 2), -32513); // 0x80ff
  const all = new Uint8Array(8).fill(0xff);
  assert.equal(readSigned(all, 0, 8), -1n);
  assert.equal(readUnsigned(all, 0, 8), 18446744073709551615n);
});

test('位域按"第几字节第几位"读，跨字节的也对', () => {
  const bytes = new Uint8Array(16);
  // 12 位字段，从第 4 字节的第 6 位开始 → 跨越第 4、5 两个字节。
  writeLEBig(bytes, 4, 0x0abn << 6n, 4);
  assert.equal(bytes[4], 0xc0);
  assert.equal(bytes[5], 0x2a);
  assert.equal(readBitfield(bytes, 4, 6, 12), 0x0ab);
  assert.equal(readBitfield(bytes, 4, 0, 6), 0);

  // 有符号位域：4 位全 1 是 -1，无符号读法是 15。
  bytes[8] = 0xf0;
  assert.equal(readBitfield(bytes, 8, 4, 4, true), -1);
  assert.equal(readBitfield(bytes, 8, 4, 4, false), 15);

  // 位域范围越界时抛错。
  assert.throws(() => readBitfield(bytes, 15, 0, 16), /超出这段内存/);
});

test('readField 按布局取值：位域走位域，普通字段走宽度，宽度未知就报错', () => {
  const layout = new KernelLayout(makeLayout());
  const bytes = new Uint8Array(8192);
  bytes[1336] = 0x10; // 第 1336 字节第 4 位 = in_iowait
  const bitfield = layout.field('task_struct', 'flags.in_iowait');
  assert.equal(readField(bytes, bitfield), 1);

  writeLEBig(bytes, 1408, 4321n, 4);
  assert.equal(readField(bytes, layout.field('task_struct', 'pid')), 4321);

  writeLEBig(bytes, 1280, 0xffff888000000000n, 8);
  assert.equal(readField(bytes, layout.field('task_struct', 'mm.mmap_base')), 0xffff888000000000n);

  assert.throws(
    () => readField(bytes, layout.field('task_struct', 'opaque')),
    /类型大小未知/,
  );
  // 数组与复合类型的整数读取请求被拒绝。
  assert.throws(
    () => readField(bytes, layout.field('task_struct', 'comm')),
    /不能当整数读/,
  );
});

test('字段符号性未知时报告错误', () => {
  assert.equal(isSignedTypeName('int'), true);
  assert.equal(isSignedTypeName('const int'), true);
  assert.equal(isSignedTypeName('unsigned int'), false);
  assert.equal(isSignedTypeName('const unsigned long'), false);
  assert.equal(isSignedTypeName('u8'), false);
  assert.equal(isSignedTypeName('struct list_head'), null);
  assert.equal(isSignedTypeName(null), null);
});

test('清单绑定镜像：对不上就抛 LayoutBindingError，并同时报出两边的 build ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 't07a-layout-test-'));
  try {
    const elfPath = join(dir, 'vmlinux');
    writeFileSync(elfPath, makeElf(BUILD_ID));

    const matching = join(dir, 'matching.json');
    writeFileSync(matching, JSON.stringify(makeLayout()));
    const layout = KernelLayout.load(matching, { vmlinux: elfPath });
    assert.equal(layout.buildId, BUILD_ID.toString('hex'));
    assert.equal(layout.linuxRelease, '6.12.112-observatory');
    assert.equal(liveBuildId(elfPath), BUILD_ID.toString('hex'));

    const stale = join(dir, 'stale.json');
    writeFileSync(stale, JSON.stringify(makeLayout({
      source: { ...makeLayout().source, buildId: 'a'.repeat(40) },
    })));
    assert.throws(
      () => KernelLayout.load(stale, { vmlinux: elfPath }),
      (error) => {
        assert.ok(error instanceof LayoutBindingError);
        assert.equal(error.detail.layoutBuildId, 'a'.repeat(40));
        assert.equal(error.detail.liveBuildId, BUILD_ID.toString('hex'));
        return true;
      },
    );

    // build ID 缺失的镜像触发绑定拒绝。
    const noIdPath = join(dir, 'vmlinux-noid');
    writeFileSync(noIdPath, makeElf(Buffer.alloc(0)));
    assert.throws(() => KernelLayout.load(matching, { vmlinux: noIdPath }), LayoutBindingError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实产物能加载并绑定到真实 vmlinux（缺失时跳过）', () => {
  const layoutDir = 'artifacts/layout';
  const vmlinux = 'artifacts/build/linux/vmlinux';
  if (!existsSync(layoutDir) || !existsSync(vmlinux)) {
    return; // 构建产物缺失时跳过此集成检查。
  }
  const files = readdirSync(layoutDir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0, `${layoutDir} 里没有布局清单`);
  const layout = KernelLayout.load(join(layoutDir, files[0]), { vmlinux });

  // 文件名、清单自述、现场镜像三者的 build ID 必须一致。
  assert.equal(layout.buildId, liveBuildId(vmlinux));
  assert.equal(files[0], layoutArtifactName({ linuxRelease: layout.linuxRelease, buildId: layout.buildId }));

  // 偏移真的落在该落的地方：在 7296 字节的 task_struct 里按清单偏移放一个字符串再读回来。
  const comm = layout.field('task_struct', 'comm');
  assert.equal(comm.byteSize, 16);
  const task = new Uint8Array(layout.type('task_struct').byteSize);
  task.set(Buffer.from('lab-read\0'), comm.byteOffset);
  assert.equal(Buffer.from(task.subarray(comm.byteOffset, comm.byteOffset + 8)).toString('latin1'), 'lab-read');

  // 位域：置上它那一位，读出来必须正好是 1 —— 字节偏移与位号都对才做得到。
  const bitfield = layout.field('task_struct', 'in_iowait');
  assert.equal(bitfield.bitSize, 1);
  task[bitfield.byteOffset] |= 1 << (bitfield.bitOffset % 8);
  assert.equal(readField(task, bitfield), 1);

  // 清单记录的镜像大小与现场文件大小逐项相等。
  assert.equal(statSync(vmlinux).size, layout.source.bytes);
});
