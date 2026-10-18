export function memoryOverview(ramBytes) {
  if (!Number.isSafeInteger(ramBytes) || ramBytes <= 0) throw new RangeError('Invalid RAM size');
  const cellBytes = 1024 * 1024;
  return { start: 0, end: ramBytes, cellBytes, count: Math.ceil(ramBytes / cellBytes) };
}

// PG=0 makes the recorded linear PC a physical fetch address, not a CR3 guess.
export function physicalSamples(frame) {
  if (!frame) return [];
  return (frame.memory || []).filter(item => item.coverage !== 'read-failed' && typeof (item.bytes || item.hex) === 'string'
    && (item.addressSpace === 'physical' || (item.addressSpace === 'linear' && item.label === 'pc'
      && (BigInt(frame.cpu.control.cr0) & (1n << 31n)) === 0n)));
}

export function memoryCell(viewport, index, samples = [], deltas = []) {
  const start = viewport.start + index * viewport.cellBytes;
  const end = Math.min(start + viewport.cellBytes, viewport.end);
  const windows = samples.filter(item => Number(BigInt(item.address)) < end
    && Number(BigInt(item.address)) + (item.bytes || item.hex).length / 2 > start);
  const item = windows.find(item => Number(BigInt(item.address)) <= start
    && Number(BigInt(item.address)) + (item.bytes || item.hex).length / 2 >= end);
  const value = viewport.cellBytes === 1 && item
    ? (item.bytes || item.hex).slice((start - Number(BigInt(item.address))) * 2, (start - Number(BigInt(item.address))) * 2 + 2) : null;
  const changed = deltas.some(window => window.addressSpace === 'physical'
    && window.changedOffsets.some(offset => Number(BigInt(window.address)) + offset >= start
      && Number(BigInt(window.address)) + offset < end));
  return { start, end, windows, value, changed };
}
