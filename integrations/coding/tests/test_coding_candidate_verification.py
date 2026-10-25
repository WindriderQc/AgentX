"""Exercise execute(), real Git, native command profiles and the offline sandbox."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from integrations.coding.tests import test_coding_autonomous_run as fixtures

runner, autonomous, KEY = fixtures.runner, fixtures.autonomous, fixtures.KEY
TEST = 'integrations/coding/tests/test_one.py'
CALL = '33333333-4444-4555-8666-777777777777'


class CandidateVerificationTest(unittest.TestCase):
    def fixture(self, directory, case='correct', *, real_sandbox=False):
        r, workspace, feedback, calls, tests = fixtures.RunnerOwnedCodeStepTest().fixture(directory)
        (workspace / TEST).write_text('import unittest\nfrom source_one import ONE\n'
                                    'class Check(unittest.TestCase):\n'
                                    ' def test_value(self): self.assertEqual(ONE, 10)\n')
        fixtures.git(workspace, 'add', TEST)
        fixtures.git(workspace, 'commit', '-qm', 'independent baseline verifier')
        fixtures.git(workspace, 'update-ref', 'refs/remotes/origin/main', fixtures.git(workspace, 'rev-parse', 'HEAD'))
        original = r.request
        manifest = {**original('/manifest')['data'], 'pipelineId': '0001', 'requestId': KEY,
                    'qualification': {'acceptanceCriteria': ['ONE equals ten.']},
                    'scope': ['source_one.py', TEST], 'verificationProfile': 'agentx-dispatcher-tests/v1',
                    'queueRequestId': CALL, 'queueEndAt': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}
        task = original('/task')['data']['task']
        task['automationLease']['expiresAt'] = manifest['queueEndAt']
        task['codingAutonomy']['runs'][0]['modelReceipts'] = [{
            'callId': CALL, 'state': 'completed', 'startedAt': '2026-01-01T00:00:00Z',
            'finishedAt': '2026-01-01T00:00:01Z',
            'settlement': {'state': 'completed', 'finishedAt': '2026-01-01T00:00:01Z'}}]
        progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
        def request(url, body=None):
            if '/manifest' in url:
                if (calls and case in {'revoked', 'lost_native_reply'}) or (tests and case == 'revoked_after_focused'):
                    error = OSError('lost GET response') if case == 'lost_native_reply' else RuntimeError('revoked')
                    if case != 'lost_native_reply': error.code = 'CODING_AUTONOMY_CONFLICT'
                    raise error
                return {'data': manifest}
            return original(url, body)
        r.request = request
        def worker(_workspace, _prompt, _seconds, p, **_kwargs):
            calls.append('one synthetic worker; no inference')
            if case != 'no_diff':
                (workspace / 'source_one.py').write_text('ONE = 11\n' if case == 'incorrect' else 'ONE = 10\n')
            if case == 'outside':
                (workspace / 'outside.py').write_text('OUTSIDE = 1\n')
            if case == 'dependencies':
                (workspace / 'core/package.json').write_text('{}\n')
            if case == 'mode_only':
                (workspace / 'source_one.py').write_text('ONE = 1\n')
                (workspace / 'source_one.py').chmod(0o755)
            p.model_calls = 1
            p.stage_spent['modelSeconds'] = 70
            p.role_drained = case != 'undrained'
            p.stop_reason = {'operator': 'operator_stop', 'hard': 'hard_budget',
                             'unknown_stop': 'tool_inactive'}.get(case, 'model_budget_reserve')
            if case == 'test_budget':
                p.stage_spent['testSeconds'] = p.cumulative_limits['testSeconds']
            if case == 'expired': p.queue_deadline = p.now() - 1
            if case == 'lease_expired': task['automationLease']['expiresAt'] = '2026-01-01T00:00:00Z'
            if case == 'work_budget': p.hard_deadline = p.now() - 1
            if case in {'pending', 'unknown', 'mismatched_lease', 'mismatched_request', 'lost_settlement'}:
                run = task['codingAutonomy']['runs'][0]
                if case == 'pending': run['pendingInferences'] = [CALL]
                if case == 'unknown': run['modelReceipts'][0]['state'] = 'unknown'
                if case == 'lost_settlement': run['modelReceipts'][0].pop('settlement')
                if case == 'mismatched_lease': task['automationLease'] = {**task['automationLease'], 'leaseId': 'foreign'}
                if case == 'mismatched_request': run['requestId'] = CALL
            return SimpleNamespace(returncode=1 if case == 'crash' else -signal.SIGTERM, stdout='candidate', stderr='')
        r.run_worker = worker
        r.dependency_state = lambda w: (w / 'core/package.json').read_bytes()
        if case == 'dependency_drift': r.dependency_state = lambda w: 'changed' if calls else 'installed'
        home = r.worker_home(workspace)
        home.mkdir()
        r.sandbox = runner.sandbox
        def supervise(command, p, **kwargs):
            tests.append(command)
            self.assertIn('--unshare-all', command)
            self.assertNotIn('--share-net', command)
            self.assertIsNone(p.tick())
            invocation = command if real_sandbox else command[command.index('--chdir') + 2:]
            result = subprocess.run(invocation, cwd=workspace, capture_output=True, text=True, timeout=15)
            if case == 'test_mutation': (workspace / 'source_one.py').write_text('ONE = 999\n')
            if case == 'full_mutation' and len(tests) == 2: (workspace / 'source_one.py').write_text('ONE = 999\n')
            if case == 'full_failure' and len(tests) == 2: result.returncode = 1
            if case == 'stop_during_tests':
                p.stop_path.write_text(json.dumps({'pipelineId': '0001', 'requestId': KEY}))
            if case == 'budget_during_tests': p._progress.queue_deadline = p.now() - 1
            return result
        r.supervise = supervise
        r.begin_publication = lambda p: not p.check_stop()
        return r, workspace, progress, calls, tests, feedback

    def execute(self, r, progress, publish):
        with patch.dict(os.environ, {'GH_TOKEN': 'synthetic'}), \
                patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                patch.object(autonomous.coding_publication, 'publish', publish):
            return autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress)

    def test_correct_candidate_runs_native_focused_and_full_tests_then_one_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, progress, calls, tests, feedback = self.fixture(directory)
            publish = Mock(return_value={'url': 'https://example.invalid/pr/1'})
            self.assertEqual(self.execute(r, progress, publish), 0)
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(tests), 2)
            self.assertIn(TEST, tests[0]); self.assertIn('discover', tests[1])
            self.assertEqual(progress.stop_reason, 'model_budget_reserve')
            self.assertEqual(progress.model_calls, 1)
            self.assertEqual(progress.usage()['modelSeconds'], 70)
            self.assertEqual(feedback[0]['attemptEvidence']['verification']['status'], 'passed')
            self.assertEqual(fixtures.git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '1')
            receipt = json.loads((Path(directory) / f'{KEY}.candidate-verification.json').read_text())
            self.assertEqual(receipt['workerStopReason'], 'model_budget_reserve')
            self.assertEqual(receipt['additionalModelCalls'], 0)
            publish.assert_called_once()

    def test_refusals_preserve_candidate_without_tests_or_publication(self):
        for case in ('no_diff', 'mode_only', 'outside', 'dependencies', 'dependency_drift', 'operator', 'hard', 'unknown_stop',
                     'test_budget', 'work_budget', 'expired', 'pending', 'unknown', 'lost_settlement',
                     'undrained', 'mismatched_lease', 'lease_expired', 'mismatched_request', 'revoked', 'lost_native_reply', 'crash'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                r, workspace, progress, calls, tests, feedback = self.fixture(directory, case)
                publish = Mock()
                self.assertEqual(self.execute(r, progress, publish), 1)
                self.assertEqual(len(calls), 1)
                self.assertEqual(tests, [])
                publish.assert_not_called()
                self.assertEqual(fixtures.git(workspace, 'status', '--porcelain'), '')
                self.assertEqual(fixtures.git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '0')
                if case != 'no_diff': self.assertTrue(fixtures.git(workspace, 'stash', 'list'))
                self.assertEqual(progress.model_calls, 1)

    def test_bad_candidate_or_changed_source_or_new_fence_cannot_publish(self):
        for case in ('incorrect', 'test_mutation', 'stop_during_tests', 'budget_during_tests'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                r, workspace, progress, calls, tests, feedback = self.fixture(directory, case)
                publish = Mock()
                self.assertEqual(self.execute(r, progress, publish), 1)
                self.assertEqual(len(tests), 1)
                self.assertEqual(len(calls), 1)
                self.assertEqual(feedback[0]['attemptEvidence']['verification']['status'], 'failed')
                self.assertEqual(fixtures.git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '0')
                self.assertTrue(fixtures.git(workspace, 'stash', 'list'))
                publish.assert_not_called()

    def test_original_progress_keeps_refusing_models_during_cpu_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, progress, calls, tests, feedback = self.fixture(directory)
            original = r.supervise
            def supervise(command, cpu, **kwargs):
                self.assertEqual(progress.check_stop(), 'model_budget_reserve')
                self.assertIsNone(progress.model_guidance())
                self.assertIsNone(cpu.check_stop())
                return original(command, cpu, **kwargs)
            r.supervise = supervise
            self.assertEqual(self.execute(r, progress, Mock(return_value={'url': 'https://example.invalid/pr/1'})), 0)

    def test_full_verification_and_authority_remain_publication_gates(self):
        for case in ('full_failure', 'full_mutation', 'revoked_after_focused'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                r, workspace, progress, calls, tests, feedback = self.fixture(directory, case)
                publish = Mock()
                self.assertEqual(self.execute(r, progress, publish), 1)
                self.assertEqual(len(tests), 1 if case == 'revoked_after_focused' else 2)
                self.assertEqual(len(calls), 1)
                publish.assert_not_called()

    def test_real_offline_sandbox_and_deadline_supervisor(self):
        if not shutil.which('bwrap'): self.skipTest('Bubblewrap unavailable')
        probe = subprocess.run(['bwrap', '--unshare-all', '--ro-bind', '/', '/', '/bin/true'], capture_output=True)
        if probe.returncode: self.skipTest('Unprivileged Bubblewrap unavailable')
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, progress, calls, tests, feedback = self.fixture(directory, real_sandbox=True)
            def supervise(command, p, **kwargs):
                tests.append(command)
                return runner.supervise(command, p, **kwargs)
            r.supervise = supervise
            self.assertEqual(self.execute(r, progress, Mock(return_value={'url': 'https://example.invalid/pr/1'})), 0)
            self.assertEqual(len(tests), 2)
            self.assertTrue(all('--unshare-all' in command and '--share-net' not in command for command in tests))
            self.assertGreater(progress.usage()['testSeconds'], 0)
            self.assertEqual(progress.usage()['modelSeconds'], 70)

    def test_lost_publication_or_native_ack_reconciles_without_repeating_effects(self):
        for lost in ('publication', 'feedback'):
            with self.subTest(lost=lost), tempfile.TemporaryDirectory() as directory:
                r, workspace, progress, calls, tests, feedback = self.fixture(directory)
                original_request, original_git = r.request, r.git
                effects, pr = [], {}
                def git(w, *args, **kwargs):
                    if args[0] == 'push': effects.append('push'); return ''
                    return original_git(w, *args, **kwargs)
                def request(url, body=None, **kwargs):
                    if 'api.github.com' not in url:
                        value = original_request(url, body)
                        if '/feedback' in url and lost == 'feedback' and len(feedback) == 1:
                            raise OSError('Native result accepted; acknowledgement lost')
                        return value
                    if '/git/ref/' in url: return {'object': {'sha': pr['head']['sha']}}
                    if url.endswith('/pulls'):
                        effects.append('create_pr')
                        identity = {'ref': f'agentx/coding-task-0001', 'repo': {'full_name': r.REPOSITORY},
                                    'sha': original_git(workspace, 'rev-parse', 'HEAD')}
                        pr.update(state='open', head=identity, base={**identity, 'ref': r.BASE_BRANCH},
                                  number=1, html_url='https://example.invalid/pr/1', body=body['body'])
                        if lost == 'publication': raise OSError('PR created; reply lost')
                        return pr
                    if '/pulls?' in url: return [pr] if pr else []
                    if url.endswith('/pulls/1'): return pr
                    raise AssertionError(url)
                r.request, r.git = request, git
                with patch.dict(os.environ, {'GH_TOKEN': 'synthetic'}), \
                        patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}):
                    if lost == 'publication':
                        self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 2)
                    else:
                        with self.assertRaises(OSError):
                            autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress)
                control = r.coding_dispatch_control
                with patch.object(control, 'RECEIPTS', Path(directory)), \
                        patch.object(control, 'read_receipt', return_value={'pipelineId': '0001', 'autonomous': True}), \
                        patch.object(control, 'load_runner', return_value=r), \
                        patch.object(control, 'setting', return_value='synthetic'):
                    control.reconcile('0001', KEY)
                    control.reconcile('0001', KEY)
                self.assertEqual(effects, ['push', 'create_pr'])
                self.assertEqual(len(calls), 1)
                self.assertEqual(len(tests), 2)
                self.assertTrue(all(body == feedback[0] for body in feedback))
                terminal = json.loads(progress.path.read_text())
                self.assertEqual(terminal['stopReason'], 'model_budget_reserve')
                self.assertTrue(terminal['coreRecorded'])


if __name__ == '__main__':
    unittest.main()
