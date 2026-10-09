import importlib.util
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
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
            object_info=str(self.nodes), child_port=8189, gpu=0, reserve_vram=1.2)
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

    def test_large_latents_and_edit_references_get_activation_headroom(self):
        graph = {'latent': {'inputs': {'width': 2048, 'height': 2048}}}
        self.assertEqual(self.worker.reserve_for_graph(graph), 4.5)
        graph['latent']['inputs']['height'] = 1152
        self.assertEqual(self.worker.reserve_for_graph(graph), 1.2)
        self.assertEqual(self.worker.reserve_for_graph({'text': {'inputs': {'resolution': 2016}}}), 4.5)

    def test_a_listed_client_is_served_and_an_unlisted_one_is_refused(self):
        def status(allowed):
            server = ThreadingHTTPServer(('127.0.0.1', 0), module.create_handler(self.worker, allowed))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/queue', timeout=5) as r:
                    return r.status
            except urllib.error.HTTPError as error:
                return error.code
            finally:
                server.shutdown()
                server.server_close()
        self.assertEqual(status({'192.0.2.10'}), 403)
        self.assertEqual(status({'192.0.2.10', '127.0.0.1'}), 200)
        self.assertEqual(status(frozenset()), 200)


if __name__ == '__main__':
    unittest.main()
