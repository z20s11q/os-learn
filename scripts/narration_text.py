"""Spoken forms for technical lessons; the displayed source text is preserved."""
import re

VERSION = 5
DIGITS = dict(zip('0123456789', '零一二三四五六七八九'))
TERMS = {
    'SeaBIOS': 'Sea BIOS', 'BusyBox': 'Busy Box', 'QEMU': 'Q E M U',
    'x86_64': 'x 八十六，六十四位', 'x86-64': 'x 八十六，六十四位',
    'initramfs': 'init ram F S', 'initrd': 'init R D',
    'vmlinux': 'V M Linux', 'bzImage': 'B Z image',
    'kthreadd': 'kernel thread daemon', 'initcalls': 'init calls',
    'initcall': 'init call', 'initmem': 'init memory',
    'iretq': 'interrupt return quadword', 'ljmp': 'long jump',
    'rep movsq': 'repeat move string quadword',
}


def spell(value: str) -> str:
    return ' '.join(DIGITS.get(c, c.upper()) for c in value)


def chinese_number(value: str) -> str:
    if '.' in value:
        whole, fraction = value.split('.', 1)
        return chinese_number(whole) + '点' + ''.join(DIGITS[c] for c in fraction)
    number = int(value)
    if number == 0:
        return '零'
    if number >= 100000000:
        raise ValueError('Number exceeds supported narration range')
    if number >= 10000:
        high, low = divmod(number, 10000)
        return chinese_number(str(high)) + '万' + (('零' if low < 1000 else '') + chinese_number(str(low)) if low else '')
    result, zero = '', False
    for divisor, unit in [(1000, '千'), (100, '百'), (10, '十'), (1, '')]:
        digit, number = divmod(number, divisor)
        if digit:
            if zero:
                result += '零'
            result += ('' if divisor == 10 and digit == 1 and not result else DIGITS[str(digit)]) + unit
            zero = False
        elif result and number:
            zero = True
    return result


def hex_spoken(value: str) -> str:
    # Preserve every hexadecimal position, including leading and repeated zeroes.
    return '，'.join(DIGITS.get(digit, digit) for digit in value.upper())


def spoken_text(text: str) -> str:
    text = re.sub(r'<[^>]+>', '', text).strip()
    # Avoid ambiguous 行(xing/hang) in narration; keep the on-screen line intact.
    text = text.replace('每一行', '每条代码').replace('一行代码', '一条代码').replace('一行就是', '一条就是')
    text = text.replace('逐行', '逐条代码').replace('每行代码', '每条代码')
    # Long mode also includes compatibility mode; do not rename it "64-bit mode".
    text = text.replace('长模式', 'long mode').replace('重定位', '重新定位')
    text = re.sub(r'0[xX]([0-9a-fA-F]+)', lambda m: hex_spoken(m[1]), text)
    # Hex byte sequences and segment offsets do not have a 0x prefix in the source.
    text = re.sub(r'\b(DS|CS|SS|ES):([0-9a-fA-F]+)\b',
                  lambda m: m[1] + ' 段的偏移 ' + hex_spoken(m[2]), text)
    text = re.sub(r'(?<![A-Za-z0-9_/])([0-9A-Fa-f]{2}(?:\s+[0-9A-Fa-f]{2})+)(?![A-Za-z0-9_])',
                  lambda m: '，'.join(hex_spoken(byte) for byte in m[1].split()), text)
    text = re.sub(r'(?<![A-Za-z0-9_/])(?=[0-9A-F]*[A-F])([0-9A-F]{4,})(?![A-Za-z0-9_])',
                  lambda m: hex_spoken(m[1]), text)
    text = re.sub(r'(?<![A-Za-z0-9_/])([0-9A-F]{2})(?![A-Za-z0-9_])',
                  lambda m: hex_spoken(m[1]) if re.search(r'[A-F]', m[1]) else m[1], text)
    units = {'KB': '千字节', 'MB': '兆字节', 'GB': '吉字节',
             'KiB': '二进制千字节', 'MiB': '二进制兆字节', 'GiB': '二进制吉字节'}
    text = re.sub(r'(?<![A-Za-z0-9_])(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|KB|MB|GB)\b',
                  lambda m: chinese_number(m[1]) + units[m[2]], text)
    text = re.sub(r'(?<![A-Za-z0-9_/])(\d+(?:\.\d+)?)(?![A-Za-z0-9_])',
                  lambda m: chinese_number(m[1]), text)
    for term, spoken in sorted(TERMS.items(), key=lambda item: -len(item[0])):
        text = re.sub(r'(?<![A-Za-z0-9_])' + re.escape(term) + r'(?![A-Za-z0-9_])', spoken, text)
    text = re.sub(r'(?<![A-Za-z0-9_])((?:CR[0348]|EFER|[RE]FLAGS))\.([A-Z0-9]+)',
                  lambda m: spell(m[1]) + ' 的 ' + spell(m[2]) + ' 标志', text)
    # Split snake_case and camelCase identifiers into pronounceable English words.
    text = re.sub(r'(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])', ' ', text)
    text = re.sub(r'([a-z])([A-Z])', r'\1 \2', text)
    text = re.sub(r'(?<![A-Za-z0-9])([A-Z]{2,}[0-9]*)(?![A-Za-z0-9])', lambda m: spell(m[1]), text)
    # These are known hardware/code identifiers, not decimal quantities or paths.
    text = re.sub(r'(?<![A-Za-z0-9_/])(R|A|e|ext)(\d+)(?![A-Za-z0-9_])',
                  lambda m: m[1] + ' ' + chinese_number(m[2]), text)
    text = re.sub(r'(?<![A-Za-z0-9_/])(startup|x)\s*(\d+)(?![A-Za-z0-9_])',
                  lambda m: m[1] + ' ' + chinese_number(m[2]), text)
    text = re.sub(r'(?<=八十六 )64(?= start kernel)', '六十四', text)
    text = text.replace('→', '，到').replace('×', '乘以').replace('=', '等于')
    text = text.replace('……', '，等等。').replace('`', '').replace('“', '').replace('”', '')
    text = re.sub(r'\s+', ' ', text).strip()
    text = re.sub(r'[，,；;：:]\s*$', '。', text)
    return text if text[-1:] in '。！？.!?' else text + '。'
