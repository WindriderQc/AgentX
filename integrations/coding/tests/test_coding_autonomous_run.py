"""Synthetic executor fixtures exercise the native gates before external effects."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
runner = load('coding_run')
autonomous = runner.coding_autonomous
KEY = '11111111-2222-4333-8444-555555555555'

class AutonomousBoundaryTest(unittest.TestCase):
    def test_unresolved_model_receipt_refuses_before_publication_lock_or_push(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'task-0001').mkdir()
            progress = runner.coding_progress.Progress('0001', KEY, receipts=root)
            manifest = {'scope': ['source.py'], 'remaining': {'workSeconds': 100, 'modelCalls': 8, 'modelSeconds': 90, 'testSeconds': 90},
                        'limits': {'noProgressSeconds': 100}, 'spent': {}}
            task = {'status': 'in_progress', 'automationLease': {'leaseId': 'original', 'dispatchRequestId': KEY},
                    'automation': {'verificationProfile': 'agentx-dispatcher-tests/v1'},
                    'codingCapacity': {'model': 'synthetic'},
                    'codingAutonomy': {'runs': [{'requestId': KEY, 'pendingInferences': ['unknown'],
                        'modelReceipts': [{'state': 'unknown'}]}]}}
            feedback = []
            def request(url, body=None):
                if '/manifest' in url: return {'data': manifest}
                if '/feedback' in url: feedback.append(body); return {}
                return {'data': {'task': task}}
            r = SimpleNamespace(**vars(runner))
            r.request = request; r.WORKSPACES = root
            r.git = lambda *args, **kwargs: '' if args[1] == 'status' else 'a' * 40
            r.install_dependencies = Mock(); r.dependency_state = Mock(return_value='same')
            r.run_worker = Mock(return_value=SimpleNamespace(returncode=0, stdout='Synthetic changes', stderr=''))
            r.supervise = Mock(return_value=SimpleNamespace(returncode=0))
            r.worker_home = Mock(return_value=root); r.sandbox = Mock(return_value=['synthetic-tests'])
            r.begin_publication = Mock(return_value=True)
            with patch.dict('os.environ', {'GH_TOKEN': 'synthetic'}), patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_git, 'finish_merge'), patch.object(autonomous.coding_git, 'checkpoint', return_value='a' * 40), \
                    patch.object(autonomous.coding_git, 'audit', return_value=['source.py']), patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            r.begin_publication.assert_not_called(); publish.assert_not_called()
            self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['model_termination_unverified'])

    def test_stop_with_revoked_manifest_cancels_native_capacity_without_worker_or_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            progress = runner.coding_progress.Progress('0001', KEY, receipts=root)
            task = {'status': 'queued', 'automationAttemptCount': 0, 'codingCapacity': {'requestId': KEY}}
            calls = []
            def request(url, body=None):
                calls.append(url)
                if '/manifest' in url:
                    error = RuntimeError('Core already revoked authorization')
                    error.code = 'CODING_AUTONOMY_CONFLICT'
                    raise error
                if '/capacity/cancel' in url:
                    self.assertEqual(body['requestId'], KEY)
                    task.pop('codingCapacity')
                    return {}
                return {'data': {'task': dict(task)}}
            r = SimpleNamespace(**vars(runner)); r.request = request; r.run_worker = Mock()
            self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertTrue(progress.core_recorded); self.assertTrue(progress.preflight)
            self.assertEqual(progress.stop_reason, 'authorization_removed')
            self.assertTrue(any('/capacity/cancel' in call for call in calls)); r.run_worker.assert_not_called()

    def test_autonomous_lost_feedback_never_calls_nonleased_legacy_fallback(self):
        progress = Mock()
        with patch('sys.argv', ['coding_run.py', '0001', '--request-id', KEY, '--autonomous']), \
                patch.object(runner.coding_progress, 'Progress', return_value=progress), \
                patch.object(runner, 'MODEL', 'synthetic'), \
                patch.object(runner, 'execute', side_effect=OSError('Accepted native verdict, lost response')), \
                patch.object(runner, 'feedback') as legacy:
            self.assertEqual(runner.main(), 2)
        legacy.assert_not_called(); progress.finish.assert_not_called(); progress.write.assert_called_once()

    def test_expired_campaign_before_first_manifest_or_during_capacity_wait_releases_exact_wait(self):
        for refuse_at in (1, 3, 'claim'):
            with self.subTest(refuse_at=refuse_at), tempfile.TemporaryDirectory() as directory:
                progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
                task = {'status': 'queued', 'automationAttemptCount': 0, 'automation': {'budgets': {'maxDurationMs': 100000}},
                        'codingCapacity': {'requestId': KEY}}
                manifests = 0
                claims = 0
                def request(url, body=None):
                    nonlocal manifests, claims
                    if '/manifest' in url:
                        manifests += 1
                        if manifests == refuse_at:
                            error = RuntimeError('Campaign window ended'); error.code = 'CODING_AUTONOMY_QUEUE_WAIT'
                            raise error
                        return {'data': {'scope': ['source.py'], 'remaining': {'workSeconds': 100, 'testSeconds': 50,
                            'modelSeconds': 50, 'modelCalls': 8}, 'limits': {'noProgressSeconds': 100}, 'spent': {}}}
                    if '/claim' in url:
                        claims += 1
                        error = RuntimeError('Host or campaign refused')
                        error.code = 'CODING_AUTONOMY_QUEUE_WAIT' if refuse_at == 'claim' else 'CODING_CAPACITY_WAITING'
                        raise error
                    if '/capacity/cancel' in url:
                        self.assertEqual(body, {'requestId': KEY}); task.pop('codingCapacity'); return {}
                    return {'data': {'task': dict(task)}}
                r = SimpleNamespace(**vars(runner)); r.request = request; r.run_worker = Mock()
                with patch.object(autonomous.time, 'sleep'):
                    self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
                self.assertEqual(claims, 0 if refuse_at == 1 else 1)
                self.assertTrue(progress.core_recorded); self.assertTrue(progress.preflight)
                self.assertEqual(progress.stop_reason, 'queue_window_closed')
                self.assertEqual(runner.coding_progress.safe_progress(json.loads(progress.path.read_text()), KEY, '0001')['stopReason'], 'queue_window_closed')
                self.assertNotIn('codingCapacity', task); r.run_worker.assert_not_called()

    def test_lost_manifest_transport_remains_unknown_without_cancel_or_model(self):
        with tempfile.TemporaryDirectory() as directory:
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            r = SimpleNamespace(**vars(runner)); r.request = Mock(side_effect=OSError('Lost manifest response')); r.run_worker = Mock()
            with self.assertRaises(OSError):
                autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress)
            self.assertFalse(progress.core_recorded); self.assertEqual(r.request.call_count, 1); r.run_worker.assert_not_called()

if __name__ == '__main__': unittest.main()
