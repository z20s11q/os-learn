/** 展示用格式化纯函数。 */

/** 提取大小写十六进制字符，按每 2 字符切分为字节数组。 */
export function bytesOf(hex: string): string[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out: string[] = [];
  for (let index = 0; index < clean.length; index += 2) {
    out.push(clean.slice(index, index + 2));
  }
  return out;
}

/** 十六进制转 ASCII：可打印字符保留，其余字符显示为点。 */
export function asciiOf(bytes: string[]): string {
  return bytes
    .map((byte) => {
      const value = Number.parseInt(byte, 16);
      return value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : '.';
    })
    .join('');
}

/**
 * 生成 hexdump：地址 + 按 bytesPerLine 分行的字节 + ASCII。
 * @param baseAddress 起始地址（十六进制字符串）
 * @param hex 连续十六进制字节
 */
export function hexDump(baseAddress: string, hex: string, bytesPerLine = 16): string {
  const bytes = bytesOf(hex);
  const width = Math.max(1, Math.min(64, Math.trunc(bytesPerLine)));
  let base: bigint;
  try {
    base = BigInt(baseAddress);
  } catch {
    base = 0n;
  }
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += width) {
    const row = bytes.slice(offset, offset + width);
    const address = (base + BigInt(offset)).toString(16).padStart(16, '0');
    const hexPart = row.map((byte) => byte.padStart(2, '0')).join(' ').padEnd(width * 3 - 1, ' ');
    lines.push(`${address}  ${hexPart}  |${asciiOf(row)}|`);
  }
  return lines.join('\n');
}

/** base64 解码为字节十六进制数组（用于内存读取结果）。 */
export function base64ToBytes(base64: string): string[] {
  try {
    const binary = atob(base64);
    const out: string[] = [];
    for (let index = 0; index < binary.length; index += 1) {
      out.push(binary.charCodeAt(index).toString(16).padStart(2, '0'));
    }
    return out;
  } catch {
    return [];
  }
}

/** 按 BigInt 整数语法解析输入，规范为带 0x 前缀的十六进制地址。 */
export function normalizeAddress(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  try {
    return `0x${BigInt(trimmed).toString(16)}`;
  } catch {
    return null;
  }
}

/** 大整数比较（字符串形式），用于寄存器变化高亮。 */
export function sameValue(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

export function timeOf(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
}
