import sys
from pathlib import Path
import unittest
import json
import subprocess

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from text_policy import validate, planning_instruction, budget_instruction
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

    def test_core_budget_reaches_worker_instructions_with_no_fixed_reserve(self):
        root = Path(__file__).resolve().parents[3]
        code = "const p=require('./core/public/js/image-text-policy');const input=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(p.planningBudget(undefined,input)))"
        result = subprocess.run(['node', '-e', code, json.dumps(self.policy)], cwd=root, capture_output=True, text=True, check=True)
        budget = json.loads(result.stdout)
        query = worker.query({'action': 'plan', 'request': {'prompt': 'A scene', 'textPolicy': self.policy, 'renderBudget': budget}})
        self.assertIn(str(budget['descriptionLimits']), query)
        self.assertIn('effective maximum for your visual description is ' + str(max(budget['descriptionLimits'].values())), query)
        self.assertIn('Added labels or longer placements consume additional units', query)
        self.assertIn('Replace annotated-infographic cues', query)

    def test_invalid_budget_refuses_before_execution(self):
        good = {'version': 1, 'limit': 8000, 'descriptionLimits': {'no-text': 7560}, 'labelsMayChange': False}
        for changed in [{'version': True}, {'limit': 32000}, {'descriptionLimits': {'no-text': True}},
                        {'descriptionLimits': {'no-text': -1}}, {'descriptionLimits': {'other': 8000}}, {'injected': True}]:
            with self.assertRaises(ValueError):
                budget_instruction({**good, **changed})
