import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from text_policy import validate, planning_instruction
import worker


class TextPolicyTests(unittest.TestCase):
    def setUp(self):
        self.label = {'id': 'title', 'text': 'École 💡', 'placement': 'central plaque'}
        self.policy = {'version': 1, 'enabled': True, 'strategy': 'auto', 'labels': [self.label]}

    def test_plan_contract_reaches_the_real_worker_query_without_inference(self):
        query = worker.query({'action': 'plan', 'request': {'prompt': 'A mechanical scene', 'textPolicy': self.policy}})
        self.assertIn('textPlan', query)
        self.assertIn('Preserve every supplied label id, exact spelling', query)
        self.assertIn('not a second model render', query)
        self.assertIn('École 💡', query)

    def test_disabled_and_exact_constraints_conflict(self):
        disabled = {**self.policy, 'enabled': False, 'labels': []}
        self.assertIn('Do not return textPlan', planning_instruction(disabled))
        with self.assertRaises(ValueError):
            planning_instruction(disabled, {'items': [{'id': 'x', 'kind': 'exact-text', 'text': 'Exact'}]})

    def test_strict_and_unicode_boundaries_match_core(self):
        for changed in [{'version': True}, {'enabled': 1}, {'strategy': 'other'}, {'labels': [self.label, self.label]},
                        {'labels': [{**self.label, 'text': '\ud800'}]}, {'injected': True}]:
            with self.assertRaises(ValueError):
                validate({**self.policy, **changed})
        self.assertEqual(validate({**self.policy, 'labels': [{**self.label, 'text': '😀' * 300}]})['labels'][0]['text'], '😀' * 300)
