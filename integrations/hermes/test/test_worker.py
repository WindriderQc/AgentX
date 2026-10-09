import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        (self.home / 'config.yaml').write_text('{}')
        (self.home / 'workspace').mkdir()
        binary = self.home / 'fake-hermes'
        binary.write_text('#!/usr/bin/env python3\n'
                          'import json,sys,pathlib\n'
                          'p=json.loads(sys.stdin.read().split("evidence:\\n",1)[1])\n'
                          'counter=pathlib.Path("count")\n'
                          'counter.write_text(str(int(counter.read_text())+1) if counter.exists() else "1")\n'
                          'print(json.dumps({"type":"system","subtype":"init","model":"fixture"}))\n'
                          'print(json.dumps({"type":"result","exit_code":0,"text":"fixture plan","session_id":"fixture-session"}))\n')
        binary.chmod(0o700)
        self.env = {**os.environ, 'IMAGEX_HOME': str(self.home), 'HERMES_BIN': str(binary)}

    def tearDown(self):
        self.temp.cleanup()

    def call(self, payload):
        process = subprocess.run([sys.executable, str(ROOT / 'worker.py')], input=json.dumps(payload),
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
