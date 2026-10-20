import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from integrations.coding.tests.test_coding_report import KEY, load

saving, steps, observer = (load(name) for name in ('coding_report_save', 'coding_report_steps', 'coding_progress'))


def events(session='session-original', cwd=f'/home/agent/deliverables/{KEY}'):
    return [
        {'type': 'session', 'id': session, 'cwd': cwd, 'isSeeded': False, 'delegationDepth': 0},
        {'type': 'assistant/message', 'data': {'reasoning': 'PRIVATE REASONING MUST NOT BE COPIED'}},
        {'type': 'tool/call', 'data': {'turn': 1, 'step': 2, 'callId': 'call-one', 'name': 'read',
                                     'arguments': '{"file_path":"/workspace/config.js"}'}},
        {'type': 'tool/result', 'data': {'turn': 1, 'step': 2, 'message': {'role': 'tool',
            'toolCallId': 'call-one', 'source': {'callId': 'call-one'},
            'content': [{'type': 'text', 'text': '1: RETRY_LIMIT = 7;'}]}}}]


class SavePassTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root/'private-home'; self.home.mkdir()
        self.workspace = self.root/'task-0001'
        self.output = self.home/'deliverables'/KEY/'step-01.json'
        self.output.parent.mkdir(parents=True)
        self.r = SimpleNamespace(worker_home=lambda workspace: self.home, coding_progress=observer,
                                 RECEIPTS=self.root/'receipts', run_worker=mock.Mock(side_effect=self.write_result))
        self.args = SimpleNamespace(request_id=KEY, task_id='0001')
        self.progress = SimpleNamespace(model_calls=16, task_claim_seq=2, report_drained=True, stop_reason=None,
            model_context_size=196608,
            check_stop=mock.Mock(return_value=False), call_limit=lambda: 128, hard_deadline=14400,
            queue_deadline=14400, now=lambda: 0, begin_step=mock.Mock(), end_step=mock.Mock())
        self.status = {'requestId': KEY, 'claimSeq': 2, 'terminationVerified': True, 'pendingInferences': [],
            'state': 'active', 'authority': {'requestId': KEY, 'sourceCommit': 'a'*40}}
        self.settled = mock.Mock(side_effect=lambda *args: self.status)
        self.frozen = {}

    def session(self, name='session-original', version=4, rows=None):
        path = self.home/'.dsh/progress-sessions'/KEY/name/f'session.v{version}.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(json.dumps(row)+'\n' for row in (rows if rows is not None else events(name))))
        return path

    def freeze(self, runner, path, value):
        self.assertNotIn(path, self.frozen)
        self.frozen[path] = copy.deepcopy(value)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def write_result(self, workspace, prompt, seconds, progress, *, read_only):
        self.assertTrue(read_only)
        self.assertIn('FIRST tool action must write', prompt)
        self.assertNotIn('PRIVATE REASONING', prompt)
        self.assertIn('RETRY_LIMIT = 7', prompt)
        progress.model_calls += 2
        self.output.write_text('{"documents":[],"findings":[]}')
        return subprocess.CompletedProcess([], 0)

    def attempt(self, before=None):
        return saving.attempt(self.r, self.args, self.progress, self.workspace, self.output, 1,
            'Original JSON schema and output path.', before or set(), 'a'*40, 'b'*64,
            24576, steps, self.freeze, self.settled)

    def test_saves_same_execution_with_bound_evidence_usage_and_writer_reserve(self):
        path = self.session()
        result, reason = self.attempt()
        self.assertIsNone(reason); self.assertEqual(result, {'documents': [], 'findings': []})
        self.r.run_worker.assert_called_once()
        self.progress.begin_step.assert_called_once_with(4, 900, f'/home/agent/deliverables/{KEY}/step-01.json')
        evidence, intent, outcome = self.frozen.values()
        self.assertEqual(evidence['sessionSha256'], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertNotIn('PRIVATE REASONING', json.dumps(evidence))
        evidence_path = self.r.RECEIPTS/intent['researchRef']
        self.assertEqual(intent['researchSha256'], saving.digest(evidence_path.read_bytes()))
        self.assertEqual((intent['requestId'], intent['step'], intent['claimSeq']), (KEY, 1, 2))
        self.assertEqual(intent['beforeUsage']['modelCalls'], 16)
        self.assertEqual(outcome['modelCalls'], 18)

    def test_new_generation_of_old_session_is_never_reused(self):
        self.session(version=1)
        before = saving.snapshot(self.r, self.workspace)
        self.session(version=4)
        self.assertIsNone(self.attempt(before)[0]); self.r.run_worker.assert_not_called()

    def test_highest_committed_generation_of_exact_new_session_is_used(self):
        self.session(version=1, rows=[{'type': 'not a session'}])
        self.session(version=4)
        self.assertIsNotNone(self.attempt()[0])
        self.assertTrue(next(iter(self.frozen.values()))['session'].endswith('session.v4.jsonl'))

    def test_ambiguous_unrelated_or_cross_home_sessions_cannot_authorize_save(self):
        for case in ('ambiguous', 'unrelated', 'symlink'):
            with self.subTest(case=case):
                with tempfile.TemporaryDirectory(dir=self.root) as folder:
                    self.home = Path(folder)
                    if case == 'ambiguous':
                        self.session(); self.session(name='session-other')
                    elif case == 'unrelated':
                        self.session(rows=events(cwd='/workspace'))
                    else:
                        external = self.root/'external.jsonl'; external.write_text('{}\n')
                        path = self.session(); path.unlink(); path.symlink_to(external)
                    self.assertIsNone(self.attempt()[0])
        self.r.run_worker.assert_not_called()

    def test_mismatched_duplicate_or_incomplete_tool_pairs_fail_closed(self):
        for case in ('wrong-step', 'wrong-source', 'duplicate', 'missing-result', 'torn'):
            with self.subTest(case=case):
                rows = events()
                if case == 'wrong-step': rows[-1]['data']['step'] = 3
                if case == 'wrong-source': rows[-1]['data']['message']['source']['callId'] = 'different'
                if case == 'duplicate': rows.append(rows[2])
                if case == 'missing-result': rows.pop()
                path = self.session(rows=rows)
                if case == 'torn': path.write_bytes(path.read_bytes() + b'{')
                self.assertIsNone(self.attempt()[0])
        self.r.run_worker.assert_not_called()

    def test_existing_invalid_artifact_or_broken_symlink_is_never_overwritten(self):
        self.session()
        self.output.write_text('invalid json')
        self.attempt(); self.assertEqual(self.output.read_text(), 'invalid json')
        self.output.unlink(); self.output.symlink_to(self.root/'missing')
        self.attempt(); self.assertTrue(self.output.is_symlink())
        self.r.run_worker.assert_not_called(); self.settled.assert_not_called()

    def test_uncertain_termination_or_changed_authority_prevents_another_model_call(self):
        self.session()
        for update in ({'terminationVerified': False}, {'pendingInferences': ['pending']},
                       {'claimSeq': 3}, {'state': 'blocked'}, {'authority': {'sourceCommit': 'changed'}}):
            with self.subTest(update=update):
                with mock.patch.dict(self.status, update):
                    self.assertIsNone(self.attempt()[0])
        self.r.run_worker.assert_not_called()

    def test_stop_during_settlement_and_exhausted_reserve_prevent_save(self):
        self.session()
        self.settled.side_effect = lambda *args: (setattr(self.progress, 'stop_reason', 'operator_stop') or self.status)
        self.assertIsNone(self.attempt()[0]); self.r.run_worker.assert_not_called()
        self.progress.stop_reason = None
        self.settled.side_effect = lambda *args: self.status
        self.progress.model_calls = 122
        self.assertIsNone(self.attempt()[0]); self.r.run_worker.assert_not_called()
        self.progress.model_calls = 121
        self.progress.queue_deadline = 481
        self.assertIsNotNone(self.attempt()[0])
        self.progress.begin_step.assert_called_once_with(1, 1, f'/home/agent/deliverables/{KEY}/step-01.json')

    def test_save_intent_without_outcome_is_not_relaunched_after_response_loss(self):
        self.session()
        self.r.run_worker.side_effect = OSError('response lost')
        with self.assertRaises(OSError): self.attempt()
        self.assertIsNone(self.attempt()[0]); self.assertEqual(self.r.run_worker.call_count, 1)

    def test_empty_save_is_not_recursively_retried_and_failed_drain_remains_unverified(self):
        self.session()
        def no_save(*args, **kwargs):
            self.progress.report_drained = False
            return subprocess.CompletedProcess([], 124)
        self.r.run_worker.side_effect = no_save
        value, reason = self.attempt()
        self.assertIsNone(value); self.assertEqual(reason, 'unverified')
        self.r.run_worker.assert_called_once()
        self.assertFalse(list(self.frozen.values())[-1]['drained'])

    def test_capsule_and_prompt_bounds_preserve_whole_pairs_and_disclose_omissions(self):
        pairs = [{'callId': str(i), 'content': 'text' * 120} for i in range(4)]
        with mock.patch.object(saving, 'PROMPT_BYTES', 2300):
            prompt, selected, omitted = saving.save_prompt('brief', pairs)
        self.assertGreater(omitted, 0); self.assertEqual(len(selected) + omitted, len(pairs))
        self.assertIn('Every document must remain partial', prompt)
        for index in selected: self.assertIn(saving.encoded(pairs[index]).decode(), prompt)
        with mock.patch.object(saving, 'TRACE_BYTES', 5):
            self.session(); self.assertIsNone(self.attempt()[0])
        with mock.patch.object(saving, 'RECORD_BYTES', 5):
            self.assertIsNone(self.attempt()[0])
        with mock.patch.object(saving, 'CAPSULE_BYTES', 5):
            self.assertIsNone(self.attempt()[0])
        self.r.run_worker.assert_not_called()

    def test_effective_context_and_harness_output_reserves_bound_total_prompt(self):
        self.session()
        for context in (8192, 24576):
            with self.subTest(context=context):
                self.progress.model_context_size = context
                self.assertIsNone(self.attempt()[0])
        self.r.run_worker.assert_not_called()
        self.progress.model_context_size = None
        self.assertEqual(saving.prompt_limit(self.progress, 24576), 0)
        self.assertEqual(saving.prompt_limit(self.progress, 65536), 28672)
        self.progress.model_context_size = 196608
        self.assertEqual(saving.prompt_limit(self.progress, 8192), 159744)

    def test_first_report_session_remembers_resolved_context_without_changing_lane(self):
        context = load('coding_worker_context')
        self.progress.model_context_size = None
        lanes = {'coding': {'model': 'coder', 'contextSize': 196608}}
        reader = mock.Mock(return_value=lanes)
        self.assertEqual(context.resolve(self.progress, 'coder', reader, remember=True), (196608, lanes))
        self.assertEqual(context.resolve(self.progress, 'coder', reader, remember=True), (196608, None))
        reader.assert_called_once()
        self.assertEqual(lanes['coding']['contextSize'], 196608)

    def test_omitted_research_cannot_establish_reviewed_coverage_or_legacy_ack(self):
        self.session()
        for value in ({'documents': [{'state': 'reviewed'}]}, {'legacyEdits': []}):
            with self.subTest(value=value):
                self.frozen.clear()
                for path in self.r.RECEIPTS.glob('*'): path.unlink()
                self.output.unlink(missing_ok=True)
                def worker(*args, **kwargs):
                    self.output.write_text(json.dumps(value)); return subprocess.CompletedProcess([], 0)
                self.r.run_worker.side_effect = worker
                with mock.patch.object(saving, 'save_prompt', return_value=('save', [0], 1)):
                    result, reason = self.attempt()
                self.assertIsNone(result); self.assertIn('omitted research', reason)


if __name__ == '__main__':
    unittest.main()
