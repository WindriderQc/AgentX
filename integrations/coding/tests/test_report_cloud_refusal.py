import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('refusal_steps', Path(__file__).resolve().parents[1] / 'coding_report_steps.py')
steps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(steps)


class CloudRefusalTest(unittest.TestCase):
    def setUp(self):
        self.row = {'escalated': True, 'requestId': 'old', 'step': 7,
                    'documents': ['docs/example.md'], 'result': 'failed', 'model': 'provider/model',
                    'executionState': 'unknown', 'uncertain': True,
                    'attempts': [{'model': 'provider/model', 'code': 'OPENCLAW_NATIVE_MODEL_FAILED'}]}
        self.proof = {'requestId': 'old', 'step': 7, 'model': 'provider/model',
                      'evidenceSha256': 'a' * 64, 'executionState': 'not-dispatched'}

    def blocked(self, proof, request='new'):
        return steps.escalation_blocks(self.row, ['docs/example.md'], None, request, [proof])

    def test_received_refusal_allows_only_a_new_execution_and_preserves_history(self):
        original = copy.deepcopy(self.row)
        self.assertTrue(steps.escalation_blocks(self.row, ['docs/example.md'], None, 'new'))
        self.assertFalse(self.blocked(self.proof))
        self.assertTrue(self.blocked(self.proof, 'old'))
        self.assertEqual(self.row, original)

    def test_mismatched_or_uncertain_proof_never_allows_retry(self):
        for key, value in [('requestId', 'other'), ('step', 8), ('model', 'provider/other'),
                           ('evidenceSha256', ''), ('executionState', 'unknown')]:
            with self.subTest(field=key):
                self.assertTrue(self.blocked(dict(self.proof, **{key: value})))

    def test_an_answer_is_not_turned_into_a_refusal(self):
        self.row['result'] = 'done'
        self.assertTrue(self.blocked(self.proof))
