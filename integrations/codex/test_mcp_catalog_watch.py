import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from mcp_catalog_watch import Journal, read_catalog, refresh_once, revision_url


def tool(name, description=None):
    return {'name': name, 'description': description or name, 'inputSchema': {'type': 'object'}}


class NativeConfig:
    """Synthetic native CAS/reload contract, with no model or live chat."""
    def __init__(self, servers):
        self.servers = copy.deepcopy(servers)
        self.version = 1
        self.calls = []
        self.lose_write_reply = False
        self.lose_reload_reply = False
        self.conflict = False

    def rpc(self, method, params):
        self.calls.append((method, params))
        if method == 'config/read':
            return {'config': {'mcp_servers': copy.deepcopy(self.servers)}, 'origins': {
                f'mcp_servers.{name}.url': {
                    'name': {'type': 'user', 'file': '/synthetic/config.toml'},
                    'version': str(self.version),
                } for name in self.servers
            }}
        if method == 'config/batchWrite':
            if self.conflict or params['expectedVersion'] != str(self.version):
                raise RuntimeError('concurrent configuration write')
            for edit in params['edits']:
                name = edit['keyPath'].split('.')[1]
                self.servers[name]['url'] = edit['value']
            self.version += 1
            if self.lose_write_reply:
                self.lose_write_reply = False
                raise ConnectionError('write response lost')
            return {'status': 'ok'}
        if method == 'config/mcpServer/reload':
            if self.lose_reload_reply:
                self.lose_reload_reply = False
                raise ConnectionError('reload response lost')
            return {}
        raise AssertionError(f'unexpected native action: {method}')


class WatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = Journal(Path(self.temp.name) / 'state.json')
        self.catalogues = {'/general': [tool('shared')], '/owner': [tool('owner')]}
        self.requests = []
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                message = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                path = urlsplit(self.path).path
                test.requests.append((path, message, self.headers['X-Service-Caller']))
                test.assertEqual(message['method'], 'tools/list')
                index = int(message.get('params', {}).get('cursor', 0))
                tools = test.catalogues[path]
                result = {'tools': tools[index:index + 1]}
                if index + 1 < len(tools):
                    result['nextCursor'] = str(index + 1)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'id': message['id'], 'result': result}).encode())

        self.http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        base = f'http://127.0.0.1:{self.http.server_port}'
        self.native = NativeConfig({
            'agentx': {'url': base + '/general', 'http_headers': {'x-service-caller': 'general-client'},
                       'enabled_tools': ['shared'], 'tool_timeout_sec': 300},
            'agentx-owner': {'url': base + '/owner', 'http_headers': {'x-service-caller': 'owner-client'}},
            'unrelated': {'url': 'http://unrelated.invalid/mcp'},
        })
        self.names = ['agentx', 'agentx-owner']

    def refresh(self, **kwargs):
        return refresh_once(self.native, self.names, self.journal, **kwargs)

    def count(self, method):
        return sum(name == method for name, _ in self.native.calls)

    def test_discovers_additions_changes_and_removals_without_reloading_unchanged_buses(self):
        original = copy.deepcopy(self.native.servers)
        self.assertEqual(self.refresh(), 2)
        self.assertEqual(self.count('config/mcpServer/reload'), 1)
        self.assertEqual(self.refresh(), 0)
        self.assertEqual(self.count('config/mcpServer/reload'), 1)
        general_url = self.native.servers['agentx']['url']
        for tools in [[tool('owner'), tool('new_tool')], [tool('owner', 'changed')], []]:
            self.catalogues['/owner'] = tools
            self.assertEqual(self.refresh(), 1)
            edit = next(params for method, params in reversed(self.native.calls) if method == 'config/batchWrite')
            self.assertEqual([entry['keyPath'] for entry in edit['edits']], ['mcp_servers.agentx-owner.url'])
            self.assertEqual(self.native.servers['agentx']['url'], general_url)
        for name in self.names:
            for key, value in original[name].items():
                if key != 'url':
                    self.assertEqual(self.native.servers[name][key], value)
        self.assertEqual(self.native.servers['unrelated'], original['unrelated'])
        self.assertTrue(all(caller == ('general-client' if path == '/general' else 'owner-client')
                            for path, _, caller in self.requests))

    def test_metadata_order_does_not_refresh_but_schema_changes_do(self):
        self.refresh()
        self.catalogues['/owner'] = [dict(reversed(list(tool('owner').items())))]
        self.assertEqual(self.refresh(), 0)
        self.catalogues['/owner'][0]['inputSchema']['additionalProperties'] = False
        self.assertEqual(self.refresh(), 1)

    def test_failed_bus_keeps_its_catalogue_and_does_not_block_the_other_bus(self):
        self.refresh()
        original = self.native.servers['agentx-owner']['url']
        self.catalogues['/general'].append(tool('new_shared'))

        def fetch(server):
            if urlsplit(server['url']).path == '/owner':
                raise ConnectionError('upstream unavailable')
            return read_catalog(server)

        with self.assertRaises(RuntimeError):
            self.refresh(fetch=fetch)
        self.assertEqual(self.native.servers['agentx-owner']['url'], original)
        self.assertEqual(self.count('config/mcpServer/reload'), 2)

    def test_lost_write_and_reload_responses_reconcile_without_repeating_a_write(self):
        for failure in ['lose_write_reply', 'lose_reload_reply']:
            with self.subTest(failure=failure):
                self.catalogues['/owner'].append(tool(failure))
                setattr(self.native, failure, True)
                with self.assertRaises(ConnectionError):
                    self.refresh()
                writes = self.count('config/batchWrite')
                self.assertTrue(self.journal.pending())
                self.assertEqual(self.refresh(), 0)
                self.assertFalse(self.journal.pending())
                self.assertEqual(self.count('config/batchWrite'), writes)

    def test_concurrent_configuration_edit_is_preserved(self):
        original = copy.deepcopy(self.native.servers)
        self.native.conflict = True
        with self.assertRaises(RuntimeError):
            self.refresh()
        self.assertEqual(self.native.servers, original)
        self.native.conflict = False
        self.assertEqual(self.refresh(), 2)

    def test_url_revision_preserves_other_query_values_and_rejects_other_transports(self):
        updated = revision_url('https://example.invalid/mcp?a=one&catalog_revision=old&empty=', 'new')
        self.assertEqual(parse_qs(urlsplit(updated).query, keep_blank_values=True),
                         {'a': ['one'], 'empty': [''], 'catalog_revision': ['new']})
        with self.assertRaises(ValueError):
            revision_url('file:///mcp', 'new')

    def test_partial_pagination_never_replaces_a_catalogue(self):
        from unittest.mock import patch

        class Reply:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _):
                return json.dumps({'id': 'wrong', 'result': {'tools': []}}).encode()

        with patch('mcp_catalog_watch.urlopen', return_value=Reply()):
            with self.assertRaises(RuntimeError):
                read_catalog(self.native.servers['agentx-owner'])
        self.assertEqual(self.count('config/batchWrite'), 0)


if __name__ == '__main__':
    unittest.main()
