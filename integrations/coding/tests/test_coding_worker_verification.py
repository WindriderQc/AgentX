import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from integrations.coding import coding_worker_verification as verification
from integrations.coding.coding_task_worktree import configure_execution, task_workspace, promotion_workspace
from integrations.coding.coding_task_worktree import prepare_task_worktree, profile_fingerprint, promotion_profiles
from integrations.coding import clawdx_dispatch_remote as remote
from types import SimpleNamespace
from unittest.mock import Mock
from integrations.coding.coding_advisory_packet import packet_for
from integrations.coding.coding_team_promotion import worker_snapshot_fingerprint


class WorkerVerificationTests(unittest.TestCase):
    def test_promotion_uses_original_selected_verifier_and_refuses_profile_drift(self):
        task = {'spec': 'bounded Jest regression', 'automation': {'executionProfile': 'worker/v1',
            'verificationProfile': 'jest/v1', 'scope': ['core/tests/unit/example.test.js'], 'fingerprint': 'c' * 64}}
        args = SimpleNamespace(independent_verification_command='node jest bounded-test',
            independent_verification_timeout=120, allowed_path=task['automation']['scope'],
            max_changed_files=1, max_changed_bytes=20000)
        attempt = {'evidence': {'repository': {'verificationProfileFingerprint': profile_fingerprint(args, task)}}}
        config = {'executionProfiles': {'worker/v1': {'agent': 'test-worker',
            'remoteRepo': str(self.repo.parent.parent / 'agentx-seed')}}, 'verificationProfiles': {
            'jest/v1': {'command': args.independent_verification_command, 'timeoutSeconds': 120,
                'maxChangedFiles': 1, 'maxChangedBytes': 20000},
            'agentx-dispatcher-tests/v1': {'command': 'python default verifier'}}}
        self.assertEqual(promotion_profiles(config, task, attempt)[1]['command'], 'node jest bounded-test')
        config['verificationProfiles']['jest/v1']['command'] = 'python default verifier'
        with self.assertRaisesRegex(ValueError, 'profile changed'):
            promotion_profiles(config, task, attempt)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo = self.root / '.openclaw/workspace-test-worker/tasks/0700'
        self.repo.mkdir(parents=True)
        self.grants = self.root / 'grants'
        self.git('init', '-q'); self.git('config', 'user.email', 'test@example.test'); self.git('config', 'user.name', 'test')
        (self.repo / 'sum.py').write_text('def add(a,b):\n return a-b\n')
        (self.repo / '.gitignore').write_text('node_modules/\n')
        (self.repo / 'core').mkdir(); (self.repo / 'core/package.json').write_text('{}')
        self.git('add', '.'); self.git('commit', '-qm', 'original task base')
        self.base = self.git('rev-parse', 'HEAD').strip()
        self.grant = {'agent': 'test-worker', 'repository': str(self.repo), 'apiBase': 'http://core.example.test',
            'pipelineId': '0700', 'attempt': 1, 'leaseId': 'lease-test', 'sessionKey': 'turn-1',
            'baseRevision': self.base, 'scope': ['sum.py'], 'sourceFiles': ['sum.py'],
            'command': 'python3 -B -c "from sum import add; assert add(2,3)==5"',
            'maxCalls': 2, 'timeoutSeconds': 10, 'deadlineEpoch': time.time()+60,
            'maxChangedFiles': 1, 'maxChangedBytes': 10000}
        self.task = {'pipelineId': '0700', 'status': 'in_progress', 'assignee': 'test-worker',
            'automation': {'scope': ['sum.py']}, 'automationLease': {'leaseId': 'lease-test', 'attempt': 1,
                'expiresAt': '2099-01-01T00:00:00Z'}}
        verification.prepare(self.grant, root=self.grants)

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True)

    def run_verifier(self, **kwargs):
        return verification.run('test-worker', 'agent:test-worker:turn-1', root=self.grants,
            task_reader=lambda _grant: self.task, **kwargs)

    def test_real_sandbox_reports_failure_then_scoped_correction_with_durable_budget(self):
        if not Path('/usr/bin/bwrap').exists():
            self.skipTest('Bubblewrap is a runtime prerequisite')
        first = self.run_verifier()
        # A denied user namespace is an explicit verifier failure, never a host fallback.
        if 'Operation not permitted' in first['output']:
            self.skipTest('host denies Bubblewrap user namespaces')
        self.assertFalse(first['passed']); self.assertIn('AssertionError', first['output'])
        (self.repo / 'sum.py').write_text('def add(a,b):\n return a+b\n')
        second = self.run_verifier()
        self.assertTrue(second['passed']); self.assertEqual(second['call'], 2)
        self.assertTrue(verification.prepare(self.grant, root=self.grants)['idempotent'])
        with self.assertRaisesRegex(ValueError, 'budget exhausted'):
            self.run_verifier()
        self.assertEqual(json.loads((self.grants / 'test-worker.json').read_text())['calls'], 2)

    def test_rejects_another_session_revoked_lease_or_changed_scope_before_execution(self):
        executor = lambda *_a, **_k: self.fail('refused grant executed a verifier')
        with self.assertRaisesRegex(ValueError, 'another worker session'):
            verification.run('test-worker', 'turn-other', root=self.grants, executor=executor)
        self.task['automationLease']['leaseId'] = 'new-lease'
        with self.assertRaisesRegex(ValueError, 'lease'):
            self.run_verifier(executor=executor)
        self.task['automationLease']['leaseId'] = 'lease-test'; self.task['automation']['scope'] = ['other.py']
        with self.assertRaisesRegex(ValueError, 'scope'):
            self.run_verifier(executor=executor)

    def test_refuses_untracked_ignored_dependency_scope_and_symlinks(self):
        (self.repo / 'escape.py').write_text('print(1)')
        with self.assertRaisesRegex(ValueError, 'scope'):
            self.run_verifier()
        (self.repo / 'escape.py').unlink(); (self.repo / 'sum.py').unlink()
        (self.repo / 'sum.py').symlink_to(self.root / 'outside.py')
        with self.assertRaisesRegex(ValueError, 'regular files'):
            self.run_verifier()

    def test_reserves_timeout_call_without_replaying_it_or_changing_the_task(self):
        before = json.dumps(self.task)
        def timeout(*_args, **_kwargs):
            raise subprocess.TimeoutExpired('verifier', 10)
        result = self.run_verifier(executor=timeout)
        self.assertFalse(result['passed']); self.assertIsNone(result['exitCode'])
        self.assertEqual(json.dumps(self.task), before)
        self.assertEqual(json.loads((self.grants / 'test-worker.json').read_text())['calls'], 1)

    def test_public_or_worker_writable_grants_refuse_before_running(self):
        (self.grants / 'test-worker.json').chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'private operator file'):
            self.run_verifier()
        with self.assertRaisesRegex(ValueError, 'cannot live in the worker workspace'):
            verification.prepare(self.grant, root=self.repo / 'grants')

    def test_task_paths_and_promotion_preserve_original_receipts(self):
        profile = {'remoteRepo': '/home/operator/.openclaw/workspace-test-worker/seed'}
        self.assertEqual(task_workspace(profile['remoteRepo'], '0700'), '/home/operator/.openclaw/workspace-test-worker/tasks/0700')
        attempt = {'evidence': {'repository': {'workspaceRef': 'tasks/0700', 'baseRevision': self.base}}}
        self.assertEqual(promotion_workspace(profile, {'pipelineId': '0700'}, attempt), task_workspace(profile['remoteRepo'], '0700'))
        with self.assertRaisesRegex(ValueError, 'receipt'):
            promotion_workspace(profile, {'pipelineId': '0701'}, attempt)
        command = []; configure_execution(command, {'taskWorktrees': True}, {'workerVerificationCalls': 3})
        self.assertEqual(command, ['--task-worktrees', '--worker-verification-calls', '3'])

    def test_real_worktrees_keep_dirty_seed_and_original_repair_base(self):
        seed = self.repo.parent.parent / 'seed'
        subprocess.run(['git', 'clone', '-q', str(self.repo), str(seed)], check=True)
        (seed / 'sum.py').write_text('operator dirty seed')
        dependency = seed / 'core/node_modules/example/index.js'
        dependency.parent.mkdir(parents=True); dependency.write_text('original dependency')
        subprocess.run(['git', '-C', str(seed), 'add', 'sum.py'], check=True)
        before = subprocess.check_output(['git', '-C', str(seed), 'diff', '--cached'])
        args = SimpleNamespace(task_worktrees=True, repair_attempt=False, remote_repo=str(seed),
            source_repo=str(self.repo), task_id='0701', host='local', independent_verification_command='python3 -B -m unittest',
            independent_verification_timeout=10, allowed_path=['sum.py'], max_changed_files=1, max_changed_bytes=10000)
        local = SimpleNamespace(COMMIT_PATTERN=remote.COMMIT_PATTERN, PipelineApiError=remote.PipelineApiError,
            DEFAULT_REMOTE_SOURCE_REPO=str(self.repo), ssh_run=lambda _host, script, **options: subprocess.run(script, shell=True, **options))
        task = {'spec': 'repair sum', 'automation': {'fingerprint': 'a'*64}}
        prepare_task_worktree(args, task, self.base, local)
        workspace = Path(args.remote_repo)
        self.assertEqual((seed / 'sum.py').read_text(), 'operator dirty seed')
        self.assertEqual(subprocess.check_output(['git', '-C', str(seed), 'diff', '--cached']), before)
        self.assertNotEqual(dependency.stat().st_ino, (workspace / 'core/node_modules/example/index.js').stat().st_ino)
        # Retry before claim is idempotent only for a clean exact-base worktree.
        args.remote_repo = str(seed); prepare_task_worktree(args, task, self.base, local)
        (workspace / 'sum.py').write_text('def add(a,b):\n return a+b\n')
        self.git('commit', '--allow-empty', '-qm', 'new production revision')
        newer = self.git('rev-parse', 'HEAD').strip()
        task['automationAttempts'] = [{'evidence': {'repository': dict(args.repository_evidence)}}]
        args.remote_repo = str(seed); args.repair_attempt = True
        self.assertEqual(prepare_task_worktree(args, task, newer, local), self.base)
        self.assertEqual((workspace / 'sum.py').read_text(), 'def add(a,b):\n return a+b\n')
        task['spec'] = 'different task'; args.remote_repo = str(seed)
        with self.assertRaisesRegex(remote.PipelineApiError, 'receipt'):
            prepare_task_worktree(args, task, newer, local)

    def test_missing_gateway_plugin_refuses_before_any_task_claim(self):
        args = SimpleNamespace(worker_verification_calls=3, automated_lease=True,
            task_worktrees=True, host='worker', agent='test-worker', source_repo='/srv/product')
        cli = Mock(return_value={'schema': 'agentx.coding-verification-readiness/v1', 'ready': False})
        with self.assertRaisesRegex(remote.PipelineApiError, 'not active'):
            remote.validate_worker_verification_preflight(args, cli)
        cli.return_value.update(ready=True, fileScopeHook=True, helperPath='/srv/product/integrations/coding/coding_worker_verification.py', grantRoot='/private/grants')
        remote.validate_worker_verification_preflight(args, cli)
        self.assertEqual(args.worker_grant_root, '/private/grants')

    def test_advisory_packet_reads_original_authority_and_exact_verified_patch(self):
        (self.repo / 'sum.py').write_text('def add(a,b):\n return a+b\n')
        config = {'executionProfiles': {'files/v1': {'remoteRepo': str(self.repo.parent.parent / 'seed')}},
            'verificationProfiles': {'unit/v1': {'command': 'python3 -B -m unittest', 'timeoutSeconds': 10,
                'maxChangedFiles': 1, 'maxChangedBytes': 10000}}}
        task = {'pipelineId': '0700', 'status': 'review', 'spec': 'Repair sum', 'automation': {
            'fingerprint': 'a'*64, 'executionProfile': 'files/v1', 'verificationProfile': 'unit/v1',
            'scope': ['sum.py'], 'sourceFiles': ['sum.py']}}
        args = SimpleNamespace(independent_verification_command='python3 -B -m unittest',
            independent_verification_timeout=10, allowed_path=['sum.py'], max_changed_files=1, max_changed_bytes=10000)
        fingerprint = worker_snapshot_fingerprint(pipeline_id='0700', attempt=1, assignee='test-worker',
            base_revision=self.base, files={'sum.py': (self.repo / 'sum.py').read_bytes()})
        task['automationAttempts'] = [{'attempt': 1, 'assignee': 'test-worker', 'finalState': 'review', 'evidence': {
            'verification': {'status': 'passed'}, 'workerReceiptFingerprint': fingerprint,
            'repository': {'workspaceRef': 'tasks/0700', 'baseRevision': self.base,
                'verificationProfileFingerprint': profile_fingerprint(args, task)}}}]
        packet = packet_for(task, config)
        self.assertIn('a-b', packet['authority'][0]['content'])
        self.assertIn('a+b', packet['changes'][0]['content'])
        self.assertNotIn('automationLease', packet)
        (self.repo / 'sum.py').write_text('different unverified patch')
        with self.assertRaisesRegex(ValueError, 'verified worker receipt'):
            packet_for(task, config)


if __name__ == '__main__':
    unittest.main()
