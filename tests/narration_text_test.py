"""Regression cases for technical narration (run with Python unittest)."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from narration_text import spoken_text


class PronunciationTests(unittest.TestCase):
    def test_code_line_does_not_change_execution(self):
        result = spoken_text('执行这一行代码，下一行就是当前指令。')
        self.assertEqual(result, '执行这一条代码，下一条就是当前指令。')

    def test_hex_preserves_leading_zeroes_and_letter_digits(self):
        self.assertEqual(spoken_text('从0x00Af取指'), '从零，零，A，F取指。')

    def test_register_bit_and_identifier(self):
        self.assertEqual(spoken_text('CR0.PG 置位后，调用 start_kernel。'),
                         'C R 零 的 P G 标志 置位后，调用 start kernel。')

    def test_english_words_are_kept_whole(self):
        self.assertEqual(spoken_text('Linux kernel starts BusyBox shell。'),
                         'Linux kernel starts Busy Box shell。')

    def test_mode_and_relocation(self):
        self.assertEqual(spoken_text('进入长模式后重定位。'), '进入long mode后重新定位。')

    def test_decimal_and_units(self):
        self.assertEqual(spoken_text('65535，512 MB，6.2 MB，64 KB，1 GB。'),
                         '六万五千五百三十五，五百一十二兆字节，六点二兆字节，六十四千字节，一吉字节。')

    def test_repeated_hex_digits_keep_exact_count(self):
        self.assertEqual(spoken_text('0x10000 和 0xFFFFFFF0'),
                         '一，零，零，零，零 和 F，F，F，F，F，F，F，零。')

    def test_unprefixed_bytes_and_offsets(self):
        self.assertEqual(spoken_text('B8 00 20，DS:0012'),
                         'B，八，零，零，二，零，D S 段的偏移 零，零，一，二。')

    def test_hex_is_digitwise_but_decimal_is_cardinal(self):
        self.assertEqual(spoken_text('地址 0x0123，数量 123。'),
                         '地址 零，一，二，三，数量 一百二十三。')

    def test_hex_has_no_spoken_prefix(self):
        result = spoken_text('0x10000、0X00af、B8 00 20。')
        self.assertNotIn('零 x', result)
        self.assertNotIn('十六进制', result)
        self.assertNotIn('0x', result.lower())

    def test_known_identifier_numbers_have_explicit_readings(self):
        self.assertEqual(spoken_text('startup_32，R15，A20，e820，ext2，B8。'),
                         'startup 三十二，R 十五，A 二十，e 八百二十，ext 二，B，八。')
        self.assertEqual(spoken_text('x86_64_start_kernel。'), 'x 八十六 六十四 start kernel。')

    def test_paths_keep_literal_numeric_names(self):
        self.assertIn('/sys/ext2', spoken_text('访问 /sys/ext2。'))


if __name__ == '__main__':
    unittest.main()
