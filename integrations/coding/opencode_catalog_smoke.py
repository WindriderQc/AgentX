"""CPU-only native OpenCode catalog acceptance; no live model or owner state."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading

from opencode_migration_smoke import Native, require


class CatalogHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        require(self.path == '/v1/models', 'Unexpected discovery endpoint')
        self.server.reads += 1
        self.send_response(503 if self.server.unavailable else 200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        rows = []
        for alias, model, host, context in [
            ('agentx-primary', 'synthetic-chat-a', 'Synthetic GPU', 196608),
            ('agentx-host/cpu', 'synthetic-chat-b', 'Synthetic CPU', 32768),
        ]:
            rows.append({'id': alias, 'agentx': {'selectable': True, 'resolved_model': model,
                'host': {'name': host}, 'context_window': context,
                'capabilities': {'tools': alias == 'agentx-primary', 'reasoning': False}}})
        rows.append({'id': 'synthetic-embedding', 'agentx': {'selectable': False}})
        self.wfile.write(json.dumps({'object': 'list', 'data': rows}).encode())

    def do_POST(self):
        self.server.inference += 1
        self.send_error(405, 'Inference is forbidden in catalog acceptance')


@contextmanager
def catalog():
    server = ThreadingHTTPServer(('127.0.0.1', 0), CatalogHandler)
    server.reads = server.inference = 0
    server.unavailable = False
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def run(binary, expected_version):
    with tempfile.TemporaryDirectory(prefix='opencode-catalog-') as temp, catalog() as server:
        root = Path(temp)
        native = Native(binary, root / 'native', server)
        require(native.cli('--version').strip() == expected_version, 'Unexpected native version')
        cfg = json.loads(native.env['OPENCODE_CONFIG_CONTENT'])
        cfg['plugin'] = [(Path(__file__).parent / 'opencode_core_catalog.mjs').resolve().as_uri()]
        cfg['provider']['agentx-core']['models']['agentx-primary']['limit'] = {'context': 196608, 'output': 4096}
        native.env['OPENCODE_CONFIG_CONTENT'] = json.dumps(cfg)
        with native.server() as request:
            data = request('/provider')
            provider = next(p for p in data['all'] if p['id'] == 'agentx-core')
            require(provider['name'] == 'Passerelle Core', 'Native provider label did not load')
            require(set(provider['models']) == {'agentx-primary', 'agentx-host/cpu'}, 'Wrong native model choices')
            primary, cpu = provider['models']['agentx-primary'], provider['models']['agentx-host/cpu']
            require(primary['name'] == 'synthetic-chat-a · Synthetic GPU · par défaut', 'Default display is ambiguous')
            require(primary['limit']['context'] == 196608 and primary['limit']['output'] == 4096, 'Default budget changed')
            require(cpu['name'] == 'synthetic-chat-b · Synthetic CPU', 'Host display is ambiguous')
            require(cpu['limit']['context'] == 32768 and cpu['capabilities']['toolcall'] is False, 'CPU capability/context changed')
            require(data['default']['agentx-core'] == 'agentx-primary', 'Default model changed')
        server.unavailable = True
        with native.server() as request:
            provider = next(p for p in request('/provider')['all'] if p['id'] == 'agentx-core')
            require(set(provider['models']) == {'agentx-primary'}, 'Unavailable discovery invented choices')
            require('indisponible' in provider['models']['agentx-primary']['name'], 'Discovery failure concealed')
        require(server.reads >= 2 and server.inference == 0, 'Discovery invoked inference')
        return {'nativeVersion': expected_version, 'discoveryReads': server.reads, 'modelCalls': 0,
            'checks': ['native provider/model labels', 'distinct host/context', 'principal default preserved',
                'embedding excluded', 'unavailable discovery fallback'], 'ok': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--expected-version', required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = run(args.binary, args.expected_version)
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
