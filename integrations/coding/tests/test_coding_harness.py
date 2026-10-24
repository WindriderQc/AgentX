import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
from unittest import mock
import unittest

HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('coding_harness', HERE / 'coding_harness.py')
harness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(harness)


class HarnessAdapterTest(unittest.TestCase):
    def test_only_runner_owned_source_steps_select_the_implementation_policy(self):
        progress = SimpleNamespace(step={'resultKind': 'source'}, report_mode=False)
        self.assertEqual(harness.implementation_policy(progress),
                         {'max_tokens': 4096, 'reasoning_effort': 'none'})
        self.assertIsNone(harness.implementation_policy(progress, read_only=True))
        progress.report_mode = True
        self.assertIsNone(harness.implementation_policy(progress))
        for step in [None, {}, {'resultKind': 'json'}]:
            self.assertIsNone(harness.implementation_policy(SimpleNamespace(step=step)))
        self.assertIsNone(harness.implementation_policy(None))

    def test_bounded_source_output_preserves_the_frozen_model_and_context(self):
        provider = harness.dsh_patch('local-model', 196608, max_tokens=4096)[0]['config']['providers']['agentx-core']
        self.assertEqual(provider['models'], [{'id': 'local-model', 'maxTokens': 4096, 'contextWindow': 196608}])
        self.assertEqual(harness.dsh_patch('local-model')[0]['config']['providers']['agentx-core']['models'][0]['maxTokens'], 32768)
        for cap in [0, -1, True, '4096', 32769]:
            with self.assertRaisesRegex(RuntimeError, 'output allowance'):
                harness.dsh_patch('local-model', max_tokens=cap)

    def test_dsh_keeps_the_existing_headless_contract(self):
        value = harness.invocation('dsh', '/tmp/prompt', 'local-model', 32768, dsh_root=Path('/reviewed/dsh'))
        self.assertIn('/opt/dsh/node_modules/.bin/dsh', value['command'])
        self.assertIn('/opt/coding/guard.patch.yml', value['command'])
        self.assertEqual(value['binds'], [('/reviewed/dsh', '/opt/dsh')])

    def test_opencode_uses_the_same_relay_and_a_bounded_noninteractive_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir(); (root / 'bin/opencode').write_text('fixture')
            with mock.patch.dict(os.environ, {'AGENTX_OPENCODE_ROOT': directory,
                                               'AGENTX_OPENCODE_ENTRY': 'bin/opencode'}):
                value = harness.invocation('opencode', '/tmp/prompt', 'local-model', 65536, relay_port=9123)
        self.assertEqual(value['binds'], [(str(root), '/opt/harness')])
        self.assertNotIn('/opt/dsh', value['command'])
        self.assertEqual(value['command'][:6], ['python3', '/opt/coding/model_relay.py', 'inside',
                                                '/home/agent/model.sock', '9123', '--'])
        self.assertIn('--auto', value['command']); self.assertIn('--file', value['command'])
        instruction = value['command'].index('Implement the attached task. Follow its instructions exactly.')
        attachment = value['command'].index('--file')
        self.assertLess(instruction, attachment)
        self.assertEqual(value['command'][attachment:], ['--file', '/tmp/prompt'])
        config = json.loads(value['environment']['OPENCODE_CONFIG_CONTENT'])
        self.assertEqual(config['model'], 'agentx-core/local-model')
        self.assertEqual(config['provider']['agentx-core']['options']['baseURL'], 'http://127.0.0.1:9123/v1')
        self.assertEqual(config['permission']['task'], 'deny')
        self.assertEqual(config['permission']['shell'], 'allow')

    def test_unknown_harness_and_escaping_entry_refuse(self):
        with mock.patch.dict(os.environ, {'AGENTX_CODING_HARNESS': 'unknown'}):
            with self.assertRaisesRegex(RuntimeError, 'Unsupported'):
                harness.selected()
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {
                'AGENTX_OPENCODE_ROOT': directory, 'AGENTX_OPENCODE_ENTRY': '../opencode'}):
            with self.assertRaisesRegex(RuntimeError, 'relative executable'):
                harness.opencode_runtime()


if __name__ == '__main__':
    unittest.main()
