import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

runner = load('coding_run')
control = load('coding_dispatch_control')
completion = load('coding_distributed_completion')
KEY = '11111111-2222-4333-8444-555555555555'
CHILD = '22222222-3333-4444-8555-666666666666'
ASSEMBLY = '33333333-4444-4555-8666-777777777777'
HEAD, SOURCE = 'a' * 40, 'b' * 40
TIME = '2026-10-22T12:00:00.000Z'


def task_fixture():
    step = {'id': 'step-01', 'title': 'Implement pair', 'objective': 'Change the reviewed behavior',
            'paths': ['src.py', 'test_src.py'], 'testTargets': ['test_src.py'], 'dependsOn': []}
    call = {'callId': '44444444-5555-4666-8777-888888888888', 'model': 'local-model',
            'state': 'completed', 'startedAt': TIME, 'finishedAt': TIME,
            'settlement': {'outcome': 'completed', 'finishedAt': TIME}}
    published = {'headCommit': HEAD, 'tests': [{'outcome': 'passed'}],
        'publication': {'headCommit': HEAD, 'url': 'https://github.com/example/repository/pull/1',
                        'state': 'published'}}
    return {'pipelineId': '0001', 'automationLease': {'dispatchRequestId': KEY, 'leaseId': 'synthetic'},
        'codingCapacity': {'requestId': KEY, 'model': 'local-model'},
        'codingAutonomy': {'basis': 'c' * 64, 'runs': [{'requestId': KEY, 'sourceCommit': SOURCE,
            'pendingInferences': [], 'modelReceipts': []}]},
        'codeStepDag': {'rootRequestId': KEY, 'state': 'published', 'sourceCommit': SOURCE, 'planFingerprint': 'd' * 64,
            'authority': {'taskBasis': 'c' * 64}, 'coordination': {'assemblyRequestId': ASSEMBLY},
            'plan': {'schema': 'normalized', 'sourceSchema': 'agentx.coding-code-plan/v1',
                     'summary': 'Reviewed pair', 'steps': [step]},
            'steps': [{'id': 'step-01', 'state': 'verified', 'attempts': [{'requestId': CHILD,
                'pendingInferences': [], 'modelReceipts': [call]}]}],
            'assembly': {'adoptions': [{'stepId': 'step-01'}], 'completion': published}}}


