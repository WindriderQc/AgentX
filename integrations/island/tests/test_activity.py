"""Large image tool results must not hide real model activity or fake it."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import session_activity as activity


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / 'session.jsonl'
        activity._selected, activity._cache = None, None

    def tearDown(self): self.temp.cleanup()

    def row(self, *, kind='function_call', stamp='2026-01-01T00:00:00Z'):
        return json.dumps({'type': 'response_item', 'timestamp': stamp,
                           'payload': {'type': kind, 'role': 'assistant', 'name': 'view_image'}}) + '\n'

    def observe(self, now=1767225630):
        with patch.object(activity.time, 'time', return_value=now):
            return activity.latest_activity(self.root)

    def test_megabyte_image_preserves_preceding_model_activity(self):
        self.path.write_text(self.row() + json.dumps({'type': 'response_item', 'payload': {
            'type': 'function_call_output', 'output': 'synthetic-image-bytes-' * 100000}}) + '\n')
        d = self.observe()
        self.assertTrue(d['modelActivity'])
        self.assertEqual(d['age'], 30)
        self.assertLessEqual(len(activity._cache['buffer']), activity.MAX_RECORD)
        self.assertLess(len(json.dumps(activity._cache['payload'])), 1000)

    def test_partial_large_image_does_not_refresh_or_erase_activity(self):
        self.path.write_text(self.row())
        self.assertEqual(self.observe()['age'], 30)
        with self.path.open('a') as f:
            f.write('{"type":"response_item","payload":{"type":"function_call_output","output":"')
            f.write('x' * 200000)
        self.assertEqual(self.observe(now=1767225640)['age'], 40)
        with self.path.open('a') as f:
            f.write('x' * 200000 + '"}}\n')
            f.write(self.row(stamp='2026-01-01T00:00:45Z'))
        self.assertEqual(self.observe(now=1767225650)['age'], 5)

    def test_appended_error_traffic_never_refreshes_an_older_model_timestamp(self):
        row = json.loads(self.row()); row.pop('timestamp')
        self.path.write_text(json.dumps(row) + '\n'); os.utime(self.path, (1000, 1000))
        self.assertEqual(self.observe(now=1200)['age'], 200)
        with self.path.open('a') as f: f.write('{"type":"event_msg","payload":{"type":"error"}}\n')
        os.utime(self.path, (1100, 1100))
        self.assertEqual(self.observe(now=1200)['age'], 200)

    def test_new_session_cannot_inherit_previous_session_activity(self):
        self.path.write_text(self.row()); self.assertTrue(self.observe()['modelActivity'])
        newer = self.root / 'next.jsonl'; newer.write_text('{"type":"session_meta","payload":{}}\n')
        os.utime(newer, (2000000000, 2000000000))
        self.assertFalse(self.observe()['modelActivity'])

    def test_rotation_and_truncation_invalidate_cached_activity(self):
        self.path.write_text(self.row()); self.assertTrue(self.observe()['modelActivity'])
        self.path.write_text('{}\n'); self.assertFalse(self.observe()['modelActivity'])
        self.path.unlink(); self.path.write_text(self.row(kind='custom_tool_call'))
        self.assertTrue(self.observe()['modelActivity'])

    def test_unfinished_or_invalid_rows_do_not_prove_activity(self):
        self.path.write_bytes(b'\xff\n' + self.row().encode()[:-1])
        self.assertFalse(self.observe()['modelActivity'])
        with self.path.open('ab') as f: f.write(b'\n')
        self.assertTrue(self.observe()['modelActivity'])

    def test_symlinks_and_fifos_are_not_session_evidence(self):
        other = self.root / 'not-a-session'; other.write_text(self.row())
        self.path.symlink_to(other)
        self.assertIsNone(self.observe())
        self.path.unlink(); os.mkfifo(self.path)
        self.assertIsNone(self.observe())


if __name__ == '__main__': unittest.main()
