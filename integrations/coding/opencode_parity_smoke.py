"""CPU qualification of native read-only research, save evidence and test progress.

Uses the real reviewed OpenCode and Bubblewrap with a synthetic loopback
provider. No installed Core, DSH state, real model or execution grant participates.
"""
import argparse
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

from opencode_worker_bridge_smoke import load, fixture, require


def run(runtime_root, node_root):
    modules = {name: load(name) for name in ('coding_harness', 'coding_sandbox', 'coding_worker_prompt',
        'coding_progress', 'coding_deadline', 'model_relay', 'coding_report_save', 'coding_report_steps')}
    history = load('coding_opencode_history')
    saving = modules['coding_report_save']
    result = {'schema': 'agentx.opencode-parity-smoke/v1', 'liveModelCalls': 0,
        'productionChanged': False, 'syntheticCoreAuthority': True, 'checks': {}}
    with tempfile.TemporaryDirectory(prefix='agentx-opencode-parity-') as temporary:
        root = Path(temporary); workspace, home, receipts = [root / p for p in ('workspace', 'home', 'receipts')]
        for p in (workspace, home, receipts): p.mkdir()
        subprocess.run(['git', '-C', str(workspace), 'init', '-q'], check=True)
        (workspace / 'source.py').write_text('RETRY_LIMIT = 7\n')
        (workspace / 'test_source.py').write_text('import unittest\nfrom source import RETRY_LIMIT\n'
            'class Source(unittest.TestCase):\n def test_limit(self): self.assertEqual(RETRY_LIMIT, 7)\n')
        request_id = str(uuid4()); task_id = '0001'
        history.atomic(receipts / (request_id + '.json'), {'pipelineId': task_id, 'requestId': request_id})
        progress = modules['coding_progress'].Progress(task_id, request_id, soft_seconds=900, receipts=receipts)
        progress.phase = 'running'; progress.report_mode = True; progress.task_claim_seq = 2
        progress.model_context_size = 196608
        output_root = home / 'deliverables' / request_id; output_root.mkdir(parents=True)
        output = output_root / 'step-01.json'
        provider = fixture.Provider(); phase = ['research']
        saved = {'documents': [{'path': 'README.md', 'state': 'partial', 'evidence': [
            {'path': 'source.py', 'line': 1, 'check': 'Synthetic source says RETRY_LIMIT = 7'}]}], 'findings': []}

        def reply(body):
            if not body.get('tools'): return None, 'Synthetic title'
            last = max(i for i, m in enumerate(body['messages']) if m['role'] == 'user')
            completed = sum(m.get('role') == 'tool' for m in body['messages'][last + 1:])
            steps = ([('read', {'filePath': '/workspace/source.py'})] if phase[0] == 'research' else
                [('write', {'filePath': 'step-01.json', 'content': json.dumps(saved)})] if phase[0] == 'save' else
                [('read', {'filePath': '/workspace/source.py'}), ('read', {'filePath': '/workspace/test_source.py'}),
                 ('edit', {'filePath': '/workspace/source.py', 'oldString': 'RETRY_LIMIT = 7', 'newString': 'RETRY_LIMIT = 8'}),
                 ('edit', {'filePath': '/workspace/test_source.py', 'oldString': 'RETRY_LIMIT, 7', 'newString': 'RETRY_LIMIT, 8'})]
                if phase[0] == 'implementation' else
                [('bash', {'command': 'python3 -m unittest -v test_source.py', 'description': 'Run synthetic source test'})])
            if completed >= len(steps): return None, 'SYNTHETIC_STEP_DONE'
            name, args = steps[completed]
            return {'index': 0, 'id': phase[0] + '_call', 'type': 'function',
                'function': {'name': name, 'arguments': json.dumps(args)}}, ''

        provider.reply = reply
        thread = threading.Thread(target=provider.serve_forever, daemon=True); thread.start()

        def sandbox(ws, hm, command, **kwargs):
            kwargs['prompt_target'] = modules['coding_worker_prompt'].SANDBOX_PROMPT
            return modules['coding_sandbox'].build(ws, hm, command, node_root=node_root,
                coding_root=Path(__file__).resolve().parent, request_pattern=history.UUID, **kwargs)

        runtime = SimpleNamespace(sandbox=sandbox, supervise=modules['coding_deadline'].supervise,
            relay_port=8377, harness=modules['coding_harness'])

        def worker(ws, prompt, seconds, p, *, read_only):
            relay = modules['model_relay'].serve(str(home / 'model.sock'),
                f'http://127.0.0.1:{provider.server_port}/v1', p.model_events.put,
                request_budget=p.relay_call_budget(),
                request_policy=modules['coding_harness'].implementation_policy(p, read_only=read_only))
            p.baseline(home, workspace)
            try:
                return modules['coding_worker_prompt'].run(runtime, ws, home, prompt, seconds, p,
                    read_only=read_only, on_stop=relay.begin_drain, harness='opencode',
                    model='agentx-primary', context_size=196608)
            finally:
                relay.begin_drain(); p.report_drained = relay.drain(10)
                relay.shutdown(); relay.server_close()

        runner = SimpleNamespace(worker_home=lambda _: home, coding_harness=modules['coding_harness'],
            coding_progress=modules['coding_progress'], RECEIPTS=receipts, run_worker=worker)
        try:
            with mock.patch.dict(os.environ, {'AGENTX_CODING_HARNESS': 'opencode',
                    'AGENTX_OPENCODE_ROOT': str(runtime_root), 'AGENTX_OPENCODE_ENTRY': 'node_modules/.bin/opencode'}):
                before = saving.snapshot(runner, workspace, request_id)
                progress.begin_step(4, 60, f'/home/agent/deliverables/{request_id}/step-01.json')
                try:
                    research = worker(workspace, 'Read /workspace/source.py. Research only; do not write a result yet.',
                        60, progress, read_only=True)
                finally: progress.end_step()
                require(research.returncode == 0, 'Native research failed: ' + research.stderr[-1000:])
                capsule = saving.capsule(runner, workspace, before, request_id, 'step-01.json')
                require('RETRY_LIMIT = 7' in json.dumps(capsule['pairs']), 'The readonly source result is missing')
                require(not output.exists(), 'Research wrote the save result prematurely')
                result['checks']['nativeReadonlyResearchBoundToItsExactStep'] = True
                phase[0] = 'save'
                def freeze(_runner, path, value):
                    require(not path.exists(), 'An existing native receipt would be overwritten')
                    history.atomic(path, value)
                settled = lambda *_: {'requestId': request_id, 'claimSeq': 2, 'state': 'active',
                    'terminationVerified': True, 'allCallsCompleted': True, 'pendingInferences': [],
                    'inventory': {'sha256': 'b' * 64}, 'authority': {'requestId': request_id, 'sourceCommit': 'a' * 40}}
                value, reason = saving.attempt(runner, SimpleNamespace(request_id=request_id), progress, workspace,
                    output, 1, 'Save the source-grounded JSON result to step-01.json.', before,
                    'a' * 40, 'b' * 64, 24576, modules['coding_report_steps'], freeze, settled)
                require(value == saved and reason is None, 'Native save pass did not produce its validated JSON: ' + str(reason))
                result['checks']['nativeSavePassWritesOnlyItsPrivateDeliverable'] = True
                require((workspace / 'source.py').read_text() == 'RETRY_LIMIT = 7\n', 'Readonly source changed')
                phase[0] = 'implementation'; progress.begin_step(8, 60, 'source-pair', result_kind='source')
                progress.step.update(sourceContext='complete_pair', sourcePaths=['source.py', 'test_source.py'])
                try:
                    implemented = worker(workspace, 'Update RETRY_LIMIT and its paired assertion to 8. Read each file before editing.',
                        60, progress, read_only=False)
                finally: progress.end_step()
                require(implemented.returncode == 0 and (workspace / 'source.py').read_text() == 'RETRY_LIMIT = 8\n',
                    'Bounded source-pair editing did not use the native read-path schema')
                result['checks']['nativeSourcePairUsesBoundedEditingAndNativeReadArguments'] = True
                phase[0] = 'test'; progress.begin_step(4, 60, '/workspace/source.py', result_kind='source')
                try:
                    tested = worker(workspace, 'Run python3 -m unittest -v test_source.py.', 60, progress, read_only=False)
                finally: progress.end_step()
                require(tested.returncode == 0, 'Native source test invocation failed')
                require(progress.last_test == {'name': 'unittest', 'outcome': 'passed'}, 'Native test receipt was not observed')
                result['checks']['nativeTestExitDrivesExistingSanitizedProgress'] = True
                require(not provider.failures, str(provider.failures))
                result['syntheticProviderCalls'] = len(provider.requests)
        finally:
            provider.shutdown(); provider.server_close(); thread.join(5)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-root', type=Path, required=True)
    parser.add_argument('--node-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(); started = time.monotonic()
    try:
        result = run(args.runtime_root.resolve(), args.node_root.resolve()); result['passed'] = True
    except Exception as error:
        result = {'schema': 'agentx.opencode-parity-smoke/v1', 'passed': False, 'error': str(error), 'liveModelCalls': 0}
    result['elapsedSeconds'] = round(time.monotonic() - started, 3)
    with os.fdopen(os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as stream:
        json.dump(result, stream, indent=2)
    print(json.dumps(result)); raise SystemExit(0 if result['passed'] else 1)


if __name__ == '__main__': main()
