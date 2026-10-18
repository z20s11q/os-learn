"""Fish API contract checks; no network or real credentials are used."""
from io import BytesIO
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

import numpy as np
import requests
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from fish_client import FishClient, REFERENCE_ID


class FishClientTests(unittest.TestCase):
    def setUp(self):
        self.session = Mock()
        self.client = FishClient(api_key='test-secret', session=self.session)

    def test_exact_voice_native_speed_and_free_model(self):
        buffer = BytesIO()
        sf.write(buffer, np.zeros(24000, dtype='float32'), 24000, format='WAV')
        self.session.post.return_value = Mock(status_code=200, content=buffer.getvalue())
        wav, rate = self.client.synthesize('一条代码。Linux kernel starts a shell.')
        self.assertEqual((len(wav), rate), (24000, 24000))
        args, kwargs = self.session.post.call_args
        self.assertEqual(args, ('https://api.fish.audio/v1/tts',))
        self.assertEqual(kwargs['headers']['model'], 's2.1-pro-free')
        self.assertEqual(kwargs['headers']['Authorization'], 'Bearer test-secret')
        self.assertEqual(kwargs['json']['reference_id'], REFERENCE_ID)
        self.assertEqual(kwargs['json']['prosody']['speed'], 1)
        self.assertFalse(kwargs['allow_redirects'])

    def test_access_errors_stop_without_fallback_or_secret_output(self):
        for status in (301, 401, 402, 403, 429, 503):
            with self.subTest(status=status):
                self.session.reset_mock()
                self.session.post.return_value = Mock(status_code=status, content=b'test-secret')
                with self.assertRaises(RuntimeError) as caught:
                    self.client.synthesize('测试。')
                self.assertIn(str(status), str(caught.exception))
                self.assertNotIn('test-secret', str(caught.exception))
                self.session.post.assert_called_once()

    def test_connection_failure_is_not_automatically_retried(self):
        self.session.post.side_effect = requests.Timeout('test-secret')
        with self.assertRaises(RuntimeError) as caught:
            self.client.synthesize('测试。')
        self.assertNotIn('test-secret', str(caught.exception))
        self.session.post.assert_called_once()

    def test_invalid_success_response_is_rejected(self):
        self.session.post.return_value = Mock(status_code=200, content=b'{"error":"test-secret"}')
        with self.assertRaisesRegex(RuntimeError, 'invalid WAV'):
            self.client.synthesize('测试。')

    def test_credentials_are_required(self):
        with patch.dict('os.environ', {}, clear=True):
            with self.assertRaisesRegex(ValueError, 'FISH_API_KEY'):
                FishClient()

    def test_invalid_model_or_voice_is_rejected(self):
        for kwargs in ({'model': 'unknown'}, {'reference_id': '../voice'}):
            with self.assertRaises(ValueError):
                FishClient(api_key='test-secret', **kwargs)


if __name__ == '__main__':
    unittest.main()
