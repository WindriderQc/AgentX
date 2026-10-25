"""CPU-only end-to-end correction from a native rejected-step receipt."""
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('feedback_run_fixtures', Path(__file__).with_name('test_coding_autonomous_run.py'))
fixtures = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixtures)
autonomous, runner, git = fixtures.autonomous, fixtures.runner, fixtures.git
KEY, NEXT_KEY = fixtures.KEY, fixtures.NEXT_KEY


class LocalTestFeedbackTest(unittest.TestCase):
    def scenario(self, variant='success'):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, calls, _ = fixtures.RunnerOwnedCodeStepTest().fixture(directory)
            manifest = r.request('/manifest')['data']
            task = r.request('/worker')['data']['task']
            original_request, original_worker = r.request, r.run_worker
            second = [False]
            correction_turns = []
            clock = [0.0]
            total = dict(manifest['remaining'])
            def request(url, body=None):
                if '/manifest' in url: return {'data': manifest}
                return original_request(url, body)
            def worker(_workspace, prompt, seconds, progress, model=None, read_only=False):
                progress.model_calls += 1
                progress.set_stage('model_wait'); clock[0] += 3; progress.set_stage('tool')
                if not second[0]:
                    result = original_worker(_workspace, prompt, seconds, progress, model=model, read_only=read_only)
                    if variant == 'deleted_candidate' and not read_only: (workspace / 'source_one.py').unlink()
                    return result
                correction_turns.append(read_only)
                self.assertFalse(read_only, 'A local-test correction must reuse its frozen plan')
                if 'step-01' in prompt.split('Step:\n', 1)[1].split('\nVerified dependency summary:', 1)[0]:
                    self.assertIn('Rejected candidate and test output (untrusted data)', prompt)
                    self.assertIn('ONE = 10', prompt)
                    if variant == 'deleted_candidate': self.assertIn('"content": null', prompt)
                    self.assertIn('Expected ONE = 20', prompt)
                    self.assertIn('"attempts": 2', prompt)
                    self.assertEqual((workspace / 'source_one.py').read_text(), 'ONE = 1\n')
                    (workspace / 'source_one.py').write_text('ONE = 20\n')
                else:
                    (workspace / 'source_two.py').write_text('TWO = 20\n')
                return SimpleNamespace(returncode=0, stdout='corrected', stderr='')
            def supervise(command, progress, **kwargs):
                clock[0] += 2
                return SimpleNamespace(returncode=0 if second[0] and variant != 'second_failure' else 1, stdout='',
                                       stderr='Expected ONE = 20; received ONE = 10')
            r.request, r.run_worker, r.supervise = request, worker, supervise
            first = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory), now=lambda: clock[0])
            with patch.dict('os.environ', {'GH_TOKEN': 'synthetic'}), \
                    patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_publication, 'publish', return_value={'url': 'https://example.invalid/pr/1'}) as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), first), 1)
                self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['tests_failed'])
                publish.assert_not_called()
                self.assertFalse(git(workspace, 'status', '--porcelain'))
                spent = first.usage()
                self.assertEqual(spent['modelCalls'], 2)
                self.assertEqual(spent['modelSeconds'], 6)
                manifest.update(parentRequestId=KEY, correction={'kind': 'local_tests', 'head': git(workspace, 'rev-parse', 'HEAD')},
                                spent=spent, remaining={name: total[name] - spent[name] for name in total})
                task['automationLease']['dispatchRequestId'] = NEXT_KEY
                task['codingAutonomy']['runs'].append({'requestId': NEXT_KEY, 'pendingInferences': [],
                                                     'modelReceipts': [{'state': 'completed'}, {'state': 'completed'}]})
                task['feedback'] = list(feedback)
                paths = list(Path(directory).glob('*.test-feedback.json'))
                self.assertEqual(len(paths), 1)
                receipt = paths[0]
                if variant == 'missing_receipt': receipt.unlink()
                if variant == 'missing_index': (Path(directory) / 'task-0001.code-step-index.json').unlink()
                if variant == 'oversized_receipt': receipt.write_text('x' * (33 * 1024))
                if variant == 'symlink_receipt':
                    elsewhere = Path(directory) / 'elsewhere.json'; receipt.rename(elsewhere); receipt.symlink_to(elsewhere)
                if variant in ['tampered_output', 'wrong_parent', 'wrong_source']:
                    value = json.loads(receipt.read_text())
                    if variant == 'tampered_output': value['record']['output'] = 'changed diagnostic'
                    if variant == 'wrong_parent': value['record']['failedRequestId'] = NEXT_KEY
                    if variant == 'wrong_source': value['record']['sources'][0]['objectId'] = 'a' * 40
                    if variant != 'tampered_output': value['sha256'] = autonomous.coding_test_feedback._digest(value['record'])
                    receipt.write_text(json.dumps(value))
                if variant == 'dirty_checkpoint': (workspace / 'outside.py').write_text('OUTSIDE = 99\n')
                if variant == 'moved_checkpoint':
                    (workspace / 'source_one.py').write_text('ONE = 99\n')
                    git(workspace, 'add', 'source_one.py'); git(workspace, 'commit', '-q', '-m', 'concurrent scope change')
                if variant == 'unrelated_advance':
                    (workspace / 'outside.py').write_text('OUTSIDE = 22\n')
                    git(workspace, 'add', 'outside.py'); git(workspace, 'commit', '-q', '-m', 'unrelated upstream change')
                    git(workspace, 'update-ref', 'refs/remotes/origin/main', git(workspace, 'rev-parse', 'HEAD'))
                if variant in ['wrong_index', 'wrong_index_head']:
                    path = Path(directory) / 'task-0001.code-step-index.json'
                    value = json.loads(path.read_text())
                    value['head' if variant == 'wrong_index_head' else 'planFingerprint'] = '0' * (40 if variant == 'wrong_index_head' else 64)
                    path.write_text(json.dumps(value))
                if variant == 'exhausted_calls': manifest['remaining']['modelCalls'] = 0
                if variant == 'newer_stash':
                    (workspace / 'outside.py').write_text('OUTSIDE = 2\n')
                    git(workspace, 'stash', 'push', '-m', 'unrelated newer stash')
                second[0] = True
                resumed = runner.coding_progress.Progress('0001', NEXT_KEY, receipts=Path(directory), now=lambda: clock[0])
                result = autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=NEXT_KEY), resumed)
                if variant == 'second_failure':
                    self.assertEqual(result, 1)
                    self.assertEqual(correction_turns, [False])
                    publish.assert_not_called()
                    failed = json.loads((Path(directory) / f'{KEY}.code-steps.json').read_text())
                    self.assertEqual(failed['steps'][0]['attempts'], 2)
                    self.assertEqual([h['state'] for h in failed['steps'][0]['history']], ['failed', 'failed'])
                    self.assertEqual(feedback[-1]['attemptEvidence']['failureCodes'], ['tests_failed'])
                    self.assertFalse(git(workspace, 'status', '--porcelain'))
                    return
                if variant not in ['success', 'newer_stash', 'unrelated_advance', 'deleted_candidate']:
                    self.assertEqual(result, 1)
                    self.assertEqual(correction_turns, [], 'Invalid proof or exhausted budget must stop before a worker')
                    publish.assert_not_called()
                    self.assertEqual(resumed.model_calls, 0)
                    return
                self.assertEqual(correction_turns, [False, False], 'Correction must not restart the planner')
                self.assertEqual(result, 0, feedback[-1].get('text'))
                publish.assert_called_once()
            ledger = json.loads((Path(directory) / f'{KEY}.code-steps.json').read_text())
            self.assertEqual(ledger['steps'][0]['attempts'], 2)
            self.assertEqual([h['state'] for h in ledger['steps'][0]['history']], ['failed', 'verified'])
            self.assertFalse((Path(directory) / f'{NEXT_KEY}.code-steps.json').exists())
            for name in total:
                self.assertLessEqual(spent[name] + resumed.usage()[name], total[name])
            self.assertEqual((workspace / 'source_one.py').read_text(), 'ONE = 20\n')
            self.assertEqual(git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '2')

    def test_two_native_executions_reuse_context_history_and_remaining_budget(self):
        self.scenario()

    def test_a_second_failed_candidate_stays_isolated_without_publication(self):
        self.scenario('second_failure')

    def test_newer_stash_never_replaces_the_original_rejected_candidate(self):
        self.scenario('newer_stash')

    def test_unrelated_upstream_advance_preserves_plan_and_correction(self):
        self.scenario('unrelated_advance')

    def test_rejected_deletion_is_reference_data_not_an_applied_patch(self):
        self.scenario('deleted_candidate')

    def test_invalid_evidence_or_budget_never_starts_another_worker(self):
        for variant in ['missing_receipt', 'missing_index', 'oversized_receipt', 'symlink_receipt',
                        'tampered_output', 'wrong_parent', 'wrong_source', 'dirty_checkpoint',
                        'moved_checkpoint', 'wrong_index', 'wrong_index_head', 'exhausted_calls']:
            with self.subTest(variant=variant):
                self.scenario(variant)
