"""Synthetic shared corpus: never reads a collector source or a memory store."""
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from memory_review import sanitizer
from memory_review.collectors import CollectorResult, build_observation

FIXTURES = json.loads((Path(__file__).resolve().parents[3] / 'test/fixtures/memory-content-guard.json').read_text())

class GuardParityTests(unittest.TestCase):
    def test_shared_secret_corpus(self):
        for sample in FIXTURES['secret']:
            with self.subTest(name=sample['name']):
                self.assertTrue(sanitizer.contains_secret(sample['text']))
                redacted = sanitizer.redact(sample['text'])
                self.assertIn('[REDACTED]', redacted)
                self.assertFalse(sanitizer.contains_secret(redacted))
                result = CollectorResult(runtime='codex', host='fixture-host')
                build_observation(result, text=sample['text'], trust='authenticated_owner_statement',
                                  session_id='fixture', event_id='fixture', observed_at='2026-10-30T00:00:00Z',
                                  source_ref='fixture.jsonl')
                self.assertEqual(result.observations, [])
                self.assertEqual(result.rejectionCounts, {'secret_like': 1})

    def test_shared_legitimate_corpus(self):
        for text in FIXTURES['safe']:
            with self.subTest(text=text):
                self.assertFalse(sanitizer.contains_secret(text))
                self.assertEqual(sanitizer.redact(text), text)

    def test_valid_joiners_survive_complete_collector_pipeline(self):
        for sample in FIXTURES['unicodeSafe']:
            with self.subTest(name=sample['name']):
                text = sample['text']
                self.assertEqual(sanitizer.strip_invisible(text), (text, False))
                self.assertFalse(sanitizer.has_control_chars(text))
                result = CollectorResult(runtime='codex', host='fixture-host')
                build_observation(result, text=text, trust='authenticated_owner_statement',
                                  session_id='fixture', event_id='fixture', observed_at='2026-10-30T00:00:00Z',
                                  source_ref='fixture.jsonl')
                self.assertEqual(result.rejectionCounts, {})
                self.assertEqual(result.observations[0].text, text)

    def test_unsafe_joiners_and_bidi_remain_detected(self):
        for sample in FIXTURES['unicodeUnsafe']:
            with self.subTest(name=sample['name']):
                self.assertTrue(sanitizer.has_control_chars(sample['text']))
                self.assertTrue(sanitizer.strip_invisible(sample['text'])[1])
