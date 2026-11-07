"""Project an exactly bound native OpenCode session into runner observations.

These are transient observations, not translated histories. SQLite remains the
native transcript; Core and the runner retain budgets and execution authority.
"""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location('coding_opencode_history', Path(__file__).with_name('coding_opencode_history.py'))
history = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(history)


def tool(part):
    state = part.get('state')
    if (not isinstance(state, dict) or state.get('status') not in ('pending', 'running', 'completed', 'error')
            or not isinstance(part.get('callID'), str) or not part['callID']
            or not isinstance(part.get('tool'), str) or not part['tool']
            or not isinstance(state.get('input'), dict)):
        raise ValueError('The native tool binding is incomplete')
    if 'metadata' in state and not isinstance(state['metadata'], dict):
        raise ValueError('The native tool metadata is malformed')
    return state


def result(state):
    field = 'error' if state['status'] == 'error' else 'output'
    if not isinstance(state.get(field), str):
        raise ValueError('The native tool result is not plaintext evidence')
    return state[field]


class Observer:
    def __init__(self, capture):
        self.capture = capture
        self.calls, self.results, self.parts, self.finishes = {}, {}, {}, set()

    def scan(self, progress):
        binding = self.capture.value
        sid = binding['nativeSessionId']
        if sid is None:
            return
        snapshot = history.snapshot(binding['home'], sid)
        if snapshot['info']['directory'] != binding['directory']:
            raise ValueError('The observed native session changed its directory')
        scope = binding['invocationId'] + ':' + sid

        def emit(kind, data):
            progress.event({'type': kind, 'data': data}, scope)

        for message in snapshot['messages']:
            info = message['info']
            if info.get('role') != 'assistant':
                continue
            for part in message['parts']:
                pid, kind = part['id'], part.get('type')
                if kind == 'tool':
                    state = tool(part)
                    if state['status'] == 'pending':
                        continue
                    identity = (part['callID'], part['tool'], history.digest(state['input']))
                    if pid in self.calls and self.calls[pid] != identity:
                        raise ValueError('A native tool changed its call identity')
                    if pid not in self.calls:
                        self.calls[pid] = identity
                        emit('tool/call', {'callId': part['callID'], 'name': part['tool'], 'arguments': state['input']})
                    if state['status'] in ('completed', 'error'):
                        signature = history.digest(state)
                        if pid in self.results:
                            if self.results[pid] != signature:
                                raise ValueError('A completed native tool result changed')
                            continue
                        output = result(state)
                        code = (state.get('metadata') or {}).get('exit')
                        known_exit = type(code) is int and 0 <= code < 124
                        if type(code) is int and (code < 0 or code >= 124):
                            output += '\n[killed by signal]'  # No successful test conclusion from a launcher/abort.
                        elif type(code) is int:
                            output += f'\n[exit code: {code}]'
                        emit('tool/result', {'message': {'role': 'tool', 'toolCallId': part['callID'],
                            'source': {'callId': part['callID']}, 'exitVerified': known_exit,
                            'isError': state['status'] == 'error', 'content': [{'type': 'text', 'text': output}]}})
                        self.results[pid] = signature
                elif kind in ('text', 'reasoning'):
                    signature = history.digest(part)
                    if self.parts.get(pid) != signature:
                        self.parts[pid] = signature
                        emit('assistant/chunk', {})
            if info.get('finish') == 'length' and info['id'] not in self.finishes:
                self.finishes.add(info['id'])
                emit('turn/end', {'reason': {'kind': 'max-tokens'}})


def selected(r):
    harness = getattr(r, 'coding_harness', None)
    return bool(harness and harness.selected() == 'opencode')


def sessions(r, workspace, request_id):
    if not history.UUID.fullmatch(request_id or ''):
        raise ValueError('Native report evidence requires its exact Core request')
    run = history.read_json(r.RECEIPTS / (request_id + '.json'))
    values = history.bindings(r.RECEIPTS, run.get('pipelineId'), request_id)
    home = r.worker_home(workspace).resolve(strict=True)
    workspace = workspace.resolve(strict=True)
    found = {}
    for value in values:
        if value['home'] != str(home) or value['workspace'] != str(workspace):
            raise ValueError('Native report evidence belongs to another workspace')
        found[value['invocationId']] = value
    return found


def capsule(r, workspace, before, request_id, step_output):
    current = sessions(r, workspace, request_id)
    candidates = [value for key, value in current.items() if key not in before]
    if len(candidates) != 1:
        raise ValueError('The original native step invocation is not uniquely identified')
    binding = candidates[0]
    if any(value.get('nativeSessionId') == binding.get('nativeSessionId') for key, value in current.items() if key in before):
        raise ValueError('An earlier native logical session cannot supply new step evidence')
    cwd = '/home/agent/deliverables/' + request_id
    if (binding['state'] != 'exited' or binding.get('readOnly') is not True
            or binding.get('directory') != cwd or binding.get('stepOutput') != cwd + '/' + step_output):
        raise ValueError('The native invocation does not identify this drained report step')
    snapshot = history.snapshot(binding['home'], binding['nativeSessionId'])
    if snapshot['info']['directory'] != cwd or snapshot['info'].get('parentID'):
        raise ValueError('The native report session is not an independent step')
    pairs, seen = [], set()
    for message in snapshot['messages']:
        if message['info'].get('role') != 'assistant':
            continue
        for part in message['parts']:
            if part.get('type') != 'tool':
                continue
            state = tool(part)
            if state['status'] not in ('completed', 'error') or part['callID'] in seen:
                raise ValueError('Native tool evidence is incomplete or ambiguous')
            seen.add(part['callID'])
            pairs.append({'callId': part['callID'], 'messageId': message['info']['id'], 'partId': part['id'],
                'name': part['tool'], 'arguments': state['input'],
                'status': state['status'], 'metadata': state.get('metadata', {}),
                'content': [{'type': 'text', 'text': result(state)}], 'isError': state['status'] == 'error'})
    if not pairs or len(pairs) > 128 or len(history.encoded(pairs)) > 512 * 1024:
        raise ValueError('Native research is missing or exceeds its complete-pair bound')
    return {'harness': 'opencode', 'invocationId': binding['invocationId'],
        'session': binding['nativeSessionId'], 'sessionSha256': history.digest(snapshot),
        'sessionBytes': len(history.encoded(snapshot)), 'pairs': pairs}
