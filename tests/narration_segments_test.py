"""Short FireRed inputs preserve source coverage and code identifiers."""
from pathlib import Path
import json
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from narration_segments import bounded_sentences
from narration_text import spoken_text


class SegmentTests(unittest.TestCase):
    def check_parts(self, text, limit):
        parts = list(bounded_sentences(text, limit))
        self.assertEqual(''.join(raw for _, _, raw in parts), text)
        for start, end, raw in parts:
            self.assertEqual(raw, text[start:end])
            self.assertLessEqual(len(spoken_text(raw)), limit)
        return parts

    def test_complete_sentences(self):
        self.assertEqual([raw for _, _, raw in self.check_parts('内核启动。等待键盘。', 80)],
                         ['内核启动。', '等待键盘。'])

    def test_expanded_hex_is_bounded(self):
        text = 'CS 为 0xf000，隐藏基址为 0xffff0000，IP 为 0xfff0，取指地址为 0xfffffff0。'
        parts = self.check_parts(text, 60)
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(raw.endswith(('，', '。')) for _, _, raw in parts))

    def test_register_dot_and_english_sentence(self):
        parts = self.check_parts('CR0.PG 控制分页。The kernel starts a shell. 输入 read。', 80)
        self.assertEqual(len(parts), 3)
        self.assertIn('CR0.PG', parts[0][2])

    def test_identifiers_not_split(self):
        parts = self.check_parts('初始化内核，接着调用 x86_64_start_reservations，再等待输入。', 40)
        self.assertTrue(any('x86_64_start_reservations' in raw for _, _, raw in parts))

    def test_chinese_without_punctuation(self):
        self.assertGreater(len(self.check_parts('初始化内核' * 20, 30)), 1)

    def test_indivisible_term_fails(self):
        with self.assertRaises(ValueError):
            list(bounded_sentences('x' * 100, 30))

    def test_empty_text(self):
        self.assertEqual(list(bounded_sentences('')), [])

    def test_raw_text_preserves_numeric_literals(self):
        text = '16 位，65535，64 KB。地址 0x10000，字节 B8 00 20。'
        parts = list(bounded_sentences(text, 40, transform=lambda raw: raw))
        self.assertEqual(''.join(raw for _, _, raw in parts), text)
        self.assertTrue(any('0x10000' in raw and 'B8 00 20' in raw for _, _, raw in parts))
        self.assertTrue(all(len(raw) <= 40 for _, _, raw in parts))

    def test_invalid_limit(self):
        with self.assertRaises(ValueError):
            list(bounded_sentences('内核。', 0))

    def test_all_exported_lessons_are_bounded_and_complete(self):
        root = Path(__file__).resolve().parents[1]
        subprocess.run(['node', 'scripts/export-narration.mjs', 'all'], cwd=root,
                       check=True, capture_output=True)
        for bundle in ('boot', 'panorama'):
            entries = json.loads((root / f'tmp/{bundle}-narration.json').read_text(encoding='utf-8'))
            for entry in entries:
                with self.subTest(bundle=bundle, id=entry['id']):
                    self.check_parts(entry['text'], 80)


if __name__ == '__main__':
    unittest.main()
