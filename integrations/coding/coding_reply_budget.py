"""Runner-owned admission for complete model replies, before tool execution.

Compose with model_relay's request count/output policy and a process deadline.
The budget persists across replies and may be shared across resumed sessions.
It does not execute tools or grant access to another capability.
"""
import json
import threading
import time


def normalize_complete_tool_stream(data: bytes, content_type: str) -> bytes:
    """Index complete gateway tool calls; never guess the identity of fragments.

    Some Ollama bridges send complete calls with IDs but omit SSE-only indices.
    Indexed native streams pass through unchanged. The caller must still apply
    its reply budget to the returned bytes before forwarding them.
    """
    if 'text/event-stream' not in content_type.lower():
        return data
    events, occupied, identities, pending = [], set(), set(), []
    for event in data.decode('utf-8', errors='strict').replace('\r\n', '\n').split('\n\n'):
        lines = [line[5:].lstrip() for line in event.splitlines() if line.startswith('data:')]
        if not lines:
            continue
        value = '\n'.join(lines)
        if value == '[DONE]':
            events.append(value)
            continue
        body = json.loads(value)
        for choice in body.get('choices', []):
            for call in (choice.get('delta') or {}).get('tool_calls') or []:
                if not isinstance(call, dict):
                    raise ValueError('Malformed stream tool call')
                if 'index' in call:
                    if type(call['index']) is not int or call['index'] < 0:
                        raise ValueError('Malformed stream tool index')
                    occupied.add(call['index'])
                    continue
                function = call.get('function')
                identity = call.get('id')
                if (not isinstance(identity, str) or not identity or identity in identities
                        or call.get('type') != 'function' or not isinstance(function, dict)
                        or not isinstance(function.get('name'), str) or not function['name']
                        or not isinstance(function.get('arguments'), str)):
                    raise ValueError('Unindexed tool fragments are ambiguous')
                if not isinstance(json.loads(function['arguments']), dict):
                    raise ValueError('Tool arguments must be a complete object')
                identities.add(identity)
                pending.append(call)
        events.append(body)
    if not pending:
        return data
    if occupied:
        raise ValueError('Mixed indexed and unindexed tool calls are ambiguous')
    for index, call in enumerate(pending):
        call['index'] = index
    return ''.join('data: ' + (x if isinstance(x, str) else json.dumps(x)) + '\n\n'
                   for x in events).encode()


def tool_count(data: bytes, content_type: str) -> int:
    """Count complete OpenAI JSON or SSE tool calls; refuse truncated streams."""
    text = data.decode('utf-8', errors='strict')
    if 'text/event-stream' not in content_type.lower():
        body = json.loads(text)
        choices = body.get('choices') if isinstance(body, dict) else None
        if not isinstance(choices, list) or len(choices) != 1:
            raise ValueError('Expected exactly one model reply')
        choice = choices[0]
        message = choice.get('message')
        if not isinstance(message, dict) or choice.get('finish_reason') not in ('stop', 'tool_calls'):
            raise ValueError('Incomplete model reply')
        if message.get('function_call') is not None:
            raise ValueError('Legacy function calls are not admitted')
        calls = message.get('tool_calls') or []
        if not isinstance(calls, list) or any(not isinstance(x, dict) for x in calls):
            raise ValueError('Malformed tool calls')
        return len(calls)
    calls, finished, done = set(), False, False
    for event in text.replace('\r\n', '\n').split('\n\n'):
        lines = [line[5:].lstrip() for line in event.splitlines() if line.startswith('data:')]
        if not lines:
            continue
        value = '\n'.join(lines)
        if value == '[DONE]':
            done = True
            continue
        if done:
            raise ValueError('Model data after stream completion')
        body = json.loads(value)
        choices = body.get('choices') if isinstance(body, dict) else None
        if not isinstance(choices, list) or len(choices) > 1:
            raise ValueError('Malformed stream choices')
        for choice in choices:
            if choice.get('index', 0) != 0:
                raise ValueError('Expected one model choice')
            reason = choice.get('finish_reason')
            if reason is not None:
                if reason not in ('stop', 'tool_calls'):
                    raise ValueError('Incomplete model reply')
                finished = True
            delta = choice.get('delta')
            if not isinstance(delta, dict):
                raise ValueError('Malformed model delta')
            if delta.get('function_call') is not None:
                raise ValueError('Legacy function calls are not admitted')
            entries = delta.get('tool_calls') or []
            if not isinstance(entries, list):
                raise ValueError('Malformed stream tool calls')
            for call in entries:
                if not isinstance(call, dict) or type(call.get('index')) is not int or call['index'] < 0:
                    raise ValueError('Malformed stream tool index')
                calls.add(call['index'])
    if not done or not finished:
        raise ValueError('Truncated model stream')
    return len(calls)


class ReplyBudget:
    """Atomic cumulative tool-call fence, including a monotonic deadline."""
    def __init__(self, max_tools: int, deadline: float):
        if type(max_tools) is not int or not 0 <= max_tools <= 4096:
            raise ValueError('Invalid tool allowance')
        if type(deadline) not in (int, float) or not 0 < deadline < float('inf'):
            raise ValueError('Invalid reply deadline')
        self.max_tools, self.deadline = max_tools, deadline
        self.admitted_tools = 0
        self.lock = threading.Lock()

    def __call__(self, data: bytes, content_type: str) -> None:
        try:
            count = tool_count(data, content_type)
        except (UnicodeError, TypeError, AttributeError) as error:
            raise ValueError('Malformed model response') from error
        with self.lock:
            if time.monotonic() >= self.deadline:
                raise ValueError('Model reply deadline exhausted')
            if self.admitted_tools + count > self.max_tools:
                raise ValueError('Cumulative tool allowance exhausted')
            self.admitted_tools += count
