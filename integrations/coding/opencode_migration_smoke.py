"""Qualify native OpenCode migration primitives with a local synthetic provider.

No live model, Core endpoint, credential or installed runtime state is used.
The explicit binary runs in disposable directories. This does not qualify the
Coding Team sandbox, Core receipts, the browser UI or DSH transcript conversion.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('migration_harness', HERE / 'coding_harness.py')
harness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(harness)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def checkpoint(name):
    print(name, file=sys.stderr, flush=True)


class Provider(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.requests = []
        self.failures = []
        self.lock = threading.Lock()
        self.tool_seen = threading.Event()
        self.release = threading.Event()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('content-length', 0))
            require(0 < length <= 2 * 1024 * 1024, 'Unexpected provider payload size')
            body = json.loads(self.rfile.read(length))
            require(body['model'] == 'agentx-primary', 'Synthetic provider only accepts the routing alias')
            with self.server.lock:
                self.server.requests.append(body)
                require(len(self.server.requests) <= 24, 'Synthetic call budget exhausted')
            tools = {t['function']['name'] for t in body.get('tools', [])}
            messages = body['messages']
            content = json.dumps(messages, ensure_ascii=False)
            if not tools or 'MIGRATION_SECOND_TURN' in content:
                call, text = None, 'MIGRATION_PERSISTED_OK'
            else:
                completed = [m for m in messages if m.get('role') == 'tool']
                steps = [
                    ('read', {'filePath': 'calculator.py'}),
                    ('edit', {'filePath': 'calculator.py', 'oldString': 'return a - b', 'newString': 'return a + b'}),
                    ('bash', {'command': 'python3 -m unittest -v test_calculator.py', 'description': 'Run synthetic addition test'}),
                ]
                if len(completed) == 1:
                    self.server.tool_seen.set()
                    require(self.server.release.wait(20), 'Observation did not release the synthetic provider')
                if len(completed) < len(steps):
                    name, arguments = steps[len(completed)]
                    require(name in tools, f'Native {name} tool is missing')
                    call = {'index': 0, 'id': f'call_migration_{len(completed)}', 'type': 'function',
                            'function': {'name': name, 'arguments': json.dumps(arguments)}}
                    text = ''
                else:
                    call, text = None, 'MIGRATION_EDIT_TEST_OK'
            delta = {'role': 'assistant', **({'tool_calls': [call]} if call else {'content': text})}
            chunks = [
                {'id': 'synthetic-migration', 'object': 'chat.completion.chunk', 'model': 'agentx-primary',
                 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
                {'id': 'synthetic-migration', 'object': 'chat.completion.chunk', 'model': 'agentx-primary',
                 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if call else 'stop'}],
                 'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}},
            ]
            data = ''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks) + 'data: [DONE]\n\n'
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(data.encode())))
            self.end_headers()
            self.wfile.write(data.encode())
        except Exception as error:
            self.server.failures.append(str(error))
            self.send_error(500, 'Synthetic provider refused the request')


def isolated_env(root, port):
    # Whitelist instead of inheriting provider tokens, global config or MCP.
    config = json.loads(harness.opencode_config('agentx-primary', 32768, port))
    config['small_model'] = config['model']
    config['enabled_providers'] = ['agentx-core']
    config['autoupdate'] = False
    return {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(root / 'home'),
        **{f'XDG_{name}_HOME': str(root / name.lower()) for name in ('CONFIG', 'DATA', 'CACHE', 'STATE')},
        'OPENCODE_CONFIG_CONTENT': json.dumps(config), 'OPENCODE_CONFIG_DIR': str(root / 'config'),
        'OPENCODE_DISABLE_AUTOUPDATE': 'true', 'OPENCODE_DISABLE_DEFAULT_PLUGINS': 'true',
        'OPENCODE_DISABLE_LSP_DOWNLOAD': 'true', 'OPENCODE_DISABLE_MODELS_FETCH': 'true',
        'OPENCODE_SERVER_PASSWORD': 'synthetic-migration-only', 'NO_COLOR': '1',
    }


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


class Native:
    def __init__(self, binary, root, provider):
        self.binary, self.root, self.provider = str(binary), root, provider
        self.env = isolated_env(root, provider.server_port)
        self.workspace = root / 'workspace'
        self.workspace.mkdir(parents=True)
        subprocess.run(['git', 'init', '--quiet', str(self.workspace)], check=True, capture_output=True)

    def cli(self, *args, timeout=60):
        result = subprocess.run([self.binary, *args], cwd=self.workspace, env=self.env,
                                capture_output=True, text=True, timeout=timeout)
        require(result.returncode == 0, f'Native command failed: {args[0]}: {result.stderr[-2000:]}')
        return result.stdout

    @contextmanager
    def server(self):
        port = free_port()
        auth = base64.b64encode(b'opencode:synthetic-migration-only').decode()
        def request(path, payload=None, authenticated=True):
            headers = {'Content-Type': 'application/json'}
            if authenticated:
                headers['Authorization'] = 'Basic ' + auth
            req = urllib.request.Request(f'http://127.0.0.1:{port}{path}',
                data=None if payload is None else json.dumps(payload).encode(), headers=headers)
            with urllib.request.urlopen(req, timeout=45) as response:
                return json.load(response)
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen([self.binary, 'serve', '--hostname', '127.0.0.1', '--port', str(port)],
                cwd=self.workspace, env=self.env, stdout=log, stderr=log, start_new_session=True)
            try:
                for _ in range(150):
                    if process.poll() is not None:
                        log.seek(0)
                        raise AssertionError('Native server stopped: ' + log.read().decode()[-2000:])
                    try:
                        request('/global/health')
                        break
                    except (OSError, ValueError):
                        time.sleep(.1)
                else:
                    raise AssertionError('Native server did not become ready')
                yield request
            finally:
                process.terminate()
                try:
                    process.wait(10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(10)


def run(binary, expected_version):
    binary = binary.resolve(strict=True)
    result = {'schema': 'agentx.opencode-migration-smoke/v1', 'checks': {},
              'liveModelCalls': 0, 'cutoverReady': False,
              'notQualified': ['DSH archive conversion and archive reader',
                'Core worker transcript bridge and stable request bindings',
                'independent repository handoff', 'Core cancellation and uncertain-result recovery',
                'report save-pass evidence and progress observer', 'Bubblewrap and real gateway',
                'browser interface and physical device acceptance']}
    with tempfile.TemporaryDirectory(prefix='agentx-opencode-migration-') as directory:
        root = Path(directory)
        provider = Provider()
        thread = threading.Thread(target=provider.serve_forever, daemon=True)
        thread.start()
        try:
            native = Native(binary, root / 'original', provider)
            version = native.cli('--version').strip()
            require(version == expected_version, 'The selected runtime does not match the reviewed version')
            result['version'] = version
            checkpoint('Reviewed runtime version received')
            (native.workspace / 'calculator.py').write_text('def add(a, b):\n    return a - b\n')
            (native.workspace / 'test_calculator.py').write_text(
                'import unittest\nfrom calculator import add\nclass Addition(unittest.TestCase):\n'
                '    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n')
            with native.server() as api:
                try:
                    api('/session', authenticated=False)
                except urllib.error.HTTPError as error:
                    require(error.code == 401, 'Unauthenticated API returned an unexpected status')
                else:
                    raise AssertionError('Native API accepted an unauthenticated read')
                result['checks']['authenticatedAPI'] = True
                session = api('/session', {'title': 'Synthetic migration worker'})
                session_id = session['id']
                with ThreadPoolExecutor(max_workers=1) as executor:
                    pending = executor.submit(api, f'/session/{session_id}/message', {
                        'model': {'providerID': 'agentx-core', 'modelID': 'agentx-primary'},
                        'agent': 'build', 'parts': [{'type': 'text', 'text': 'Repair calculator.py and run its test.'}]})
                    try:
                        require(provider.tool_seen.wait(30), 'Native tool execution did not reach the observation checkpoint')
                        before = len(provider.requests)
                        messages = api(f'/session/{session_id}/message')
                        completed = [p for m in messages for p in m['parts']
                                     if p['type'] == 'tool' and p['state']['status'] == 'completed']
                        require(any(p['tool'] == 'read' for p in completed), 'Active native history omitted the read tool')
                        require(any(s['id'] == session_id for s in api('/session')), 'Active session is not discoverable')
                        require(before == len(provider.requests), 'Reading active history invoked the provider')
                        result['checks']['activeWorkerObservationWithoutInference'] = True
                    finally:
                        provider.release.set()
                    pending.result(timeout=45)
                require(not provider.failures, 'Synthetic provider errors: ' + str(provider.failures))
                require('return a + b' in (native.workspace / 'calculator.py').read_text(), 'Native edit did not fix the file')
                tests = subprocess.run(['python3', '-m', 'unittest', '-v', 'test_calculator.py'],
                    cwd=native.workspace, capture_output=True, timeout=10)
                require(tests.returncode == 0, 'Independent behavior test failed')
                messages = api(f'/session/{session_id}/message')
                tools = [p for m in messages for p in m['parts'] if p['type'] == 'tool']
                require({p['tool'] for p in tools} >= {'read', 'edit', 'bash'}, 'Native tool history is incomplete')
                require(all(p['state']['status'] == 'completed' for p in tools), 'Native tool history contains errors')
                require(any(p['tool'] == 'bash' and 'OK' in p['state'].get('output', '') for p in tools), 'Test output was not persisted')
                result['checks']['nativeReadEditTestAndToolHistory'] = True
                checkpoint('Native edit/test and concurrent observation passed')
                original_messages = len(messages)
            before = len(provider.requests)
            with native.server() as api:
                restored = api(f'/session/{session_id}/message')
                require(len(restored) == original_messages, 'Native history changed across server restart')
                fork = api(f'/session/{session_id}/fork', {})
                require(fork['id'] != session_id, 'Fork reused its source identity')
                require(len(api(f"/session/{fork['id']}/message")) == original_messages, 'Native fork lost history')
                require(before == len(provider.requests), 'Restart/read/fork invoked the provider')
                result['checks']['persistedHistoryAfterRestartAndNativeFork'] = True
                # Native session forks keep the same repository. This is not an
                # independent human handoff and cannot satisfy that migration gate.
                result['forkSharesSourceDirectory'] = fork['directory'] == session['directory']
                checkpoint('Restart, retained history and fork checked')
            continued = native.cli('run', 'MIGRATION_SECOND_TURN', '--session', session_id,
                '--model', 'agentx-core/agentx-primary', '--agent', 'build', '--format', 'json', '--auto')
            require('MIGRATION_PERSISTED_OK' in continued, 'Explicit session continuation failed')
            result['checks']['explicitNativeSessionContinuation'] = True
            attachment = root / 'task.txt'
            attachment.write_text('MIGRATION_SECOND_TURN: acknowledge this synthetic attachment.')
            attached = native.cli('run', 'Follow the attached synthetic task.',
                '--model', 'agentx-core/agentx-primary', '--agent', 'build', '--format', 'json',
                '--auto', '--file', str(attachment))
            require('MIGRATION_PERSISTED_OK' in attached, 'Attached-file CLI invocation failed')
            result['checks']['attachedTaskCLI'] = True
            exported = json.loads(native.cli('export', session_id))
            export_path = root / 'synthetic-export.json'
            export_path.write_text(json.dumps(exported))
            before = len(provider.requests)
            imported = Native(binary, root / 'imported', provider)
            imported.cli('import', str(export_path))
            with imported.server() as api:
                restored = api(f'/session/{session_id}/message')
                require(len(restored) > original_messages, 'Native import lost the continued turn')
                require(sum(p['type'] == 'tool' for m in restored for p in m['parts']) == len(tools), 'Native import lost tool records')
                restored_tools = [p for m in restored for p in m['parts'] if p['type'] == 'tool']
                require(restored_tools == tools, 'Native import changed tool identities, arguments or results')
                require(restored == exported['messages'], 'Native import changed exported messages or parts')
            require(before == len(provider.requests), 'Export/import/read invoked the provider')
            result['checks']['nativeExportImportWithToolHistory'] = True
            checkpoint('Explicit continuation, attached-file CLI and exact export/import passed')
            result['syntheticProviderCalls'] = len(provider.requests)
        finally:
            provider.release.set()
            provider.shutdown()
            provider.server_close()
            thread.join(5)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--expected-version', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    try:
        result = run(args.binary, args.expected_version)
        result['passed'] = True
    except Exception as error:
        result = {'schema': 'agentx.opencode-migration-smoke/v1', 'passed': False,
                  'cutoverReady': False, 'error': str(error), 'liveModelCalls': 0}
    result['elapsedSeconds'] = round(time.monotonic() - started, 3)
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print(json.dumps(result))
    raise SystemExit(0 if result['passed'] else 1)


if __name__ == '__main__':
    main()
