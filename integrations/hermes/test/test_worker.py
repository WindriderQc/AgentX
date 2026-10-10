import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import worker


class WorkerTests(unittest.TestCase):
    def test_refinement_copies_fixed_settings_and_prioritizes_them_over_brief_and_history(self):
        settings = {'profile': 'quality', 'width': 2048, 'height': 1152}
        query = worker.query({'action': 'plan', 'request': {'prompt': 'A square 1024x1024 scene', **settings},
                              'history': [{'role': 'assistant', 'content': 'Use another format'}]})
        self.assertIn('Fixed request settings (copy these JSON values unchanged into your result): ' + json.dumps(settings), query)
        self.assertIn('take priority over any recipe or resolution mentioned in the brief', query)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        (self.home / 'config.yaml').write_text('{}')
        (self.home / 'workspace').mkdir()
        binary = self.home / 'fake-hermes'
        binary.write_text('#!/usr/bin/env python3\n'
                          'import json,sys,pathlib\n'
                          'raw=sys.stdin.read()\n'
                          'pathlib.Path("query").write_text(raw)\n'
                          'p=json.loads(raw.split("evidence:\\n",1)[1])\n'
                          'counter=pathlib.Path("count")\n'
                          'counter.write_text(str(int(counter.read_text())+1) if counter.exists() else "1")\n'
                          'print(json.dumps({"type":"system","subtype":"init","model":"fixture"}))\n'
                          'print(json.dumps({"type":"result","exit_code":0,"text":"fixture plan","session_id":"fixture-session"}))\n')
        binary.chmod(0o700)
        self.env = {**os.environ, 'IMAGEX_HOME': str(self.home), 'HERMES_BIN': str(binary)}

    def tearDown(self):
        self.temp.cleanup()

    def call(self, payload):
        process = subprocess.run([sys.executable, str(ROOT / 'worker.py')], input=json.dumps(payload, ensure_ascii=False, separators=(',', ':')),
                                 capture_output=True, text=True, env=self.env, timeout=10)
        return process.returncode, json.loads(process.stdout)

    def test_plan_replay_uses_identical_result_without_another_inference(self):
        request = {'action': 'plan', 'request': {'prompt': 'A lake'}, 'actionKey': 'a' * 64}
        code, first = self.call(request)
        self.assertEqual(code, 0)
        self.assertEqual(first['model'], 'fixture')
        self.assertEqual(self.call({**request, 'status': {'profiles': ['changed']}}), (0, first))
        self.assertEqual((self.home / 'workspace/count').read_text(), '1')
        code, changed = self.call({**request, 'request': {'prompt': 'A mountain'}})
        self.assertEqual(code, 1)
        self.assertFalse(changed['ok'])
        self.assertEqual((self.home / 'workspace/count').read_text(), '1')

    def test_profile_lock_refuses_concurrent_consultation(self):
        with (self.home / '.worker.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, result = self.call({'action': 'consult', 'prompt': 'A lake'})
        self.assertEqual(code, 1)
        self.assertIn('busy', result['error'])
        self.assertFalse((self.home / 'workspace/count').exists())

    def test_invalid_identity_is_refused_before_inference(self):
        code, result = self.call({'action': 'plan', 'request': {'prompt': 'A lake'}, 'actionKey': '../escape'})
        self.assertEqual(code, 1)
        self.assertFalse(result['ok'])
        self.assertFalse((self.home / 'workspace/count').exists())

    def test_long_brief_constraints_and_terminal_marker_reach_the_fixture_and_replay_once(self):
        manifest = {'version': 1, 'items': [{'id': 'fixture-title', 'kind': 'exact-text', 'text': 'École & façade\n💡'}]}
        suffix = worker.protected_suffix(manifest)
        original = 'Synthetic visual description. ' * 350 + 'TERMINAL_SENTINEL'
        prompt = original + '\n\n' + suffix
        request = {'action': 'plan', 'request': {'prompt': prompt, 'constraints': manifest, 'instruction': 'Keep intent'}, 'actionKey': 'b' * 64}
        code, result = self.call(request)
        self.assertEqual(code, 0)
        query = (self.home / 'workspace/query').read_text()
        evidence = json.loads(query.split('evidence:\n', 1)[1])
        self.assertEqual(evidence['request']['prompt'], prompt)
        self.assertEqual(evidence['request']['constraints'], manifest)
        self.assertIn('at most 8000 UTF-16 code units INCLUDING', query)
        self.assertIn(f'visual description is {8000 - worker.utf16_length(suffix) - 2} UTF-16 code units', query)
        self.assertEqual(self.call(request), (0, result))
        self.assertEqual((self.home / 'workspace/count').read_text(), '1')

    def test_emoji_boundaries_count_utf16_units_and_refuse_before_a_fixture_launch(self):
        self.assertEqual(worker.utf16_length('💡'), 2)
        self.assertEqual(self.call({'action': 'consult', 'prompt': '💡' * 16000})[0], 0)
        code, result = self.call({'action': 'consult', 'prompt': '💡' * 16000 + 'x'})
        self.assertEqual(code, 1)
        self.assertIn('Invalid image expert request', result['error'])
        self.assertEqual((self.home / 'workspace/count').read_text(), '1')

    def test_composed_brief_and_ecmascript_trim_share_the_core_boundary(self):
        manifest = {'version': 1, 'items': [{'id': 'title', 'kind': 'exact-text', 'text': 'Titre'}]}
        suffix = worker.protected_suffix(manifest)
        visual = 'x' * (32000 - worker.utf16_length(suffix) - 2)
        for trim in ('\ufeff', '\u00a0', '\u2028', '\u3000'):
            payload = {'action': 'consult', 'prompt': 'Question', 'context': {'prompt': trim + visual, 'constraints': manifest}}
            self.assertIn(visual, worker.query(payload))
        with self.assertRaisesRegex(ValueError, 'constraints exceed 32000'):
            worker.query({'action': 'plan', 'request': {'prompt': visual + 'x', 'constraints': manifest}})
        with self.assertRaisesRegex(ValueError, 'Invalid image expert request'):
            worker.query({'action': 'consult', 'prompt': '\ufeff'})

    def test_large_complete_history_rows_fit_without_a_32000_per_row_rejection(self):
        history = [{'role': 'user', 'content': 'Old brief. ' + 'x' * 34000 + 'OLD_TAIL'}, {'role': 'assistant', 'content': 'Old reply'}]
        payload = {'action': 'consult', 'prompt': 'Question', 'history': history}
        self.assertEqual(json.loads(worker.query(payload).split('evidence:\n', 1)[1])['history'], history)

    def test_exact_transport_unit_boundary_is_checked_before_a_fixture_launch(self):
        payload = {'action': 'consult', 'prompt': 'Question', 'history': [{'role': 'user', 'content': ''}, {'role': 'assistant', 'content': 'Reply'}]}
        overhead = worker.utf16_length(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
        payload['history'][0]['content'] = 'x' * (60000 - overhead)
        self.assertEqual(self.call(payload)[0], 0)
        payload['history'][0]['content'] += 'x'
        code, result = self.call(payload)
        self.assertEqual(code, 1)
        self.assertIn('envelope exceeds 60000', result['error'])
        self.assertEqual((self.home / 'workspace/count').read_text(), '1')

    def test_exact_utf8_json_boundary_cjk_and_escaping_remain_bounded(self):
        payload = {'action': 'consult', 'prompt': '界' * 20000, 'context': {'prompt': ''}}
        overhead = len(json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        payload['context']['prompt'] = 'x' * (65536 - overhead)
        self.assertIn('界', worker.query(payload))
        payload['context']['prompt'] += 'x'
        with self.assertRaisesRegex(ValueError, '65536 JSON bytes'):
            worker.query(payload)
        with self.assertRaisesRegex(ValueError, 'envelope exceeds'):
            worker.query({'action': 'consult', 'prompt': 'START' + '\x00' * 12000 + 'END'})
        self.assertFalse((self.home / 'workspace/count').exists())

    def test_lone_surrogate_and_overlong_context_or_instruction_refuse_before_spawn(self):
        payloads = [
            {'action': 'consult', 'prompt': 'bad\ud800'},
            {'action': 'consult', 'prompt': 'Question', 'context': {'prompt': '💡' * 16000 + 'x'}},
            {'action': 'plan', 'request': {'prompt': 'A scene', 'instruction': '💡' * 16000 + 'x'}},
            {'action': 'consult', 'prompt': 'Question', 'history': [{'role': 'user', 'content': 'bad\udc00'}]}
        ]
        for payload in payloads:
            with self.assertRaises(ValueError):
                worker.query(payload)
        self.assertFalse((self.home / 'workspace/count').exists())

    def test_streamed_operations_preserve_result_and_exclude_tool_arguments_and_output(self):
        binary = Path(self.env['HERMES_BIN'])
        binary.write_text('#!/usr/bin/env python3\nimport json,sys\nsys.stdin.read()\n'
                          'for e in [{"type":"system","subtype":"init","model":"fixture"},'
                          '{"type":"tool_use","name":"skill_view","input":{"secret":"PRIVATE"}},'
                          '{"type":"tool_result","name":"skill_view","output":"PRIVATE","duration_ms":3},'
                          '{"type":"result","exit_code":0,"text":"Advice"}]:print(json.dumps(e),flush=True)\n')
        process = subprocess.run([sys.executable, str(ROOT / 'worker.py'), '--events'],
                                 input=json.dumps({'action': 'consult', 'prompt': 'A lake'}),
                                 capture_output=True, text=True, env=self.env, timeout=10)
        self.assertEqual(process.returncode, 0)
        self.assertNotIn('PRIVATE', process.stdout)
        events = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual([row['type'] for row in events], ['started', 'tool_use', 'tool_result', 'result'])
        self.assertEqual(events[-1]['result']['text'], 'Advice')

    def test_profile_disclosures_allow_only_selected_fields_and_contained_files(self):
        (self.home / 'config.yaml').write_text(json.dumps({'model': {'default': 'fixture:free', 'provider': 'openrouter',
                                                                      'api_key': 'SECRET'}, 'auxiliary': {'free_only': True}}))
        (self.home / 'SOUL.md').write_text('Image specialist')
        code, result = self.call({'action': 'describe'})
        self.assertEqual(code, 0)
        self.assertEqual(result['routing']['model'], 'fixture:free')
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertEqual(self.call({'action': 'resource', 'id': 'identity'})[1]['resource']['content'], 'Image specialist')
        self.assertEqual(self.call({'action': 'resource', 'id': '../config.yaml'})[0], 1)
        (self.home / 'SOUL.md').unlink()
        (self.home / 'SOUL.md').symlink_to('/etc/hostname')
        self.assertFalse(self.call({'action': 'resource', 'id': 'identity'})[1]['resource']['available'])
        self.assertFalse((self.home / 'workspace/count').exists())


if __name__ == '__main__':
    unittest.main()
