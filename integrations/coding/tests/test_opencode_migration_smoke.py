import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
import urllib.error
import urllib.request

SPEC = importlib.util.spec_from_file_location('opencode_smoke', Path(__file__).resolve().parents[1] / 'opencode_migration_smoke.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class SyntheticProviderTest(unittest.TestCase):
    def setUp(self):
        self.provider = module.Provider()
        self.thread = threading.Thread(target=self.provider.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.provider.release.set()
        self.provider.shutdown()
        self.provider.server_close()
        self.thread.join(5)

    def request(self, body, path='/v1/chat/completions'):
        request = urllib.request.Request(f'http://127.0.0.1:{self.provider.server_port}{path}',
            data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        return urllib.request.urlopen(request, timeout=3)

    def test_provider_cannot_forward_to_a_model_or_arbitrary_route(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request({'model': 'not-the-alias', 'messages': []})
        self.assertEqual(error.exception.code, 500)
        self.assertEqual(self.provider.requests, [])
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request({}, path='/v1/other')
        self.assertEqual(error.exception.code, 404)

    def test_tools_are_deterministic_and_finish_after_three_results(self):
        tools = [{'function': {'name': n}} for n in ('read', 'edit', 'bash')]
        self.provider.release.set()
        for count, expected in enumerate(('read', 'edit', 'bash', None)):
            body = {'model': 'agentx-primary', 'tools': tools,
                    'messages': [{'role': 'tool', 'content': 'synthetic result'}] * count}
            with self.request(body) as response:
                chunks = [json.loads(line[6:]) for line in response.read().decode().splitlines()
                          if line.startswith('data: {')]
            delta = chunks[0]['choices'][0]['delta']
            if expected:
                self.assertEqual(delta['tool_calls'][0]['function']['name'], expected)
            else:
                self.assertEqual(delta['content'], 'MIGRATION_EDIT_TEST_OK')
        self.assertFalse(self.provider.failures)

    def test_disposable_environment_excludes_host_tokens_and_mcp(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {
            'OPENAI_API_KEY': 'synthetic-secret', 'ANTHROPIC_API_KEY': 'synthetic-secret',
            'OPENCODE_CONFIG': '/host/private-config', 'AGENTX_LLM_CODING_TEAM_TOKEN': 'synthetic-secret',
        }):
            env = module.isolated_env(Path(directory), 1234)
        self.assertFalse(set(env) & {'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_CONFIG', 'AGENTX_LLM_CODING_TEAM_TOKEN'})
        self.assertNotIn('synthetic-secret', json.dumps(env))
        config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
        self.assertEqual(config['enabled_providers'], ['agentx-core'])
        self.assertEqual(config['small_model'], 'agentx-core/agentx-primary')
        self.assertEqual(config['plugin'], [])
        self.assertEqual(config['provider']['agentx-core']['options']['baseURL'], 'http://127.0.0.1:1234/v1')


if __name__ == '__main__':
    unittest.main()
