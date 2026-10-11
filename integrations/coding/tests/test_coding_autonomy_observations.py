import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

HERE = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
github = load('coding_github')
progress = load('coding_progress')
HEAD = 'a' * 40
EXPECTED = {'branch': 'agentx/coding-task-0001', 'base': 'main', 'number': 1}

class ObservationTest(unittest.TestCase):
    def request(self, checks):
        return Mock(side_effect=[{'head': {'ref': EXPECTED['branch'], 'sha': HEAD, 'repo': {'full_name': 'example/project'}},
                                 'base': {'ref': 'main', 'sha': 'b' * 40}, 'state': 'open', 'mergeable': True},
                                {'check_runs': checks}])

    def test_ci_receipts_pin_exact_head_and_preserve_cancel_timeout_and_skipped(self):
        checks = [{'id': i, 'name': name, 'head_sha': HEAD, 'conclusion': outcome}
                  for i, (name, outcome) in enumerate([('test', 'cancelled'), ('other', 'timed_out'), ('skip', 'skipped')])]
        call = self.request(checks)
        result = github.observe(call, 'example/project', '0001', EXPECTED, 'synthetic-token')
        self.assertEqual(result['head'], HEAD)
        self.assertEqual({v['state'] for v in result['checks']}, {'cancelled', 'timeout', 'not_executed'})
        self.assertIn(f'/commits/{HEAD}/check-runs', call.call_args.args[0])

    def test_latest_rerun_replaces_older_verdict_but_does_not_rewrite_its_sha(self):
        call = self.request([{'id': 1, 'name': 'test', 'head_sha': HEAD, 'conclusion': 'success'},
                             {'id': 2, 'name': 'test', 'head_sha': 'c' * 40, 'conclusion': None}])
        result = github.observe(call, 'example/project', '0001', EXPECTED, 'synthetic-token')
        self.assertEqual(result['checks'], [{'name': 'test', 'head': 'c' * 40, 'state': 'pending', 'diagnostics': [], 'coverage': 'execution coverage unverified', 'url': None}])

    def test_foreign_or_sensitive_task_is_refused_before_network(self):
        call = Mock()
        with self.assertRaises(RuntimeError): github.observe(call, 'example/project', '0909', EXPECTED, '')
        call.assert_not_called()

    def test_retries_carry_model_test_work_and_useful_progress_budgets(self):
        now = [0]
        p = progress.Progress('0001', now=lambda: now[0])
        p.carry({'remaining': {'workSeconds': 100, 'testSeconds': 10, 'modelSeconds': 10, 'modelCalls': 2},
                 'limits': {'noProgressSeconds': 100}, 'spent': {'workSeconds': 50}, 'lastUsefulWorkSeconds': 35})
        p.phase = 'running'
        p.set_stage('model_wait'); now[0] = 6; p.tick()
        p.set_stage('tool'); now[0] = 7; p.tick()
        p.set_stage('model_generation'); now[0] = 12
        self.assertEqual(p.tick(), 'hard_budget')  # 11 model seconds across two stages.
        self.assertEqual(p.usage()['modelSeconds'], 11)
        q = progress.Progress('0001', now=lambda: now[0])
        q.carry({'remaining': {'workSeconds': 100, 'testSeconds': 20, 'modelSeconds': 100, 'modelCalls': 2},
                 'limits': {'noProgressSeconds': 20}, 'spent': {'workSeconds': 50}, 'lastUsefulWorkSeconds': 20})
        q.phase = 'running'
        self.assertEqual(q.tick(), 'no_useful_progress')

    def test_identical_source_and_test_fingerprints_survive_resume(self):
        p = progress.Progress('0001')
        fingerprint = 'f' * 64
        p.carry({'remaining': {'workSeconds': 100, 'testSeconds': 10, 'modelSeconds': 10, 'modelCalls': 2},
                 'limits': {'noProgressSeconds': 20}, 'seenStates': [fingerprint], 'seenTests': [fingerprint]})
        self.assertIn(fingerprint, p.seen_states)
        self.assertIn(fingerprint, p.seen_tests)


class CoverageTest(unittest.TestCase):
    def test_green_check_discloses_skipped_verification_steps(self):
        call = Mock(return_value={'steps': [{'name': 'Run npm test -- --runInBand', 'conclusion': 'skipped'},
                                          {'name': 'Set up job', 'conclusion': 'success'}]})
        coverage = github.check_coverage(call, 'https://api.github.com/repos/synthetic/project',
                    {'details_url': 'https://github.com/synthetic/project/actions/runs/1/job/2'}, 'synthetic')
        self.assertEqual(coverage, '0 verification steps succeeded; 1 skipped/out of scope; 0 pending/failed')

    def test_failure_annotation_is_bounded_data_and_credentials_are_redacted(self):
        call = Mock(return_value=[{'path': 'source.py', 'start_line': 12, 'message': 'AssertionError: expected 2; token=private-fixture'}])
        detail = github.diagnostics(call, 'https://api.github.com/repos/synthetic/project',
                    {'id': 7, 'output': {'annotations_count': 1, 'summary': 'Synthetic test failure'}}, 'synthetic')
        self.assertIn('source.py:12:', detail[1]); self.assertIn('token=[redacted]', detail[1])
        self.assertNotIn('private-fixture', str(detail))