class CompletionTest(unittest.TestCase):
    def fixture(self, root):
        task = task_fixture()
        graph = {'graphId': KEY, 'state': 'published', 'planFingerprint': 'd' * 64,
                 'assembly': {'publication': {'headCommit': HEAD}}, 'budget': {'spent': {
            'workSeconds': 10, 'testSeconds': 2, 'modelSeconds': 3, 'modelCalls': 1}}}
        intent = {'schema': 'agentx.distributed-code-plan-intent/v1', 'taskId': '0001',
            'rootRequestId': KEY, 'sourceCommit': SOURCE, 'assemblyRequestId': ASSEMBLY,
            'rootUsageBeforeDag': {'workSeconds': 1, 'testSeconds': 0, 'modelSeconds': 0, 'modelCalls': 0},
            'plan': {'schema': 'agentx.coding-code-plan/v1', 'summary': 'Reviewed pair',
                     'steps': task['codeStepDag']['plan']['steps']}}
        values = {KEY + '.distributed-plan.json': intent,
            KEY + '.json': {'requestId': KEY, 'pipelineId': '0001', 'autonomous': True},
            KEY + '.progress.json': {'requestId': KEY, 'pipelineId': '0001', 'phase': 'finished',
                                     'result': 'verified', 'coreRecorded': False},
            ASSEMBLY + '.distributed-assembly.json': {'state': 'terminal',
                'identity': {'graphId': KEY, 'requestId': ASSEMBLY, 'sourceCommit': SOURCE, 'planFingerprint': 'd' * 64},
                'completion': task['codeStepDag']['assembly']['completion']}}
        for name, value in values.items():
            control.atomic_json(root / name, value)
        requests = []
        def request(url, body=None):
            requests.append((url, copy.deepcopy(body)))
            if '/worker?' in url:
                return {'data': {'task': task}}
            if url.endswith('/coding-autonomy'):
                return {'data': {'tasks': [{'pipelineId': '0001', 'codeStepGraph': graph}]}}
            if url.endswith('/feedback'):
                return {'alreadyRecorded': True}
            raise AssertionError('No launch or inference endpoint may be used: ' + url)
        r = SimpleNamespace(**vars(runner))
        r.REPOSITORY, r.CORE, r.RECEIPTS, r.request = 'example/repository', 'http://core.test', root, request
        r.coding_dispatch_control = control
        return r, task, requests

    def test_completed_child_proves_work_without_fabricating_a_planner_call(self):
        task = task_fixture()
        calls = completion.settled_calls(task, KEY)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['ownerRequestId'], CHILD)
        self.assertEqual(task['codingAutonomy']['runs'][0]['modelReceipts'], [])
        del task['codingAutonomy']['runs'][0]['modelReceipts']
        self.assertEqual(completion.settled_calls(task, KEY), calls)

    def test_embedded_assembly_does_not_finish_its_root_before_feedback(self):
        assembly = runner.coding_autonomous.coding_distributed_root.coding_distributed_assembly
        args = SimpleNamespace(task_id='0001', request_id=ASSEMBLY, graph_id=KEY,
                               executor_id='coordinator', manifest_fingerprint='f' * 64)
        progress = SimpleNamespace(finish=mock.Mock(), set_stage=mock.Mock(), write=mock.Mock())
        with mock.patch.object(assembly, 'validate_manifest', return_value={}), \
                mock.patch.object(assembly, 'AssemblyWorker') as worker:
            worker.return_value.execute.return_value = {'headCommit': HEAD, 'state': 'verified'}
            assembly.execute(runner, args, progress, manifest={}, adapter=mock.Mock(), finish_progress=False)
        progress.finish.assert_not_called()
        progress.set_stage.assert_called_once_with('checkpoint')
        progress.write.assert_called_once()

    def test_unknown_calls_wrong_model_binding_and_unpublished_graph_refuse(self):
        for kind in ('pending', 'unknown', 'settlement', 'model', 'root', 'head', 'tests', 'adoption', 'basis'):
            with self.subTest(kind=kind):
                task = task_fixture(); dag = task['codeStepDag']; attempt = dag['steps'][0]['attempts'][0]
                call = attempt['modelReceipts'][0]
                if kind == 'pending': attempt['pendingInferences'] = ['unresolved']
                if kind == 'unknown': call['state'] = 'unknown'
                if kind == 'settlement': call['settlement']['finishedAt'] = 'different'
                if kind == 'model': call['model'] = 'other-model'
                if kind == 'root': dag['rootRequestId'] = CHILD
                if kind == 'head': dag['assembly']['completion']['publication']['headCommit'] = SOURCE
                if kind == 'tests': dag['assembly']['completion']['tests'][0]['outcome'] = 'failed'
                if kind == 'adoption': dag['assembly']['adoptions'] = []
                if kind == 'basis': dag['authority']['taskBasis'] = 'changed'
                with self.assertRaises(ValueError): completion.settled_calls(task, KEY)

    def test_same_published_receipts_produce_one_exact_verdict_without_execution(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(control, 'unit_active', return_value=False):
            root = Path(directory); r, task, requests = self.fixture(root)
            before = copy.deepcopy(task)
            first = completion.recover(r, '0001', KEY)
            second = completion.recover(r, '0001', KEY)
            self.assertEqual(first, second)
            self.assertEqual(first['status'], 'done')
            self.assertEqual(first['attemptEvidence']['routing']['requestCount'], 1)
            self.assertEqual(first['attemptEvidence']['routing']['effectiveModel'], 'local-model')
            self.assertEqual(task, before)
            self.assertTrue(all(body is None for _, body in requests))
            self.assertEqual(json.loads((root / (KEY + '.progress.json')).read_text())['coreRecorded'], False)

    def test_changed_local_publication_cannot_create_a_verdict(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(control, 'unit_active', return_value=False):
            root = Path(directory); r, _, _ = self.fixture(root)
            path = root / (ASSEMBLY + '.distributed-assembly.json')
            value = json.loads(path.read_text()); value['completion']['headCommit'] = SOURCE
            control.atomic_json(path, value)
            with self.assertRaises(ValueError): completion.recover(r, '0001', KEY)
            self.assertFalse((root / (KEY + '.verdict.json')).exists())

    def test_lost_feedback_ack_replays_frozen_verdict_and_never_restarts(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(control, 'unit_active', return_value=False):
            root = Path(directory); r, _, requests = self.fixture(root)
            read = r.request; sent = []
            def request(url, body=None):
                if url.endswith('/feedback'):
                    sent.append(copy.deepcopy(body))
                    if len(sent) == 1: raise RuntimeError('committed response lost')
                    return {}
                return read(url, body)
            r.request = request
            with mock.patch.object(control, 'RECEIPTS', root), mock.patch.object(control, 'CORE', r.CORE), \
                    mock.patch.object(control, 'load_runner', return_value=r), \
                    mock.patch.object(control, 'start_worker') as launch:
                with self.assertRaisesRegex(RuntimeError, 'response lost'): control.reconcile('0001', KEY)
                control.reconcile('0001', KEY)
                launch.assert_not_called()
            self.assertEqual(len(sent), 2)
            self.assertEqual(sent[0], sent[1])
            self.assertEqual(len(requests), 2)
            progress = json.loads((root / (KEY + '.progress.json')).read_text())
            self.assertEqual((progress['phase'], progress['result'], progress['coreRecorded']),
                             ('finished', 'review', True))


if __name__ == '__main__':
    unittest.main()
