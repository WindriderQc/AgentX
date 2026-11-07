import copy
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

from integrations.coding.tests.test_coding_opencode_sessions import load, native_database, KEY, SID, MID, PID

events, history, progress_module, saving = [load(name) for name in
    ('coding_opencode_events', 'coding_opencode_history', 'coding_progress', 'coding_report_save')]


class NativeEventsTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home, self.workspace, self.receipts = [self.root / x for x in ('home', 'workspace', 'receipts')]
        for p in (self.home, self.workspace, self.receipts): p.mkdir()
        subprocess.run(['git', '-C', str(self.workspace), 'init', '-q'], check=True)
        self.clock = [0]
        self.progress = progress_module.Progress('0001', KEY, receipts=self.receipts, now=lambda: self.clock[0])
        self.progress.phase = 'running'; self.progress.baseline(self.home, self.workspace)
        history.atomic(self.receipts / (KEY + '.json'), {'pipelineId': '0001', 'requestId': KEY})
        self.runner = SimpleNamespace(RECEIPTS=self.receipts, worker_home=lambda _: self.home,
            coding_harness=SimpleNamespace(selected=lambda: 'opencode'))
        self.before = saving.snapshot(self.runner, self.workspace, KEY)
        self.progress.begin_step(8, 120, f'/home/agent/deliverables/{KEY}/step-01.json')
        self.capture = history.Capture(self.progress, self.home, self.workspace, read_only=True)
        self.capture.value['nativeSessionId'] = SID; history.atomic(self.capture.path, self.capture.value)
        self.part = {'id': PID, 'type': 'tool', 'tool': 'bash', 'callID': 'native-call',
            'state': {'status': 'pending', 'input': {'command': 'python3 -m unittest test_calculator.py'}}}
        self.connection = native_database(self.home, directory=f'/home/agent/deliverables/{KEY}', messages=[{
            'info': {'id': MID, 'role': 'assistant'}, 'parts': [self.part,
                {'id': PID + 'z', 'type': 'reasoning', 'text': 'SYNTHETIC PRIVATE REASONING'}]}])
        self.addCleanup(self.connection.close)
        self.progress.native_history = events.Observer(self.capture)

    def update(self, status, output=None, code=None):
        self.part['state']['status'] = status
        if output is not None: self.part['state']['output'] = output
        if code is not None: self.part['state']['metadata'] = {'exit': code}
        self.connection.execute('UPDATE part SET data=? WHERE id=?', (json.dumps(self.part), PID))
        self.connection.commit()

    def capsule(self):
        return saving.capsule(self.runner, self.workspace, self.before, KEY, 'step-01.json')

    def test_live_pending_running_and_completed_test_are_observed_once_without_billing(self):
        self.progress.observe(self.home, self.workspace)
        self.assertIsNone(self.progress.current_test)
        self.clock[0] = 1; self.update('running')
        self.progress.observe(self.home, self.workspace)
        self.assertEqual(self.progress.current_test, 'unittest')
        self.assertEqual(self.progress.stage, 'test')
        self.clock[0] = 4; self.update('completed', 'OK', 0)
        self.progress.observe(self.home, self.workspace)
        self.assertEqual(self.progress.last_test, {'name': 'unittest', 'outcome': 'passed'})
        activity = self.progress.last_activity
        self.clock[0] = 50; self.progress.observe(self.home, self.workspace)
        self.assertEqual(self.progress.last_activity, activity)
        self.assertEqual(self.progress.model_calls, 0)
        self.assertEqual(len(self.progress.seen_tests), 1)
        self.assertNotIn('SYNTHETIC PRIVATE', self.progress.path.read_text())

    def test_no_exit_metadata_does_not_manufacture_a_passing_test(self):
        self.update('completed', 'launched')
        self.progress.observe(self.home, self.workspace)
        self.assertEqual(self.progress.last_test['outcome'], 'unknown')

    def test_native_nonzero_exit_and_masked_failure_are_not_success(self):
        self.update('completed', 'FAILED (failures=1)', 1)
        self.progress.observe(self.home, self.workspace)
        self.assertEqual(self.progress.last_test['outcome'], 'failed')

    def test_native_abort_or_launcher_exit_stays_unknown(self):
        for code in (-9, 124, 130):
            with self.subTest(code=code):
                self.progress.native_history = events.Observer(self.capture)
                self.update('completed', 'OK', code)
                self.progress.observe(self.home, self.workspace)
                self.assertEqual(self.progress.last_test['outcome'], 'unknown')

    def test_output_limit_stops_only_the_current_bounded_step(self):
        self.connection.execute('UPDATE message SET data=? WHERE id=?',
            (json.dumps({'role': 'assistant', 'finish': 'length'}), MID)); self.connection.commit()
        self.progress.observe(self.home, self.workspace)
        self.assertEqual(self.progress.step_due(), 'model_output_limit')
        self.assertIsNone(self.progress.stop_reason)

    def test_mutated_call_identity_refuses_instead_of_pairing_another_result(self):
        self.update('running'); self.progress.observe(self.home, self.workspace)
        self.part['callID'] = 'different-call'; self.update('completed', 'OK', 0)
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.progress.observe(self.home, self.workspace)

    def test_capsule_uses_host_bound_call_result_and_excludes_reasoning(self):
        self.update('completed', 'read source evidence', 0); self.capture.finish(0)
        before_bytes = history.database(self.home).read_bytes()
        capsule = self.capsule()
        self.assertEqual(capsule['session'], SID)
        self.assertEqual(capsule['invocationId'], self.capture.value['invocationId'])
        self.assertEqual(capsule['pairs'][0]['callId'], 'native-call')
        self.assertEqual(capsule['pairs'][0]['partId'], PID)
        self.assertEqual(capsule['pairs'][0]['content'][0]['text'], 'read source evidence')
        self.assertNotIn('SYNTHETIC PRIVATE', json.dumps(capsule))
        self.assertEqual(history.database(self.home).read_bytes(), before_bytes)

    def test_previous_invocation_and_inflight_or_uncertain_tools_cannot_fund_save(self):
        for state in ('running', 'uncertain'):
            self.capture.value['state'] = state; history.atomic(self.capture.path, self.capture.value)
            with self.assertRaises(ValueError): self.capsule()
        self.capture.finish(0)
        with self.assertRaises(ValueError): self.capsule()  # Pending native tool.
        self.update('completed', 'evidence', 0)
        self.before = saving.snapshot(self.runner, self.workspace, KEY)
        with self.assertRaisesRegex(ValueError, 'uniquely'): self.capsule()

    def test_wrong_step_output_or_workspace_cannot_supply_research(self):
        self.update('completed', 'evidence', 0); self.capture.finish(0)
        with self.assertRaisesRegex(ValueError, 'drained report step'):
            saving.capsule(self.runner, self.workspace, self.before, KEY, 'step-02.json')
        self.capture.value['workspace'] = str(self.root)
        history.atomic(self.capture.path, self.capture.value)
        with self.assertRaisesRegex(ValueError, 'another workspace'): self.capsule()

    def test_multiple_new_invocations_are_not_resolved_by_recency(self):
        self.update('completed', 'evidence', 0); self.capture.finish(0)
        history.Capture(self.progress, self.home, self.workspace, read_only=True)
        with self.assertRaisesRegex(ValueError, 'uniquely'): self.capsule()

    def test_native_snapshot_without_exact_request_refuses(self):
        with self.assertRaises(ValueError): saving.snapshot(self.runner, self.workspace)

    def test_completed_native_result_cannot_be_rewritten_after_observation(self):
        self.update('completed', 'OK', 0); self.progress.observe(self.home, self.workspace)
        self.update('completed', 'FAILED', 1)
        with self.assertRaisesRegex(ValueError, 'completed native tool result changed'):
            self.progress.observe(self.home, self.workspace)

    def test_new_binding_cannot_reuse_an_earlier_logical_session_as_new_research(self):
        self.update('completed', 'evidence', 0); self.capture.finish(0)
        self.before = saving.snapshot(self.runner, self.workspace, KEY)
        another = history.Capture(self.progress, self.home, self.workspace, read_only=True)
        another.value['nativeSessionId'] = SID; another.finish(0)
        with self.assertRaisesRegex(ValueError, 'earlier native logical session'): self.capsule()

    def test_native_reader_does_not_fall_back_to_dsh_history(self):
        p = self.home / '.dsh/progress-sessions/fake/session.jsonl'; p.parent.mkdir(parents=True)
        p.write_text(json.dumps({'type': 'turn/end', 'data': {'reason': {'kind': 'max-tokens'}}}) + '\n')
        self.progress.observe(self.home, self.workspace)
        self.assertIsNone(self.progress.step_due())


if __name__ == '__main__': unittest.main()
