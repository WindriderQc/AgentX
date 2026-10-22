"""Synthetic executor fixtures exercise the native gates before external effects."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
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
distributed_root = autonomous.coding_distributed_root
KEY = '11111111-2222-4333-8444-555555555555'
NEXT_KEY = '22222222-3333-4444-8555-666666666666'


def git(root, *args, **_kwargs):
    return subprocess.run(['git', '-C', str(root), '-c', 'core.hooksPath=/dev/null', *args],
                          check=True, capture_output=True, text=True).stdout.strip()

class AutonomousBoundaryTest(unittest.TestCase):
    def test_unknown_verification_profile_refuses_before_worker_or_test_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'task-0001').mkdir()
            progress = runner.coding_progress.Progress('0001', KEY, receipts=root)
            manifest = {'scope': ['source.py'], 'verificationProfile': 'uninstalled-profile',
                        'remaining': {'workSeconds': 100, 'modelCalls': 8, 'modelSeconds': 90, 'testSeconds': 90},
                        'limits': {'noProgressSeconds': 100}, 'spent': {}}
            task = {'status': 'in_progress', 'automationLease': {'leaseId': 'original', 'dispatchRequestId': KEY},
                    'automation': {'verificationProfile': 'agentx-core-runner-tests/v1'},
                    'codingAutonomy': {'runs': [{'requestId': KEY, 'pendingInferences': [], 'modelReceipts': []}]}}
            feedback = []
            def request(url, body=None):
                if '/manifest' in url: return {'data': manifest}
                if '/code-step-plan' in url:
                    error = RuntimeError('Distributed coding is explicitly disabled in this fixture')
                    error.code = 'CODE_STEP_DAG_UNAVAILABLE'
                    raise error
                if '/feedback' in url: feedback.append(body); return {}
                return {'data': {'task': task}}
            r = SimpleNamespace(**vars(runner)); r.request = request; r.WORKSPACES = root
            r.install_dependencies = Mock(); r.dependency_state = Mock(return_value='same')
            r.run_worker = Mock(); r.supervise = Mock(); r.begin_publication = Mock()
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}):
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            r.run_worker.assert_not_called(); r.supervise.assert_not_called(); r.begin_publication.assert_not_called()
            self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['verification_profile_unknown'])

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
                if '/code-step-plan' in url:
                    error = RuntimeError('Distributed coding is explicitly disabled in this fixture')
                    error.code = 'CODE_STEP_DAG_UNAVAILABLE'
                    raise error
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
                    patch.object(autonomous.coding_git, 'audit', return_value=['source.py']), \
                    patch.object(autonomous, '_prepare_ledger', return_value=(Mock(), {'steps': [{'state': 'verified',
                        'id': 'step-01', 'title': 'synthetic', 'objective': 'synthetic', 'paths': ['source.py'],
                        'testTargets': ['integrations/coding/tests/test_coding_autonomous_run.py'], 'dependsOn': []}],
                        'planFingerprint': 'f' * 64, 'sourceCommit': 'a' * 40,
                        'planSummary': 'synthetic'}, KEY)), patch.object(autonomous, '_project'), \
                    patch.object(autonomous, '_write_index'), \
                    patch.object(autonomous, '_validate_planned_targets'), \
                    patch.object(autonomous.coding_code_ledger, 'next_step', return_value=None), \
                    patch.object(autonomous.coding_verification, 'focused_command', return_value=['synthetic-tests']), \
                    patch.object(r.coding_progress, 'source_state', return_value='same'), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
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

    def test_continuation_refuses_absent_or_substituted_checkpoint_before_worker(self):
        for state in ('absent', 'changed', 'dirty'):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                if state != 'absent': (root / 'task-0001').mkdir()
                progress = runner.coding_progress.Progress('0001', KEY, receipts=root)
                manifest = {'continuationCheckpoint': 'a' * 40, 'scope': ['source.py'],
                    'remaining': {'workSeconds': 100, 'modelCalls': 8, 'modelSeconds': 90, 'testSeconds': 90},
                    'limits': {'noProgressSeconds': 100}, 'spent': {}}
                task = {'status': 'in_progress', 'automationLease': {'leaseId': 'original', 'dispatchRequestId': KEY},
                    'codingAutonomy': {'runs': [{'requestId': KEY, 'pendingInferences': [], 'modelReceipts': []}]}}
                feedback = []
                def request(url, body=None):
                    if '/manifest' in url: return {'data': manifest}
                    if '/feedback' in url: feedback.append(body); return {}
                    return {'data': {'task': task}}
                def git(_workspace, *args, **kwargs):
                    if args[0] == 'branch': return 'agentx/coding-task-0001'
                    if args[0] == 'status': return ' M source.py' if state == 'dirty' else ''
                    return 'b' * 40 if state == 'changed' else 'a' * 40
                r = SimpleNamespace(**vars(runner)); r.request = request; r.WORKSPACES = root; r.git = git
                r.run_worker = Mock(); r.install_dependencies = Mock()
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
                r.run_worker.assert_not_called(); r.install_dependencies.assert_not_called()
                self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['continuation_checkpoint_changed'])


class DistributedRootCoordinatorTest(unittest.TestCase):
    def fixture(self, directory, manifests, *, stop=False):
        root = Path(directory)
        workspace = root / 'task-0001'
        workspace.mkdir()
        submissions = []
        polls = list(manifests)

        def request(url, body=None):
            if url.endswith(f'/runs/{KEY}/manifest'):
                return {'data': {'remaining': {'workSeconds': 80, 'testSeconds': 30,
                    'modelSeconds': 50, 'modelCalls': 6}}}
            if url.endswith('/code-step-plan'):
                submissions.append(body)
                spent = ({'workSeconds': 23, 'testSeconds': 7, 'modelSeconds': 10,
                          'modelCalls': 2, 'ciSeconds': 0} if len(submissions) > 1 else
                         {'workSeconds': 0, 'testSeconds': 0, 'modelSeconds': 0,
                          'modelCalls': 0, 'ciSeconds': 0})
                return {'data': {'graphId': KEY, 'assemblyRequestId': NEXT_KEY,
                    'codeStepGraph': {'schema': 'agentx.code-step-graph-summary/v1',
                                      'budget': {'spent': spent}},
                    'replayed': len(submissions) > 1}}
            if url.endswith(f'/runs/{NEXT_KEY}/manifest'):
                return {'data': polls.pop(0)}
            raise AssertionError(url)

        r = SimpleNamespace(**vars(runner))
        r.request = request
        r.WORKSPACES = root
        r.RECEIPTS = root / 'receipts'
        r.RECEIPTS.mkdir()
        r.worker_home = lambda _workspace: root / 'home'
        progress = SimpleNamespace(
            tick=Mock(return_value='operator_stop' if stop else None), check_stop=Mock(return_value=None),
            test_remaining=Mock(return_value=30), set_stage=Mock(), write=Mock(),
            checkpoint=None, finish=Mock(),
            path=root / 'receipts' / f'{KEY}.progress.json',
            cumulative_limits={'workSeconds': 70, 'testSeconds': 25, 'modelSeconds': 55, 'modelCalls': 5},
            usage=lambda: {'workSeconds': 5, 'testSeconds': 1, 'modelSeconds': 2, 'modelCalls': 1},
            hard_deadline=100, queue_deadline=120, now=lambda: 0)
        ledger = {'sourceCommit': 'a' * 40, 'planSummary': 'two waves', 'steps': [
            {'id': 'step-01', 'title': 'one', 'objective': 'first', 'paths': ['one.py'],
             'testTargets': ['test_one.py'], 'dependsOn': []},
            {'id': 'step-02', 'title': 'two', 'objective': 'second', 'paths': ['two.py'],
             'testTargets': ['test_two.py'], 'dependsOn': ['step-01']},
        ]}
        task = {'codingAutonomy': {'runs': [{'requestId': KEY, 'executorId': 'ugfrank-open'}]}}
        args = SimpleNamespace(task_id='0001', request_id=KEY)
        endpoint = f'{r.CORE}/api/pipeline/coding-autonomy/tasks/0001/runs/{KEY}/manifest'
        return r, progress, ledger, task, args, endpoint, submissions

    @staticmethod
    def manifest(*, ready=None, final=False, graph=None):
        value = {'manifestFingerprint': 'f' * 64, 'finalReady': final}
        if ready:
            value['readyAdoption'] = {'stepId': ready}
        if graph:
            value['codeStepGraph'] = graph
        return value

    def write_completion(self, r):
        path = r.RECEIPTS / f'{NEXT_KEY}.distributed-assembly.json'
        path.write_text(json.dumps({'state': 'terminal', 'identity': {'graphId': KEY,
            'requestId': NEXT_KEY}, 'completion': {'headCommit': 'b' * 40,
            'tests': [{'outcome': 'passed', 'durationMs': 2500}],
            'publication': {'url': 'https://github.com/WindriderQc/AgentX/pull/946'}}}))

    def test_submits_exact_plan_waits_dependency_waves_and_finishes_once(self):
        final_graph = {'budget': {'spent': {'workSeconds': 20, 'testSeconds': 4,
            'modelSeconds': 10, 'modelCalls': 2, 'ciSeconds': 0}}}
        manifests = [self.manifest(), self.manifest(ready='step-01'), self.manifest(),
                     self.manifest(ready='step-02'), self.manifest(final=True, graph=final_graph)]
        with tempfile.TemporaryDirectory() as directory:
            r, progress, ledger, task, args, endpoint, submissions = self.fixture(directory, manifests)
            observed = []
            def assemble(_runtime, assembly_args, _progress, *, manifest):
                observed.append((manifest.get('readyAdoption', {}).get('stepId'), manifest['finalReady'],
                                 assembly_args.request_id, assembly_args.executor_id,
                                 assembly_args.timeout_seconds))
                if manifest['finalReady']:
                    self.write_completion(r)
                return 0
            with patch.object(distributed_root.coding_distributed_assembly, 'execute', side_effect=assemble), \
                    patch.object(distributed_root.time, 'sleep') as sleep:
                result = distributed_root.execute(r, args, progress, endpoint, task, ledger)
            self.assertEqual(result['completion']['headCommit'], 'b' * 40)
            expected = {'sourceCommit': 'a' * 40,
                'plan': distributed_root.source_plan(ledger),
                'budget': {'workSeconds': 65, 'testSeconds': 24, 'modelSeconds': 50, 'modelCalls': 4}}
            self.assertEqual(submissions, [expected, expected])
            self.assertEqual(observed, [(None, False, NEXT_KEY, 'ugfrank-open', 30),
                ('step-01', False, NEXT_KEY, 'ugfrank-open', 30),
                (None, False, NEXT_KEY, 'ugfrank-open', 30),
                ('step-02', False, NEXT_KEY, 'ugfrank-open', 30),
                (None, True, NEXT_KEY, 'ugfrank-open', 20)])
            self.assertEqual(progress.usage(),
                {'workSeconds': 28, 'testSeconds': 8, 'modelSeconds': 12, 'modelCalls': 3})
            self.assertEqual(sleep.call_count, 4)

    def test_restart_replays_plan_and_terminal_assembly_journal(self):
        with tempfile.TemporaryDirectory() as directory:
            r, progress, ledger, task, args, endpoint, submissions = self.fixture(
                directory, [self.manifest(final=True, graph={'budget': {'spent': {
                    'workSeconds': 20, 'testSeconds': 4, 'modelSeconds': 10,
                    'modelCalls': 2, 'ciSeconds': 0}}})])
            self.write_completion(r)
            with patch.object(distributed_root.coding_distributed_assembly, 'execute', return_value=0) as execute:
                result = distributed_root.execute(r, args, progress, endpoint, task, ledger)
            self.assertEqual(result['completion']['publication']['url'],
                             'https://github.com/WindriderQc/AgentX/pull/946')
            self.assertEqual(len(submissions), 2)
            execute.assert_called_once()

    def test_terminal_failed_graph_stops_polling_and_retains_projection(self):
        graph = {'schema': 'agentx.code-step-graph-summary/v1', 'state': 'failed'}
        manifest = {**self.manifest(), 'codeStepGraph': graph,
                    'terminalFailure': {'code': 'step_attempts_exhausted', 'stepId': 'step-01'}}
        with tempfile.TemporaryDirectory() as directory:
            r, progress, ledger, task, args, endpoint, submissions = self.fixture(directory, [manifest])
            with patch.object(distributed_root.coding_distributed_assembly, 'execute') as execute:
                result = distributed_root.execute(r, args, progress, endpoint, task, ledger)
            self.assertEqual(result['failure']['code'], 'step_attempts_exhausted')
            self.assertIs(result['graph'], graph)
            self.assertEqual(len(submissions), 1)
            execute.assert_not_called()

    def test_final_verification_waits_for_current_dag_budget_projection(self):
        with tempfile.TemporaryDirectory() as directory:
            r, progress, ledger, task, args, endpoint, submissions = self.fixture(
                directory, [self.manifest(final=True)])
            with patch.object(distributed_root.coding_distributed_assembly, 'execute') as execute:
                with self.assertRaises(distributed_root.DistributedDagPending):
                    distributed_root.execute(r, args, progress, endpoint, task, ledger)
            self.assertEqual(len(submissions), 1)
            execute.assert_not_called()

    def test_malformed_local_cumulative_limit_never_submits_a_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            r, progress, ledger, task, args, endpoint, submissions = self.fixture(
                directory, [self.manifest()])
            progress.cumulative_limits.pop('testSeconds')
            with self.assertRaises(distributed_root.DistributedDagPending):
                distributed_root.execute(r, args, progress, endpoint, task, ledger)
            self.assertEqual(submissions, [])
            self.assertFalse((progress.path.parent / f'{KEY}.distributed-plan.json').exists())

    def test_native_verdict_retains_distributed_graph_evidence(self):
        progress = SimpleNamespace(usage=lambda: {'workSeconds': 2}, checkpoint='b' * 40,
                                   code_steps=None, code_step_graph={'schema': 'graph', 'state': 'published'})
        current = {'codingAutonomy': {'runs': [{'modelReceipts': [{'state': 'completed'}]}]},
                   'codingCapacity': {'model': 'synthetic'}}
        r = SimpleNamespace(WORKER='ugfrank')
        evidence = autonomous.native_verdict(r, '0001', KEY, {'leaseId': 'lease'}, current,
                                              progress, 'review', 'passed', None)['attemptEvidence']
        self.assertEqual(evidence['codeStepGraph'], {'schema': 'graph', 'state': 'published'})

    def test_root_assembly_uses_the_native_task_publication_branch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = SimpleNamespace(WORKSPACES=root, git=Mock())
            args = SimpleNamespace(task_id='0001', graph_id=KEY)
            adapter = distributed_root.RootAssemblyAdapter(
                runtime, args, Mock(), {'artifacts': []}, Mock(), '/assembly')
            workspace = SimpleNamespace(prepare_worktree=Mock())
            with patch.object(adapter, '_module', side_effect=lambda name: workspace), \
                    patch.object(adapter, '_repository', return_value=root / 'repository.git'):
                target = adapter.prepare({'baseCommit': 'a' * 40})
            self.assertEqual(target, root / f'graph-{KEY}' / 'assembly')
            workspace.prepare_worktree.assert_called_once_with(
                root / 'repository.git', target, 'a' * 40, 'agentx/coding-task-0001')

    def test_stop_after_acceptance_preserves_children_without_local_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            r, progress, ledger, task, args, endpoint, submissions = self.fixture(
                directory, [self.manifest()], stop=True)
            with patch.object(distributed_root.coding_distributed_assembly, 'execute') as execute, \
                    patch.object(autonomous.coding_code_ledger, 'next_step') as local:
                with self.assertRaises(distributed_root.DistributedDagPending):
                    distributed_root.execute(r, args, progress, endpoint, task, ledger)
            self.assertEqual(len(submissions), 1)
            execute.assert_not_called()
            local.assert_not_called()

    def test_accepted_dag_failure_never_enters_mono_host_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            r, progress, ledger, task, args, endpoint, submissions = self.fixture(
                directory, [self.manifest(ready='step-01')])
            with patch.object(distributed_root.coding_distributed_assembly, 'execute', side_effect=OSError('lost adoption ack')), \
                    patch.object(autonomous.coding_code_ledger, 'next_step') as local:
                with self.assertRaises(distributed_root.DistributedDagPending):
                    distributed_root.execute(r, args, progress, endpoint, task, ledger)
            self.assertEqual(len(submissions), 1)
            local.assert_not_called()

    def test_lost_plan_response_replays_byte_identical_durable_intent(self):
        final_graph = {'budget': {'spent': {'workSeconds': 20, 'testSeconds': 4,
            'modelSeconds': 10, 'modelCalls': 2, 'ciSeconds': 0}}}
        with tempfile.TemporaryDirectory() as directory:
            r, progress, ledger, task, args, endpoint, submissions = self.fixture(
                directory, [self.manifest(final=True, graph=final_graph)])
            original = r.request
            lost = [False]
            first_bodies = []
            def request(url, body=None):
                if url.endswith('/code-step-plan') and not lost[0]:
                    lost[0] = True
                    first_bodies.append(json.loads(json.dumps(body)))
                    raise OSError('accepted response lost')
                return original(url, body)
            r.request = request
            with self.assertRaises(distributed_root.DistributedDagPending):
                distributed_root.execute(r, args, progress, endpoint, task, ledger)
            intent = json.loads((progress.path.parent / f'{KEY}.distributed-plan.json').read_text())
            self.assertIsNone(intent['assemblyRequestId'])
            self.assertEqual(intent['rootUsageBeforeDag'],
                {'workSeconds': 5, 'testSeconds': 1, 'modelSeconds': 2, 'modelCalls': 1})
            def assemble(_runtime, _assembly_args, _progress, *, manifest):
                self.write_completion(r)
                return 0
            with patch.object(distributed_root.coding_distributed_assembly, 'execute', side_effect=assemble):
                result = distributed_root.execute(r, args, progress, endpoint, task, ledger)
            self.assertEqual(first_bodies[0], submissions[0])
            self.assertEqual(result['assemblyRequestId'], NEXT_KEY)
            saved = json.loads((progress.path.parent / f'{KEY}.distributed-plan.json').read_text())
            self.assertEqual(saved['assemblyRequestId'], NEXT_KEY)

    def test_native_feedback_replays_the_same_durable_body(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = []
            current = {'codingAutonomy': {'runs': [{'requestId': KEY, 'modelReceipts': [
                {'state': 'completed'}]}]}, 'codingCapacity': {'model': 'synthetic'}}
            def request(url, body=None):
                calls.append((url, body))
                return {} if '/feedback' in url else {'data': {'task': current}}
            r = SimpleNamespace(**vars(runner)); r.request = request
            progress = SimpleNamespace(path=root / f'{KEY}.progress.json', phase='running',
                pr={'url': 'https://github.com/WindriderQc/AgentX/pull/946'}, checkpoint='b' * 40,
                code_steps=None, code_step_graph={'schema': 'graph'}, usage=lambda: {'workSeconds': 3},
                write=Mock(), finish=Mock(), core_recorded=False)
            lease = {'leaseId': 'lease'}
            distributed_root.deliver_native(r, progress, '0001', KEY, lease,
                'review', 'passed', None, 'distributed done', autonomous.native_verdict)
            distributed_root.deliver_native(r, progress, '0001', KEY, lease,
                'review', 'passed', None, 'changed summary is ignored', autonomous.native_verdict)
            feedback = [body for url, body in calls if '/feedback' in url]
            self.assertEqual(len(feedback), 2)
            self.assertEqual(feedback[0], feedback[1])
            self.assertEqual(sum('/worker?' in url for url, _body in calls), 1)


class RunnerOwnedCodeStepTest(unittest.TestCase):
    def fixture(self, directory, *, failed_focused=False, outside=False):
        root = Path(directory)
        workspace = root / 'task-0001'
        workspace.mkdir()
        git(workspace, 'init', '-q')
        git(workspace, 'config', 'user.name', 'Fixture')
        git(workspace, 'config', 'user.email', 'fixture@example.invalid')
        for name, text in {
            'source_one.py': 'ONE = 1\n', 'source_two.py': 'TWO = 2\n', 'outside.py': 'OUTSIDE = 0\n',
            'core/package.json': '{"name":"fixture","version":"1.0.0"}\n',
            'integrations/coding/tests/test_one.py': 'import unittest\n',
            'integrations/coding/tests/test_two.py': 'import unittest\n',
        }.items():
            path = workspace / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        git(workspace, 'add', '.')
        git(workspace, 'commit', '-q', '-m', 'base')
        git(workspace, 'branch', '-M', 'main')
        git(workspace, 'update-ref', 'refs/remotes/origin/main', git(workspace, 'rev-parse', 'HEAD'))
        git(workspace, 'checkout', '-q', '-b', 'agentx/coding-task-0001')

        manifest = {'scope': ['source_one.py', 'source_two.py'],
                    'remaining': {'workSeconds': 100, 'modelCalls': 20, 'modelSeconds': 90, 'testSeconds': 90},
                    'limits': {'noProgressSeconds': 100}, 'spent': {}}
        task = {'pipelineId': '0001', 'title': 'Two exact changes', 'spec': 'Update both constants.',
                'status': 'in_progress',
                'automationLease': {'leaseId': 'original', 'dispatchRequestId': KEY},
                'automation': {'verificationProfile': 'agentx-dispatcher-tests/v1'},
                'codingCapacity': {'model': 'synthetic', 'numCtx': 24576},
                'codingAutonomy': {'runs': [{'requestId': KEY, 'pendingInferences': [],
                    'modelReceipts': [{'state': 'completed'}]}]}}
        feedback = []
        def request(url, body=None):
            if '/manifest' in url:
                return {'data': manifest}
            if '/code-step-plan' in url:
                error = RuntimeError('Distributed coding is explicitly disabled in this fixture')
                error.code = 'CODE_STEP_DAG_UNAVAILABLE'
                raise error
            if '/feedback' in url:
                feedback.append(body); return {}
            if '/agent-runtime-config/' in url:
                return {'data': {'lanes': {'coding': {'model': 'synthetic', 'capability': {
                    'agent': {'recommendedStepContext': 24576}}}}}}
            return {'data': {'task': task}}

        home = root / '.home-task-0001'
        calls = []
        def run_worker(_workspace, prompt, _seconds, progress, model=None, read_only=False):
            calls.append({'prompt': prompt, 'read_only': read_only, 'model': model})
            if read_only:
                output = home / 'deliverables' / KEY / 'code-plan.json'
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(json.dumps({'schema': 'agentx.coding-code-plan/v1', 'summary': 'two steps',
                    'steps': [
                        {'id': 'step-01', 'title': 'Change one', 'objective': 'Update the first constant.',
                         'paths': ['source_one.py'], 'testTargets': ['integrations/coding/tests/test_one.py'], 'dependsOn': []},
                        {'id': 'step-02', 'title': 'Change two', 'objective': 'Update the second constant.',
                         'paths': ['source_two.py'], 'testTargets': ['integrations/coding/tests/test_two.py'], 'dependsOn': []},
                    ]}))
                progress.role_drained = True
            elif 'step-01' in prompt.split('Step:\n', 1)[1].split('\nVerified dependency summary:', 1)[0]:
                (workspace / 'source_one.py').write_text('ONE = 10\n')
                if outside:
                    (workspace / 'outside.py').write_text('OUTSIDE = 1\n')
            else:
                (workspace / 'source_two.py').write_text('TWO = 20\n')
            return SimpleNamespace(returncode=0, stdout='done', stderr='')

        test_calls = []
        def supervise(command, _progress=None, **_kwargs):
            test_calls.append(command)
            focused = '--runTestsByPath' in command or (command[:3] == ['python3', '-m', 'unittest']
                       and 'discover' not in command)
            return SimpleNamespace(returncode=1 if failed_focused and focused else 0, stdout='', stderr='failed')

        r = SimpleNamespace(**vars(runner))
        r.request = request; r.WORKSPACES = root; r.git = git
        r.install_dependencies = Mock(); r.dependency_state = Mock(return_value='same')
        r.worker_home = Mock(return_value=home); r.run_worker = run_worker
        r.sandbox = lambda _workspace, _home, command, **_kwargs: command
        r.supervise = supervise; r.begin_publication = Mock(return_value=True)
        return r, workspace, feedback, calls, test_calls

    def test_active_root_prefers_distributed_coordinator_before_any_local_step(self):
        with tempfile.TemporaryDirectory() as directory:
            r, _workspace, _feedback, calls, _test_calls = self.fixture(directory)
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            distributed = {'completion': {'headCommit': 'b' * 40}, 'assemblyRequestId': NEXT_KEY,
                           'graph': {'schema': 'agentx.code-step-graph-summary/v1'}}
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(distributed_root, 'execute', return_value=distributed) as coordinate, \
                    patch.object(distributed_root, 'finalize', return_value=0) as finalize, \
                    patch.object(autonomous.coding_code_ledger, 'next_step') as local:
                self.assertEqual(autonomous.execute(
                    r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 0)
            self.assertEqual([call['read_only'] for call in calls], [True])
            coordinate.assert_called_once()
            finalize.assert_called_once()
            local.assert_not_called()

    def test_two_steps_get_fresh_sessions_focused_tests_commits_and_one_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, calls, test_calls = self.fixture(directory)
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            with patch.dict('os.environ', {'GH_TOKEN': 'synthetic'}), \
                    patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_publication, 'publish', return_value={'url': 'https://example.invalid/pr/1'}) as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 0)
            self.assertEqual([call['read_only'] for call in calls], [True, False, False])
            self.assertTrue(all(call['model'] == 'synthetic' for call in calls))
            self.assertEqual(len(test_calls), 3)
            self.assertEqual(test_calls[0][-1], 'integrations/coding/tests/test_one.py')
            self.assertEqual(test_calls[1][-1], 'integrations/coding/tests/test_two.py')
            self.assertIn('discover', test_calls[2])
            self.assertEqual(git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '2')
            publish.assert_called_once()
            steps = feedback[0]['attemptEvidence']['codeSteps']
            self.assertEqual(steps['counts'], {'pending': 0, 'running': 0, 'passed': 2, 'failed': 0})
            self.assertTrue(all(row.get('commit') and row['tests'][0]['outcome'] == 'passed' for row in steps['steps']))

    def test_planner_preserves_an_implementation_call_reserve(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, _, calls, _ = self.fixture(directory)
            manifest = r.request('/manifest')['data']
            manifest['remaining']['modelCalls'] = autonomous.IMPLEMENTATION_CALL_RESERVE
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            progress.carry(manifest)
            r.MODEL = 'synthetic'
            with self.assertRaisesRegex(RuntimeError, 'planning and implementation'):
                autonomous._prepare_ledger(r, workspace, '0001', KEY, {}, manifest, progress,
                    autonomous.coding_code_steps.step_budget(None), None)
            self.assertEqual(progress.stop_reason, 'model_call_limit')
            self.assertEqual(calls, [])
            progress.model_calls = progress.call_limit()
            self.assertEqual(autonomous._session_budget(progress, 1)[0], 0)
            progress.model_calls -= 1
            self.assertEqual(autonomous._session_budget(progress, 4)[0], 1)

    def test_continuation_before_first_plan_can_replan_but_not_replace_a_lost_index(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, _, calls, _ = self.fixture(directory)
            manifest = {**r.request('/manifest')['data'],
                        'continuationCheckpoint': git(workspace, 'rev-parse', 'HEAD'),
                        'parentRequestId': KEY}
            progress = runner.coding_progress.Progress('0001', NEXT_KEY, receipts=Path(directory))
            progress.carry(manifest); r.MODEL = 'synthetic'
            original_worker = r.run_worker
            def next_planner(*args, **kwargs):
                result = original_worker(*args, **kwargs)
                old = r.worker_home(workspace) / 'deliverables' / KEY / 'code-plan.json'
                new = r.worker_home(workspace) / 'deliverables' / NEXT_KEY / 'code-plan.json'
                new.parent.mkdir(parents=True, exist_ok=True); new.write_text(old.read_text())
                return result
            r.run_worker = next_planner
            _, ledger, root_request = autonomous._prepare_ledger(
                r, workspace, '0001', NEXT_KEY, {}, manifest, progress,
                autonomous.coding_code_steps.step_budget(None), None)
            self.assertEqual(root_request, NEXT_KEY)
            self.assertEqual(len(ledger['steps']), 2)
            self.assertEqual(len(calls), 1)

            index = autonomous._index_path(progress, '0001')
            index.unlink()
            (Path(directory) / f'{KEY}.code-steps.json').write_text('{}')
            another = runner.coding_progress.Progress('0001', NEXT_KEY, receipts=Path(directory))
            another.carry(manifest)
            with self.assertRaisesRegex(autonomous.coding_code_ledger.CodeLedgerError, 'index'):
                autonomous._prepare_ledger(r, workspace, '0001', NEXT_KEY, {}, manifest, another,
                    autonomous.coding_code_steps.step_budget(None), None)

    def test_hallucinated_missing_test_is_rejected_before_writable_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, calls, _ = self.fixture(directory)
            original_worker = r.run_worker
            def hallucinating_planner(*args, **kwargs):
                result = original_worker(*args, **kwargs)
                if kwargs.get('read_only'):
                    path = r.worker_home(workspace) / 'deliverables' / KEY / 'code-plan.json'
                    plan = json.loads(path.read_text())
                    plan['steps'][0]['testTargets'] = ['integrations/coding/tests/test_hallucinated.py']
                    path.write_text(json.dumps(plan))
                return result
            r.run_worker = hallucinating_planner
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertEqual([call['read_only'] for call in calls], [True])
            self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['runner_error'])
            publish.assert_not_called()

    def test_failed_focused_test_preserves_private_stash_and_never_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, calls, _ = self.fixture(directory, failed_focused=True)
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            with patch.dict('os.environ', {'GH_TOKEN': 'synthetic'}), \
                    patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertEqual(git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '0')
            self.assertIn('Unverified runner-owned step-01', git(workspace, 'stash', 'list'))
            self.assertEqual(len(calls), 2)
            publish.assert_not_called()
            steps = feedback[0]['attemptEvidence']['codeSteps']
            self.assertEqual(steps['counts'], {'pending': 1, 'running': 0, 'passed': 0, 'failed': 1})
            self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['tests_failed'])
            calls_before_resume = len(calls)
            resumed = runner.coding_progress.Progress('0001', NEXT_KEY, receipts=Path(directory))
            continuation = {'continuationCheckpoint': git(workspace, 'rev-parse', 'HEAD'),
                            'scope': ['source_one.py', 'source_two.py'], 'correction': {'kind': 'local_tests'}}
            store, ledger, root_request = autonomous._prepare_ledger(
                r, workspace, '0001', NEXT_KEY, {}, continuation, resumed,
                autonomous.coding_code_steps.step_budget(None), None)
            self.assertEqual(root_request, KEY)
            self.assertEqual(autonomous.coding_code_ledger.next_step(ledger)['id'], 'step-01')
            self.assertEqual(autonomous.coding_code_ledger.next_step(store.load())['attempts'], 1)
            self.assertEqual(len(calls), calls_before_resume)

    def test_out_of_step_edit_isolated_without_a_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, _, _ = self.fixture(directory, outside=True)
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertEqual(git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '0')
            self.assertFalse(git(workspace, 'status', '--porcelain'))
            publish.assert_not_called()
            self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['code_step_scope_changed'])

    def test_dependency_change_isolated_before_tests_or_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, calls, test_calls = self.fixture(directory)
            manifest = r.request('/manifest')['data']
            manifest['scope'].append('core/package.json')
            original_worker = r.run_worker
            def dependency_worker(_workspace, prompt, seconds, progress, model=None, read_only=False):
                if read_only:
                    result = original_worker(_workspace, prompt, seconds, progress, model=model, read_only=True)
                    plan_path = r.worker_home(workspace) / 'deliverables' / KEY / 'code-plan.json'
                    plan = json.loads(plan_path.read_text())
                    plan['steps'][0]['paths'] = ['core/package.json']
                    plan_path.write_text(json.dumps(plan))
                    return result
                calls.append({'prompt': prompt, 'read_only': False, 'model': model})
                (workspace / 'core/package.json').write_text('{"name":"fixture","version":"2.0.0"}\n')
                return SimpleNamespace(returncode=0, stdout='changed dependency', stderr='')
            r.run_worker = dependency_worker
            r.dependency_state = lambda _workspace: (workspace / 'core/package.json').read_text()
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertEqual(git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '0')
            self.assertFalse(git(workspace, 'status', '--porcelain'))
            self.assertEqual(test_calls, [])
            publish.assert_not_called()
            self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['dependencies_changed'])

    def test_worker_exception_leaves_failed_ledger_clean_branch_and_resumable_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, calls, _ = self.fixture(directory)
            original_worker = r.run_worker
            def crashing_worker(_workspace, prompt, seconds, progress, model=None, read_only=False):
                if read_only:
                    return original_worker(_workspace, prompt, seconds, progress, model=model, read_only=True)
                (workspace / 'source_one.py').write_text('ONE = 99\n')
                raise OSError('synthetic harness loss')
            r.run_worker = crashing_worker
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertFalse(git(workspace, 'status', '--porcelain'))
            self.assertEqual(git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '0')
            self.assertEqual(progress.checkpoint, git(workspace, 'rev-parse', 'HEAD'))
            self.assertEqual(feedback[0]['attemptEvidence']['codeSteps']['counts']['failed'], 1)
            self.assertIn('Unverified runner-owned step-01', git(workspace, 'stash', 'list'))
            publish.assert_not_called()

    def test_lost_failure_ledger_reply_still_cleans_the_assembly_branch(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, _, _ = self.fixture(directory, failed_focused=True)
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            original = autonomous.coding_code_ledger.CodeStepLedger.record_failure
            lost = [False]
            def lost_reply(store, *args, **kwargs):
                result = original(store, *args, **kwargs)
                if not lost[0]:
                    lost[0] = True
                    raise OSError('synthetic lost failure acknowledgement')
                return result
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_code_ledger.CodeStepLedger, 'record_failure', lost_reply), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertFalse(git(workspace, 'status', '--porcelain'))
            self.assertIn('Unverified runner-owned step-01', git(workspace, 'stash', 'list'))
            self.assertEqual(feedback[0]['attemptEvidence']['codeSteps']['counts']['failed'], 1)
            publish.assert_not_called()

    def test_lost_start_ledger_reply_closes_the_running_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, calls, _ = self.fixture(directory)
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            original = autonomous.coding_code_ledger.CodeStepLedger.start
            lost = [False]
            def lost_reply(store, *args, **kwargs):
                result = original(store, *args, **kwargs)
                if not lost[0]:
                    lost[0] = True
                    raise OSError('synthetic lost start acknowledgement')
                return result
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_code_ledger.CodeStepLedger, 'start', lost_reply), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertFalse(git(workspace, 'status', '--porcelain'))
            self.assertEqual([call['read_only'] for call in calls], [True])
            self.assertEqual(feedback[0]['attemptEvidence']['codeSteps']['counts']['failed'], 1)
            publish.assert_not_called()

    def test_lost_verified_ledger_reply_is_adopted_without_a_duplicate_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, _, _ = self.fixture(directory)
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            original = autonomous.coding_code_ledger.CodeStepLedger.record_verified
            lost = [False]
            def lost_reply(store, *args, **kwargs):
                result = original(store, *args, **kwargs)
                if not lost[0]:
                    lost[0] = True
                    raise OSError('synthetic lost ledger acknowledgement')
                return result
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_code_ledger.CodeStepLedger, 'record_verified', lost_reply), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertEqual(git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '1')
            self.assertFalse(git(workspace, 'status', '--porcelain'))
            steps = feedback[0]['attemptEvidence']['codeSteps']
            self.assertEqual(steps['counts'], {'pending': 1, 'running': 0, 'passed': 1, 'failed': 0})
            self.assertEqual(progress.checkpoint, git(workspace, 'rev-parse', 'HEAD'))
            publish.assert_not_called()

    def test_index_failure_after_verified_step_is_reconciled_to_the_new_head(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, _, _ = self.fixture(directory)
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            base = git(workspace, 'rev-parse', 'HEAD')
            original = autonomous._write_index
            failed = [False]
            def flaky_index(runner_value, progress_value, task_id, root_request_id, ledger, head):
                if head != base and not failed[0]:
                    failed[0] = True
                    raise OSError('synthetic index persistence loss')
                return original(runner_value, progress_value, task_id, root_request_id, ledger, head)
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous, '_write_index', side_effect=flaky_index), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            head = git(workspace, 'rev-parse', 'HEAD')
            self.assertNotEqual(head, base)
            self.assertFalse(git(workspace, 'status', '--porcelain'))
            self.assertEqual(json.loads(autonomous._index_path(progress, '0001').read_text())['head'], head)
            self.assertEqual(feedback[0]['attemptEvidence']['codeSteps']['counts']['passed'], 1)
            publish.assert_not_called()

    def test_focused_test_cannot_rewrite_a_new_untracked_planned_file(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, calls, _ = self.fixture(directory)
            r.request('/manifest')['data']['scope'].append('new_source.py')
            original_worker = r.run_worker
            def new_file_worker(_workspace, prompt, seconds, progress, model=None, read_only=False):
                if read_only:
                    result = original_worker(_workspace, prompt, seconds, progress, model=model, read_only=True)
                    path = r.worker_home(workspace) / 'deliverables' / KEY / 'code-plan.json'
                    plan = json.loads(path.read_text())
                    plan['steps'] = [plan['steps'][0]]
                    plan['steps'][0]['paths'] = ['new_source.py']
                    path.write_text(json.dumps(plan))
                    return result
                calls.append({'prompt': prompt, 'read_only': False, 'model': model})
                (workspace / 'new_source.py').write_text('VALUE = 1\n')
                return SimpleNamespace(returncode=0, stdout='new file', stderr='')
            r.run_worker = new_file_worker
            def mutating_test(command, _progress=None, **_kwargs):
                if command[:3] == ['python3', '-m', 'unittest'] and 'discover' not in command:
                    (workspace / 'new_source.py').write_text('VALUE = 2\n')
                return SimpleNamespace(returncode=0, stdout='', stderr='')
            r.supervise = mutating_test
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertEqual(git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '0')
            self.assertFalse(git(workspace, 'status', '--porcelain'))
            self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['tests_failed'])
            publish.assert_not_called()

    def test_focused_test_cannot_add_an_executable_bit_to_step_source(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, _, _ = self.fixture(directory)
            def chmod_test(command, _progress=None, **_kwargs):
                if command[:3] == ['python3', '-m', 'unittest'] and 'discover' not in command:
                    os.chmod(workspace / 'source_one.py', 0o755)
                return SimpleNamespace(returncode=0, stdout='', stderr='')
            r.supervise = chmod_test
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertEqual(git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '0')
            self.assertFalse(git(workspace, 'status', '--porcelain'))
            self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['tests_failed'])
            publish.assert_not_called()

    def test_full_verification_cannot_leave_untracked_source_in_the_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, feedback, _, _ = self.fixture(directory)
            original_supervise = r.supervise
            def mutating_full_test(command, progress=None, **kwargs):
                result = original_supervise(command, progress, **kwargs)
                if command[:3] == ['python3', '-m', 'unittest'] and 'discover' in command:
                    (workspace / 'untracked_by_full_test.py').write_text('MUTATED = True\n')
                return result
            r.supervise = mutating_full_test
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_publication, 'publish') as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
            self.assertEqual(git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '2')
            self.assertFalse(git(workspace, 'status', '--porcelain'))
            self.assertIn('Unverified runner-owned full-verification', git(workspace, 'stash', 'list'))
            self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['tests_failed'])
            publish.assert_not_called()

    def test_full_verification_failure_or_exception_still_cleans_mutated_source(self):
        for outcome in ('failed', 'exception'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                r, workspace, feedback, _, _ = self.fixture(directory)
                original_supervise = r.supervise
                def mutating_full_test(command, progress=None, **kwargs):
                    if command[:3] == ['python3', '-m', 'unittest'] and 'discover' in command:
                        (workspace / 'untracked_by_failed_full_test.py').write_text('MUTATED = True\n')
                        if outcome == 'exception':
                            raise OSError('synthetic test launcher loss')
                        return SimpleNamespace(returncode=1, stdout='', stderr='failed')
                    return original_supervise(command, progress, **kwargs)
                r.supervise = mutating_full_test
                progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
                with patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                        patch.object(autonomous.coding_publication, 'publish') as publish:
                    self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), progress), 1)
                self.assertEqual(git(workspace, 'rev-list', '--count', 'origin/main..HEAD'), '2')
                self.assertFalse(git(workspace, 'status', '--porcelain'))
                self.assertIn('Unverified runner-owned full-verification', git(workspace, 'stash', 'list'))
                expected = 'tests_failed' if outcome == 'failed' else 'runner_error'
                self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], [expected])
                publish.assert_not_called()

if __name__ == '__main__': unittest.main()
