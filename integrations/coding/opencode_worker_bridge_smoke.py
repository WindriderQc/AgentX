"""Native Bubblewrap worker -> exact Core transport -> independent OpenCode copy.

All tasks/receipts and model replies are synthetic and disposable. No installed
Core, human profile, DSH state or real model participates.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture = load('opencode_migration_smoke')
history = load('coding_opencode_history')
human = load('coding_opencode_handoff')
require = fixture.require


def reply(provider, body):
    tools = {t['function']['name'] for t in body.get('tools', [])}
    if not tools:
        return None, 'Synthetic title'
    messages = body['messages']
    last_user = max(i for i, m in enumerate(messages) if m.get('role') == 'user')
    human_turn = 'HUMAN_COPY_WRITE' in json.dumps(messages[last_user])
    completed = sum(m.get('role') == 'tool' for m in messages[last_user + 1:])
    steps = [('write', {'filePath': 'human-only.txt', 'content': 'INDEPENDENT_HUMAN_COPY\n'})] if human_turn else [
        ('read', {'filePath': 'calculator.py'}),
        ('edit', {'filePath': 'calculator.py', 'oldString': 'return a - b', 'newString': 'return a + b'}),
        ('bash', {'command': 'python3 -m unittest -v test_calculator.py', 'description': 'Run synthetic behavior test'}),
    ]
    if not human_turn and completed == 1:
        provider.tool_seen.set()
        require(provider.release.wait(30), 'Active worker observation did not release the synthetic response')
    if completed >= len(steps):
        return None, 'HUMAN_COPY_OK' if human_turn else 'WORKER_BRIDGE_OK'
    name, arguments = steps[completed]
    require(name in tools, 'Missing native tool: ' + name)
    return {'index': 0, 'id': ('human_' if human_turn else 'worker_') + str(completed), 'type': 'function',
            'function': {'name': name, 'arguments': json.dumps(arguments)}}, ''


def run(runtime_root, entry, node_root, browser=None):
    modules = {name: load(name) for name in ('coding_harness', 'coding_sandbox', 'coding_worker_prompt',
        'coding_progress', 'coding_deadline', 'model_relay')}
    result = {'schema': 'agentx.opencode-worker-bridge-smoke/v1', 'liveModelCalls': 0,
              'productionChanged': False, 'cutoverReady': False, 'checks': {}}
    with tempfile.TemporaryDirectory(prefix='agentx-opencode-worker-bridge-') as temporary:
        root = Path(temporary)
        workspace, home = root / 'task-0001', root / '.home-task-0001'
        workspace.mkdir(); home.mkdir()
        host_home = root / 'host-home'; host_home.mkdir()
        state = root / 'state'
        receipts = state / 'agentx/coding-run-requests'
        receipts.mkdir(parents=True)
        git_env = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_AUTHOR_NAME': 'Synthetic fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
            'GIT_COMMITTER_NAME': 'Synthetic fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
        def git(*args):
            return subprocess.check_output(['git', '-C', str(workspace), '-c', 'core.hooksPath=/dev/null', *args],
                env=git_env, stderr=subprocess.DEVNULL).decode().strip()
        git('init', '--quiet')
        (workspace / 'calculator.py').write_text('# <img src=x onerror="window.__nativeFixtureExecuted=true">\n'
            'def add(a, b):\n    return a - b\n')
        (workspace / 'test_calculator.py').write_text('import unittest\nfrom calculator import add\n'
            'class Addition(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n')
        (workspace / 'README.md').write_text('baseline')
        (workspace / 'obsolete.txt').write_text('delete at handoff')
        (workspace / '.gitignore').write_text('__pycache__/\n')
        git('add', '.'); git('commit', '-qm', 'Synthetic baseline')
        git('remote', 'add', 'origin', 'https://example.invalid/source.git')
        (workspace / 'rejected.txt').write_text('rejected candidate')
        git('stash', 'push', '-u', '-m', 'Synthetic rejected candidate')
        stash = git('rev-parse', 'refs/stash')
        (workspace / 'README.md').write_text('dirty source retained')
        (workspace / 'notes.txt').write_text('untracked retained')
        (workspace / 'obsolete.txt').unlink()
        provider = fixture.Provider()
        provider.reply = lambda body: reply(provider, body)
        thread = threading.Thread(target=provider.serve_forever, daemon=True); thread.start()
        relay = modules['model_relay'].serve(str(home / 'model.sock'), f'http://127.0.0.1:{provider.server_port}/v1')
        request_id = str(uuid4())
        history.atomic(receipts / (request_id + '.json'), {'pipelineId': '0001', 'requestId': request_id,
            'executorId': 'fixture-open', 'phase': 'accepted'})
        progress = modules['coding_progress'].Progress('0001', request_id, receipts=receipts)
        progress.phase = 'running'; progress.set_stage('model_wait'); progress.baseline(home, workspace)
        human_home = root / 'human'; human_home.mkdir()
        host_env = {**human.environment(host_home), 'XDG_STATE_HOME': str(state),
            'AGENTX_CODING_ENV_FILE': str(root / 'absent.env'), 'AGENTX_OPENCODE_ROOT': str(runtime_root),
            'AGENTX_OPENCODE_ENTRY': entry, 'AGENTX_OPENCODE_HANDOFF_ROOT': str(root / 'handoffs'),
            'AGENTX_OPENCODE_HUMAN_HOME': str(human_home), 'AGENTX_OPENCODE_HUMAN_URL': 'http://127.0.0.1:4096'}
        def control(action, *args):
            raw = subprocess.check_output(['python3', str(HERE / 'coding_sessions_control.py'), action,
                '0001', request_id, 'fixture-open', *args], env=host_env, timeout=180)
            body = json.loads(raw)
            require(body['status'] == 'success', 'Core native transport refused: ' + str(body))
            return body['data']
        def sandbox(ws, hm, command, **kwargs):
            kwargs['prompt_target'] = modules['coding_worker_prompt'].SANDBOX_PROMPT
            return modules['coding_sandbox'].build(ws, hm, command, node_root=node_root, coding_root=HERE,
                request_pattern=history.UUID, **kwargs)
        runtime = SimpleNamespace(harness=modules['coding_harness'], relay_port=8377,
            supervise=modules['coding_deadline'].supervise, sandbox=sandbox)
        try:
            with mock.patch.dict(os.environ, {'AGENTX_OPENCODE_ROOT': str(runtime_root), 'AGENTX_OPENCODE_ENTRY': entry}):
                with ThreadPoolExecutor(max_workers=1) as executor:
                    pending = executor.submit(modules['coding_worker_prompt'].run, runtime, workspace, home,
                        'Repair calculator.py and run test_calculator.py. Keep all other source changes.',
                        120, progress, read_only=False, on_stop=relay.begin_drain,
                        harness='opencode', model='agentx-primary', context_size=32768)
                    try:
                        require(provider.tool_seen.wait(45), 'Sandboxed native worker did not reach the read-tool checkpoint')
                        for _ in range(50):
                            values = control('list')['sessions']
                            if values and values[0]['nativeSessionId']:
                                break
                            time.sleep(.1)
                        else:
                            raise AssertionError('Native CLI output did not bind its session to the Core request')
                        invocation = values[0]['invocationId']
                        before = len(provider.requests)
                        active = control('read', invocation, '0', '-')
                        tools = [p for m in active['messages'] for p in m['parts'] if p['type'] == 'tool']
                        require(any(p['tool'] == 'read' for p in tools), 'Core observation omitted the native read result')
                        require(not active['canHandoff'] and active['state'] == 'running', 'Active invocation was offered as a completed handoff')
                        require(before == len(provider.requests), 'Core observation invoked inference')
                        result['checks']['sandboxedWorkerBoundToCoreAndObservedLiveWithoutInference'] = True
                        fixture.checkpoint('Native sandbox worker observed through exact Core transport')
                    finally:
                        provider.release.set()
                    completed = pending.result(timeout=120)
                require(completed.returncode == 0, 'Native worker failed: ' + completed.stderr[-1000:])
                require(not provider.failures, str(provider.failures))
                finished = control('read', invocation, '0', '-')
                require(finished['canHandoff'], 'Exited worker is not available for independent handoff')
                source = history.select(receipts, '0001', request_id, invocation)
                snapshot = history.snapshot(home, source['nativeSessionId'])
                require(finished['revision'] == history.digest(snapshot), 'Core source revision differs from its native history')
                result['checks']['nativeHistoryAndSourceRevisionAfterWorkerExit'] = True
                original_bytes = {p.name: p.read_bytes() for p in workspace.iterdir() if p.is_file()}
                before = len(provider.requests)
                handoff_id = str(uuid4())
                receipt = control('handoff', invocation, handoff_id, finished['revision'])
                require(receipt['state'] == 'ready', 'Independent native import was not received')
                replay = control('handoff', invocation, handoff_id, finished['revision'])
                require(replay == receipt, 'Same handoff request did not replay its original receipt')
                require(before == len(provider.requests), 'Creating or reconciling the copy invoked inference')
                copied = root / 'handoffs' / handoff_id / 'workspace'
                imported = history.snapshot(human_home, receipt['nativeSessionId'])
                require(imported['info']['directory'] == str(copied), 'Human native session uses the worker repository')
                require(len(imported['messages']) == len(snapshot['messages']) + 1, 'Native history or provenance notice is missing')
                require(not (copied / 'obsolete.txt').exists(), 'Tracked deletion was lost')
                require((copied / 'notes.txt').read_text() == 'untracked retained', 'Untracked source was lost')
                require((copied / 'README.md').read_text() == 'dirty source retained', 'Dirty source was lost')
                copied_stash = subprocess.check_output(['git', '-C', str(copied), 'rev-parse', 'refs/stash']).decode().strip()
                require(copied_stash == stash and git('remote', 'get-url', 'origin') == 'https://example.invalid/source.git',
                    'Rejected stash or original remote preservation failed')
                require(not subprocess.check_output(['git', '-C', str(copied), 'remote']).strip(), 'The human copy retains a remote')
                result['checks']['independentGitCopyNativeImportAndIdempotentReceiptWithoutInference'] = True
                fixture.checkpoint('Independent copy, native import, dirty files, deletion and rejected stash received')
                # Reconcile a lost success response from native state. No second
                # repository, session or import may be created.
                receipt_file = root / 'handoffs' / handoff_id / 'receipt.json'
                lost = history.read_json(receipt_file); lost['state'] = 'importing'; history.atomic(receipt_file, lost)
                recovered = control('handoff', invocation, handoff_id, finished['revision'])
                require(recovered['nativeSessionId'] == receipt['nativeSessionId'] and recovered['state'] == 'ready', 'Lost import response was not reconciled')
                result['checks']['lostImportResponseReconciledToTheSameNativeCopy'] = True
                # A distinct intentional handoff of the same source must not
                # collide with the first session's native message/part ids.
                second_id = str(uuid4())
                second = control('handoff', invocation, second_id, finished['revision'])
                one = history.snapshot(human_home, receipt['nativeSessionId'])
                two = history.snapshot(human_home, second['nativeSessionId'])
                require(not ({m['info']['id'] for m in one['messages']} & {m['info']['id'] for m in two['messages']}), 'Independent handoffs share native message ids')
                result['checks']['multipleHandoffsKeepIndependentNativeIdentities'] = True
                config_dir = human_home / '.config/opencode'; config_dir.mkdir(parents=True, exist_ok=True)
                config = json.loads(modules['coding_harness'].opencode_config('agentx-primary', 32768, provider.server_port))
                history.atomic(config_dir / 'opencode.json', config)
                human.native([str(runtime_root / entry), 'run', 'HUMAN_COPY_WRITE', '--session', receipt['nativeSessionId'],
                    '--model', 'agentx-core/agentx-primary', '--agent', 'build', '--format', 'json', '--auto'],
                    cwd=copied, env=human.environment(human_home), seconds=90)
                require((copied / 'human-only.txt').read_text() == 'INDEPENDENT_HUMAN_COPY\n', 'Native human tool did not write in its copy')
                require(not (workspace / 'human-only.txt').exists(), 'Human continuation mutated the original worker')
                require(original_bytes == {p.name: p.read_bytes() for p in workspace.iterdir() if p.is_file()}, 'Original source files changed during human continuation')
                require(history.digest(history.snapshot(home, source['nativeSessionId'])) == finished['revision'], 'Original native worker history changed during human continuation')
                result['checks']['nativeHumanToolEditsOnlyTheIndependentCopy'] = True
                fixture.checkpoint('Native human continuation wrote only in its independent repository')
                if browser:
                    config_path = root / 'browser-fixture.json'
                    history.atomic(config_path, {'env': host_env, 'requestId': request_id, 'invocationId': invocation})
                    subprocess.run([str(node_root / 'bin/node'), str(HERE.parent.parent / 'core/tests/browser/pipelineOpenCodeWorkerJourney.cjs'),
                        str(config_path), *browser], check=True, timeout=180)
                    result['checks']['coreBrowserTranscriptAndIndependentHandoff'] = True
                require(not provider.failures, str(provider.failures))
                result['syntheticProviderCalls'] = len(provider.requests)
        finally:
            provider.release.set()
            relay.begin_drain(); relay.drain(10); relay.shutdown(); relay.server_close()
            provider.shutdown(); provider.server_close(); thread.join(5)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-root', type=Path, required=True)
    parser.add_argument('--entry', default='node_modules/.bin/opencode')
    parser.add_argument('--node-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--playwright-module')
    parser.add_argument('--chromium')
    args = parser.parse_args()
    started = time.monotonic()
    try:
        browser = [args.playwright_module, args.chromium, str(args.output.parent.resolve())] if args.playwright_module and args.chromium else None
        result = run(args.runtime_root.resolve(), args.entry, args.node_root.resolve(), browser)
        result['passed'] = True
    except Exception as error:
        result = {'schema': 'agentx.opencode-worker-bridge-smoke/v1', 'passed': False, 'error': str(error),
                  'liveModelCalls': 0, 'productionChanged': False, 'cutoverReady': False}
    result['elapsedSeconds'] = round(time.monotonic() - started, 3)
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(result, stream, indent=2)
    print(json.dumps(result))
    raise SystemExit(0 if result['passed'] else 1)


if __name__ == '__main__':
    main()
