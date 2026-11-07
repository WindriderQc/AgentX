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
from unittest.mock import Mock, patch

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


class ResourceReceiptTest(unittest.TestCase):
    """Synthetic only: no driver, no /proc of a real CUDA process, no GPU."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        (self.root / 'nodes.json').write_text('{}')
        self.args = types.SimpleNamespace(root=str(self.root), state=str(self.root / 'state'),
            object_info=str(self.root / 'nodes.json'), child_port=8189, gpu=1, reserve_vram=1.2, vram_sample_ms=0)
        self.worker = module.Worker(self.args)
        self.job_id = str(uuid.uuid4())
        self.child = self.worker.child = Mock(pid=4242)
        self.child.poll.return_value = None
        self.worker.call = Mock(return_value={'queue_running': [], 'queue_pending': []})

    def tearDown(self):
        self.worker.log.close()
        self.tmp.cleanup()

    def terminal(self, job_id, start=1_000, end=61_500, event='execution_success'):
        status = {'status_str': 'success', 'completed': True,
            'messages': [['execution_start', {'prompt_id': job_id, 'timestamp': start}],
                ['execution_cached', {'nodes': [], 'prompt_id': job_id, 'timestamp': start}],
                [event, {'prompt_id': job_id, 'timestamp': end}]]}
        self.worker.write_record(self.worker.record_path(job_id), {'jobId': job_id, 'terminal': {'status': status, 'outputs': {}}})

    def test_ram_peak_reads_only_the_kernel_high_water_mark_of_the_exact_child(self):
        with patch.object(module.pathlib.Path, 'read_text', autospec=True, return_value='Name:\tpython\nVmRSS:\t  900 kB\nVmHWM:\t 2048 kB\n') as read:
            self.assertEqual(self.worker.process_ram_peak(4242), {'method': 'linux-proc-vmhwm', 'scope': 'cuda-child-process',
                'status': 'measured', 'peakKiB': 2048})
        self.assertEqual(str(read.call_args.args[0]), '/proc/4242/status')
        for text, status in [('VmHWM:\t 20 MB\n', 'invalid'), ('VmHWM:\t -5 kB\n', 'invalid'), ('Name:\tpython\n', 'unavailable')]:
            with patch.object(module.pathlib.Path, 'read_text', return_value=text):
                self.assertEqual(self.worker.process_ram_peak(4242)['status'], status)
        with patch.object(module.pathlib.Path, 'read_text', side_effect=FileNotFoundError()):
            self.assertEqual(self.worker.process_ram_peak(4242)['reason'], 'process status unreadable')

    def test_vram_sample_counts_only_the_child_pid_on_the_bound_gpu(self):
        with patch.object(module.subprocess, 'check_output', return_value='111, 20000\n4242, 15360\n') as query:
            self.assertEqual(self.worker.process_vram(4242), ('matched', 15360))
        self.assertIn('-i', query.call_args.args[0]); self.assertIn('1', query.call_args.args[0])
        cases = [('111, 20000\n', ('absent', None)), ('4242, [N/A]\n', ('invalid', None)), ('4242, -3\n', ('invalid', None)), ('', ('absent', None))]
        for raw, expected in cases:
            with patch.object(module.subprocess, 'check_output', return_value=raw):
                self.assertEqual(self.worker.process_vram(4242), expected)
        for error in [FileNotFoundError(), module.subprocess.TimeoutExpired('nvidia-smi', 5), module.subprocess.CalledProcessError(9, 'nvidia-smi')]:
            with patch.object(module.subprocess, 'check_output', side_effect=error):
                self.assertEqual(self.worker.process_vram(4242), ('failed', None))

    def test_execution_time_uses_comfy_timestamps_and_rejects_invalid_ones(self):
        self.terminal(self.job_id)
        self.assertEqual(self.worker.execution_ms(self.job_id), 60_500)
        other = str(uuid.uuid4())
        self.terminal(other, end=900)
        self.assertIsNone(self.worker.execution_ms(other))
        self.terminal(other, start=True, end=5)
        self.assertIsNone(self.worker.execution_ms(other))
        self.terminal(other, event='execution_interrupted', end=2_000)
        self.assertEqual(self.worker.execution_ms(other), 1_000)
        self.assertIsNone(self.worker.execution_ms(str(uuid.uuid4())))

    def test_release_receipt_is_returned_and_kept_without_changing_terminal_proof(self):
        self.worker.track(100.0)
        lifetime = self.worker.lifetime
        lifetime.job_ids.append(self.job_id)
        lifetime.record('matched', 9000, 101.0); lifetime.record('failed', None, 102.0); lifetime.record('matched', 15360, 103.0)
        self.terminal(self.job_id)
        before = self.worker.history(self.job_id)
        self.worker.process_ram_peak = Mock(return_value={'method': 'linux-proc-vmhwm', 'scope': 'cuda-child-process', 'status': 'measured', 'peakKiB': 30_000_000})
        receipt = self.worker.free()['resources']
        self.worker.process_ram_peak.assert_called_once_with(4242)
        self.child.terminate.assert_called_once(); self.child.wait.assert_called_once_with(timeout=40)
        self.assertIsNone(self.worker.child); self.assertIsNone(self.worker.lifetime)
        self.assertEqual(receipt['contract'], 'agentx.image-worker-resources/v1')
        self.assertEqual(receipt['child']['jobIds'], [self.job_id])
        self.assertEqual(receipt['child']['spawnedAtMs'], 100_000)
        self.assertEqual(receipt['ram']['peakKiB'], 30_000_000)
        self.assertEqual(receipt['vram'], {'method': 'nvidia-smi-compute-apps', 'scope': 'cuda-child-process', 'intervalMs': 0,
            'samples': {'attempted': 3, 'matched': 2, 'absent': 0, 'failed': 1, 'invalid': 0}, 'status': 'sampled', 'bound': 'lower',
            'observedMaxMiB': 15360, 'observedMaxAtMs': 103_000, 'firstMatchedAtMs': 101_000, 'lastMatchedAtMs': 103_000})
        self.assertEqual(receipt['jobs'], [{'jobId': self.job_id, 'executionMs': 60_500}])
        stored = json.loads(self.worker.record_path(self.job_id).read_text())
        self.assertEqual(stored['resources'], receipt)
        self.assertEqual(self.worker.history(self.job_id), before)

    def test_unfinished_work_keeps_measuring_and_releases_nothing(self):
        self.worker.track(100.0)
        lifetime = self.worker.lifetime
        self.worker.call.return_value = {'queue_running': [['live']], 'queue_pending': []}
        with self.assertRaises(RuntimeError):
            self.worker.free()
        self.assertIs(self.worker.lifetime, lifetime)
        self.assertFalse(lifetime.stop.is_set())
        self.child.terminate.assert_not_called()

    def test_a_child_that_exits_early_reports_no_ram_figure_but_keeps_its_samples(self):
        self.worker.track(100.0)
        self.worker.lifetime.job_ids.append(self.job_id)
        self.worker.lifetime.record('matched', 7000, 101.0)
        self.child.poll.return_value = 1
        receipt = self.worker.free()['resources']
        self.assertEqual(receipt['ram']['status'], 'unavailable')
        self.assertNotIn('peakKiB', receipt['ram'])
        self.assertEqual(receipt['vram']['observedMaxMiB'], 7000)
        self.assertEqual(receipt['jobs'], [{'jobId': self.job_id, 'executionMs': None}])
        self.assertEqual(self.worker.free(), {})

    def test_unavailable_vram_says_why(self):
        reasons = []
        for interval, outcomes in [(0, []), (1, []), (1, ['failed', 'failed']), (1, ['failed', 'absent', 'invalid'])]:
            lifetime = module.ChildLifetime(4242, 1.0, 2.0, 1.2, interval)
            for outcome in outcomes:
                lifetime.record(outcome, None, 3.0)
            vram = lifetime.vram()
            self.assertEqual(vram['status'], 'unavailable'); self.assertNotIn('observedMaxMiB', vram)
            reasons.append(vram['reason'])
        self.assertEqual(reasons, ['sampling disabled', 'no sample taken', 'driver query failed', 'child process not listed by the driver'])

    def test_concurrent_samples_are_all_counted_and_the_sampler_stops_before_release(self):
        lifetime = module.ChildLifetime(4242, 1.0, 2.0, 1.2, 0.2)
        threads = [threading.Thread(target=lambda i=i: [lifetime.record('matched', i * 100 + n, 10.0 + n) for n in range(50)]) for i in range(8)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(lifetime.samples['attempted'], 400); self.assertEqual(lifetime.vram()['observedMaxMiB'], 749)
        self.worker.args.vram_sample_ms = 200
        self.worker.sample_interval = 0.2
        sampled = threading.Event()
        def reading(pid):
            sampled.set()
            return ('matched', 4096)
        self.worker.process_vram = reading
        self.worker.process_ram_peak = Mock(return_value={'status': 'measured', 'peakKiB': 1})
        self.worker.track(100.0)
        thread = self.worker.lifetime.thread
        self.assertTrue(sampled.wait(5))
        receipt = self.worker.free()['resources']
        self.assertFalse(thread.is_alive())
        self.assertEqual(receipt['vram']['observedMaxMiB'], 4096)
        self.assertEqual(receipt['vram']['intervalMs'], 200)

    def test_submission_lists_each_job_of_the_same_child(self):
        self.worker.start = Mock()
        self.worker.current_reserve = 1.2  # Same reserve: the running child is kept.
        self.worker.lifetime = module.ChildLifetime(4242, 1.0, 2.0, 1.2, 0)
        second = str(uuid.uuid4())
        self.worker.call = Mock(side_effect=[{'queue_running': [], 'queue_pending': []}, {'prompt_id': self.job_id},
            {'queue_running': [], 'queue_pending': []}, {'prompt_id': second}])
        self.worker.submit({'prompt_id': self.job_id, 'prompt': {}})
        self.worker.submit({'prompt_id': second, 'prompt': {}})
        self.assertEqual(self.worker.lifetime.job_ids, [self.job_id, second])


if __name__ == '__main__':
    unittest.main()
