/** Read-only CPU state from one stopped VM. Never parse x87 as a JS number. */
export const EXTENDED_REGISTER_WIDTHS = Object.freeze({
  dr0: 64, dr1: 64, dr2: 64, dr3: 64, dr6: 64, dr7: 64,
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`st${i}`, 80])),
  ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`xmm${i}`, 128])),
  fcw: 16, fsw: 16, ftw: 16, ftwAbridged: 8, mxcsr: 32,
  fsBase: 64, gsBase: 64, kernelGsBase: 64,
  star: 64, lstar: 64, sfmask: 64, tsc: 64,
});

/** Exact integer bit pattern, padded to its architectural width; no truncation. */
export function registerBits(raw, width, { vector = false } = {}) {
  if (typeof raw !== 'string') return null;
  const scalar = /^0x[\da-f]+$/i.test(raw.trim()) ? raw.trim() : null;
  const token = scalar ?? (vector ? /\buint128\s*=\s*(0x[\da-f]+)\b/i.exec(raw)?.[1] : null);
  if (token === null) return null;
  const value = BigInt(token);
  if (value >= (1n << BigInt(width))) return null;
  return `0x${value.toString(16).padStart(Math.ceil(width / 4), '0')}`;
}

/**
 * QEMU 8.2 target/i386/cpu-dump.c prints FPR physical slots as low64 high16.
 * FTW is the 8-bit occupancy bitmap, not the classic 16-bit x87 tag word.
 */
export function parseQemuRegisterDump(text) {
  const out = new Map();
  if (typeof text !== 'string') return out;
  for (const match of text.matchAll(/\b(DR[0-3]|DR6|DR7|FCW|FSW|FTW|MXCSR)=([\da-f]+)\b/gi)) {
    const name = match[1].toLowerCase() === 'ftw' ? 'ftwAbridged' : match[1].toLowerCase();
    out.set(name, { raw: match[0], value: registerBits(`0x${match[2]}`, EXTENDED_REGISTER_WIDTHS[name]) });
  }
  const fsw = out.get('fsw')?.value;
  if (fsw !== null && fsw !== undefined) {
    const top = Number((BigInt(fsw) >> 11n) & 7n);
    for (const match of text.matchAll(/\bFPR([0-7])=([\da-f]{16})\s+([\da-f]{4})\b/gi)) {
      const physicalSlot = Number(match[1]);
      const logicalSlot = (physicalSlot - top + 8) % 8;
      out.set(`st${logicalSlot}`, {
        raw: match[0], value: registerBits(`0x${match[3]}${match[2]}`, 80),
        encoding: `x87 binary80; physical FPR${physicalSlot}; logical ST(${logicalSlot})=(physical-TOP)&7; TOP=${top}`,
      });
    }
  }
  for (const match of text.matchAll(/\bXMM(\d{2})=([\da-f]{16})\s+([\da-f]{16})\b/gi)) {
    const name = `xmm${Number(match[1])}`;
    if (EXTENDED_REGISTER_WIDTHS[name]) out.set(name, { raw: match[0], value: registerBits(`0x${match[2]}${match[3]}`, 128) });
  }
  return out;
}

/** LMA activates IA-32e; CS.L and CS.D determine its current code submode. */
export function decodeCpuExecutionMode({ cr0, efer, csAttributes, eflags = null }) {
  const parse = (value) => {
    try { return value === null || value === undefined ? null : BigInt(value); } catch { return null; }
  };
  const control = parse(cr0), extended = parse(efer), attributes = parse(csAttributes), flags = parse(eflags);
  if (control === null) return { mode: 'unknown', modeDetail: 'unknown', reason: 'CR0 unavailable' };
  if ((control & 1n) === 0n) return { mode: 'real-16', modeDetail: 'real-16' };
  if (extended !== null && (extended & 0x400n) !== 0n) {
    if (attributes === null) return { mode: 'unknown', modeDetail: 'long-submode-unknown', reason: 'EFER.LMA=1 but CS attributes unavailable' };
    if ((attributes & 0x200000n) !== 0n) return { mode: 'long-64', modeDetail: 'long-64' };
    const mode = (attributes & 0x400000n) !== 0n ? 'protected-32' : 'protected-16';
    return { mode, modeDetail: mode === 'protected-32' ? 'long-compat-32' : 'long-compat-16' };
  }
  if (flags !== null && (flags & 0x20000n) !== 0n) return { mode: 'protected-16', modeDetail: 'vm86' };
  if (extended === null || attributes === null) return { mode: 'unknown', modeDetail: 'unknown', reason: 'EFER or CS attributes unavailable' };
  const mode = (attributes & 0x400000n) !== 0n ? 'protected-32' : 'protected-16';
  return { mode, modeDetail: mode };
}

