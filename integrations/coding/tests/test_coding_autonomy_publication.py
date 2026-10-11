"""Behavior at the runner/GitHub boundary, including an accepted lost response."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock

HERE = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
publication = load('coding_publication')
control = load('coding_dispatch_control')
KEY = '11111111-2222-4333-8444-555555555555'
HEAD = 'a' * 40
REPO = 'synthetic/repository'
BRANCH = 'agentx/coding-task-0001'

class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'intent.json'
        self.pr = None
        self.remote = None
        self.mutations = []
        self.lost = None
        self.identity = {'repository': REPO, 'branch': BRANCH, 'base': 'main'}
        self.intent = {**self.identity, 'identity': self.identity, 'requestId': KEY, 'pipelineId': '0001',
                       'head': HEAD, 'expectedPR': None, 'body': 'Final source diff', 'title': 'Synthetic delivery',
                       'diffFingerprint': 'b' * 64, 'verdict': {'status': 'done', 'leaseId': 'original-lease',
                       'attemptEvidence': {'workerReceiptFingerprint': 'c' * 64}}}
        self.runner = SimpleNamespace(request=self.request, git=self.git, coding_dispatch_control=control)

    def git(self, workspace, *args, **kwargs):
        self.assertTrue(self.path.is_file(), 'intent must precede push')
        self.assertEqual(args[0], 'push')
        self.assertFalse(any('force' in value for value in args))
        self.remote = HEAD
        self.mutations.append('push')
        if self.lost == 'push':
            raise OSError('Synthetic lost push reply')

    def request(self, url, body=None, **kwargs):
        if '/git/ref/heads/' in url:
            return {'object': {'sha': self.remote}}
        if body is not None:
            self.assertTrue(self.path.is_file())
            operation = kwargs.get('method', 'POST')
            self.mutations.append(operation)
            if operation == 'POST':
                self.pr = self.make_pr()
            self.pr['body'] = body['body']
            self.pr['head']['sha'] = self.remote
            if self.lost == operation:
                raise OSError('Synthetic accepted effect, response lost')
            return self.pr
        if '?head=' in url:
            return [self.pr] if self.pr else []
        return self.pr

    def make_pr(self, state='open'):
        return {'number': 42, 'state': state, 'html_url': f'https://github.com/{REPO}/pull/42',
                'body': 'Previous description', 'head': {'ref': BRANCH, 'sha': HEAD, 'repo': {'full_name': REPO}},
                'base': {'ref': 'main', 'repo': {'full_name': REPO}}}

    def test_lost_create_recovers_original_effect_using_only_reads_after_runner_restart(self):
        self.lost = 'POST'
        with self.assertRaises(publication.PublicationUnknown):
            publication.publish(self.runner, Path(self.tmp.name), self.intent, self.path, 'synthetic-token')
        saved = json.loads(self.path.read_text())
        before = list(self.mutations)
        recovered = load('coding_publication').recover(self.request, saved, 'synthetic-token')
        self.assertEqual(recovered['number'], 42)
        self.assertEqual(self.mutations, before)
        self.assertEqual(publication.verdict(saved, recovered)['leaseId'], 'original-lease')

    def test_lost_patch_recovers_same_pr_and_exact_final_description_without_reposting(self):
        self.pr = self.make_pr()
        self.intent['expectedPR'] = {**self.identity, 'number': 42}
        self.lost = 'PATCH'
        with self.assertRaises(publication.PublicationUnknown):
            publication.publish(self.runner, Path(self.tmp.name), self.intent, self.path, 'synthetic-token')
        before = list(self.mutations)
        recovered = publication.recover(self.request, json.loads(self.path.read_text()), 'synthetic-token')
        self.assertEqual(recovered['number'], 42)
        self.assertEqual(self.mutations, before)
        self.assertEqual(self.mutations, ['push', 'PATCH'])

    def test_closed_original_pr_refuses_before_push_and_never_creates_replacement(self):
        self.pr = self.make_pr('closed')
        self.intent['expectedPR'] = {**self.identity, 'number': 42}
        with self.assertRaises(RuntimeError):
            publication.publish(self.runner, Path(self.tmp.name), self.intent, self.path, 'synthetic-token')
        self.assertEqual(self.mutations, [])

    def test_changed_target_or_fork_refuses_before_push(self):
        for field in ('ref', 'repo'):
            self.pr = self.make_pr()
            self.pr['base'][field] = 'other' if field == 'ref' else {'full_name': 'other/repository'}
            with self.assertRaises(RuntimeError):
                publication.publish(self.runner, Path(self.tmp.name), self.intent, self.path, 'synthetic-token')
        self.assertEqual(self.mutations, [])

    def test_lost_push_with_no_pr_proof_stays_unknown_and_never_retries_effect(self):
        self.lost = 'push'
        with self.assertRaises(publication.PublicationUnknown):
            publication.publish(self.runner, Path(self.tmp.name), self.intent, self.path, 'synthetic-token')
        with self.assertRaises(publication.PublicationUnknown):
            publication.recover(self.request, json.loads(self.path.read_text()), 'synthetic-token')
        self.assertEqual(self.mutations, ['push'])

    def test_unreceived_stop_tombstone_prevents_late_launch_and_preserves_another_host_job(self):
        from unittest.mock import patch
        root = Path(self.tmp.name)
        other = '22222222-2222-4333-8444-555555555555'
        with patch.object(control, 'STATE', root), patch.object(control, 'RECEIPTS', root / 'receipts'), \
                patch.object(control, 'unit_active', return_value=True), patch.object(control, 'queued_tasks', return_value=[]), patch.object(control.subprocess, 'run') as process:
            control.save_receipt({'requestId': other, 'pipelineId': '0002', 'phase': 'accepted'})
            self.assertTrue(control.stop('0001', KEY)['cancelledBeforeLaunch'])
            self.assertFalse(control.launch('0001', KEY, 0, autonomous=True)['accepted'])
            self.assertEqual((control.RECEIPTS / 'latest').read_text(), other)
            self.assertTrue(control.status(KEY)['run']['progress']['coreRecorded'])
            process.assert_not_called()

    def test_native_feedback_recovery_keeps_review_instead_of_legacy_blocked(self):
        from unittest.mock import patch
        root = Path(self.tmp.name)
        control.atomic_json(root / f'{KEY}.json', {'requestId': KEY, 'pipelineId': '0001', 'autonomous': True})
        control.atomic_json(root / f'{KEY}.progress.json', {'requestId': KEY, 'pipelineId': '0001', 'phase': 'delivering'})
        control.atomic_json(root / f'{KEY}.verdict.json', {'status': 'done', 'leaseId': 'original-lease', 'attemptEvidence': {'failureCodes': []}})
        request = Mock()
        with patch.object(control, 'RECEIPTS', root), patch.object(control, 'load_runner', return_value=SimpleNamespace(request=request)):
            control.reconcile('0001', KEY)
        self.assertEqual(request.call_args.args[1]['leaseId'], 'original-lease')
        self.assertEqual(json.loads((root / f'{KEY}.progress.json').read_text())['result'], 'review')

if __name__ == '__main__':
    unittest.main()
