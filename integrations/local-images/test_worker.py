import importlib.util
import json
import pathlib
import tempfile
import types
import unittest
import uuid
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('worker', pathlib.Path(__file__).with_name('worker.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.nodes = self.root / 'nodes.json'
        self.nodes.write_text('{}')
        self.args = types.SimpleNamespace(root=str(self.root), state=str(self.root / 'state'),
            object_info=str(self.nodes), child_port=8189, gpu=0)
        self.worker = module.Worker(self.args)
        self.job_id = str(uuid.uuid4())

    def tearDown(self):
        self.worker.log.close()
        self.tmp.cleanup()

    def test_duplicate_submission_never_reaches_the_cuda_child_twice(self):
        self.worker.start = Mock()
        self.worker.call = Mock(side_effect=[{'queue_running': [], 'queue_pending': []}, {'prompt_id': self.job_id}])
        data = {'prompt_id': self.job_id, 'prompt': {}}
        self.assertEqual(self.worker.submit(data)['prompt_id'], self.job_id)
        with self.assertRaises(FileExistsError):
            self.worker.submit(data)
        self.assertEqual(self.worker.start.call_count, 1)
        self.assertEqual(self.worker.call.call_count, 2)

    def test_terminal_proof_survives_worker_recreation_without_the_prompt(self):
        self.worker.child = Mock()
        self.worker.child.poll.return_value = None
        terminal = {'status': {'status_str': 'success', 'completed': True},
            'outputs': {'save': {'images': [{'filename': 'original.png', 'subfolder': 'agentx', 'type': 'output'}]}},
            'prompt': ['private source graph']}
        self.worker.call = Mock(return_value={self.job_id: terminal})
        self.assertNotIn('prompt', self.worker.history(self.job_id)[self.job_id])
        recreated = module.Worker(self.args)
        try:
            result = recreated.history(self.job_id)
            self.assertEqual(result[self.job_id]['outputs'], terminal['outputs'])
            self.assertFalse(recreated.running())
        finally:
            recreated.log.close()

    def test_free_refuses_unfinished_work_and_waits_for_its_exact_child(self):
        child = self.worker.child = Mock()
        child.poll.return_value = None
        self.worker.call = Mock(return_value={'queue_running': [['live']], 'queue_pending': []})
        with self.assertRaises(RuntimeError):
            self.worker.free()
        child.terminate.assert_not_called()
        self.worker.call.return_value = {'queue_running': [], 'queue_pending': []}
        self.worker.free()
        child.terminate.assert_called_once()
        child.wait.assert_called_once_with(timeout=40)
        self.assertIsNone(self.worker.child)

    def test_missing_original_proof_never_claims_a_terminal_result(self):
        file = self.worker.record_path(self.job_id)
        file.write_text(json.dumps({'dispatchStarted': True}))
        self.assertEqual(self.worker.history(self.job_id), {})
        with self.assertRaises(ValueError):
            self.worker.history('../outside')


if __name__ == '__main__':
    unittest.main()