/**
 * Read binary80 from QEMU, not GDB's formatted long double. Both MI x and MI r
 * convert ST(0)=2.0 to integer 0x2 in the pinned GDB; neither preserves its bits.
 */
export async function collectExtendedCpu({ qmp, byName, observer, cpuId = 0, captureId }) {
  let hmpText = null, hmpError = null, barrierError = null;
  try {
    if ((await qmp.queryStatus()).running !== false) throw new Error('VM is not stopped');
    try { hmpText = await qmp.hmp(`info registers ${cpuId}`); } catch (error) { hmpError = error.message; }
    if ((await qmp.queryStatus()).running !== false) throw new Error('VM resumed during extended register reads');
  } catch (error) { barrierError = error.message; }

  const hmp = parseQemuRegisterDump(hmpText);
  const aliases = { fsBase: 'fs_base', gsBase: 'gs_base', kernelGsBase: 'k_gs_base', fcw: 'fctrl', fsw: 'fstat' };
  const observed = observer?.cpus?.find((cpu) => cpu.cpuId === cpuId) ?? null;
  const registers = Object.entries(EXTENDED_REGISTER_WIDTHS).map(([name, width]) => {
    const entry = { name, width, value: null, raw: null, source: null, captureId };
    if (barrierError) return { ...entry, reason: `stop-barrier-unverified: ${barrierError}` };
    if (name === 'ftw') return { ...entry, reason: 'Classic 16-bit x87 FTW is unavailable: QEMU HMP exposes an 8-bit abridged occupancy bitmap; GDB ftag is a hard-coded zero in this QEMU version. See ftwAbridged.' };
    if (hmp.get(name)?.value !== null && hmp.has(name)) {
      Object.assign(entry, hmp.get(name), { source: `qmp:human-monitor-command info registers ${cpuId}` });
      if (name === 'ftwAbridged') entry.encoding = 'FXSAVE-style abridged FTW: bit i=1 means physical FPR(i) nonempty';
    } else if (/^st\d$/.test(name)) {
      return { ...entry, reason: 'QMP binary80 FPR or FSW.TOP unavailable. GDB MI x/r cast long double to integers and are deliberately not used as raw x87 evidence.' };
    } else {
      const gdbName = aliases[name] ?? name;
      const gdbRaw = byName.get(gdbName);
      if (gdbRaw !== undefined) {
        entry.raw = gdbRaw;
        entry.value = registerBits(gdbRaw, width, { vector: /^xmm\d+$/.test(name) });
        entry.source = 'gdb-mi:-data-list-register-values x';
      } else if ((name === 'fsBase' || name === 'gsBase') && observed) {
        entry.raw = observed[name === 'fsBase' ? 'fs' : 'gs']?.base ?? null;
        entry.value = registerBits(entry.raw, width);
        entry.source = 'qmp:x-oslab-capture segment hidden base';
      }
    }
    if (entry.value === null) entry.reason = entry.raw !== null
      ? 'Register raw format is unsupported or does not fit the declared width; no value was invented.'
      : `Register unavailable in this target's GDB description and QMP register dump.${hmpError ? ` HMP: ${hmpError}` : ''}`;
    return entry;
  });
  return {
    schema: 'oslab.cpu.extended/1', captureId, observerCaptureId: observer?.captureId ?? null,
    cpuId, barrier: barrierError === null ? 'vm-stopped-before-and-after-read' : 'unverified',
    registers, rawQmpRegisters: hmpText, errors: [barrierError, hmpError].filter(Boolean),
    note: 'All reads share this stopped VM interval. HMP is a version-dependent supplementary interface; raw text is retained. Null means unavailable, never zero.',
  };
}
