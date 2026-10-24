"""Replaceable local coding harness adapters.

Core and the host controller own identity, admission, budgets, workspaces and
delivery. A harness only receives one prompt and the already bounded workspace.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re

HARNESSES = ('dsh', 'opencode')
IMPLEMENTATION_OUTPUT_TOKENS = 4096


def implementation_policy(progress, *, read_only=False):
    """The runner's source step owns this policy, independently of the harness."""
    step = getattr(progress, 'step', None)
    if (read_only or getattr(progress, 'report_mode', False) or not isinstance(step, dict)
            or step.get('resultKind') != 'source'):
        return None
    policy = {'max_tokens': IMPLEMENTATION_OUTPUT_TOKENS, 'reasoning_effort': 'none'}
    if step.get('sourceContext') == 'complete_pair':
        policy['tools'] = 'edit_only'
    return policy


def dsh_patch(model: str, context_size: int | None = None, relay_port=8377, *, max_tokens=None) -> list[dict]:
    if context_size is not None and (type(context_size) is not int or context_size <= 0):
        raise RuntimeError('Coding context is unavailable')
    if max_tokens is not None and (type(max_tokens) is not int or not 1 <= max_tokens <= 32768):
        raise RuntimeError('Coding output allowance is invalid')
    model_config = {'id': model, 'maxTokens': 32768 if max_tokens is None else max_tokens}
    if context_size is not None:
        model_config['contextWindow'] = context_size
    return [
        {'id': 'llm-pi-ai', 'config': {'providers': {'agentx-core': {
            'displayName': 'AgentX Core', 'apiKeyEnv': 'AGENTX_CORE_API_KEY',
            'api': 'openai-completions', 'baseURL': f'http://127.0.0.1:{relay_port}/v1',
            'compat': {'supportsDeveloperRole': False, 'maxTokensField': 'max_tokens', 'thinkingFormat': 'deepseek'},
            'models': [model_config],
        }}}},
        {'id': 'agent-default-model', 'config': {'provider': 'agentx-core', 'model': model}},
    ]


def selected() -> str:
    value = os.environ.get('AGENTX_CODING_HARNESS', 'dsh').strip().lower()
    if value not in HARNESSES:
        raise RuntimeError(f'Unsupported coding harness: {value or "(empty)"}')
    return value


def dsh_command(prompt_path: str) -> list[str]:
    return ['node', '--require', '/opt/coding/coding_worker_prompt.cjs',
            '/opt/dsh/node_modules/.bin/dsh', prompt_path, '--profile', 'headless',
            '--patch', '/home/agent/.dsh/agentx.patch.json',
            '--patch', '/opt/coding/guard.patch.yml', '--']


def opencode_runtime() -> tuple[Path, str]:
    root = Path(os.environ.get('AGENTX_OPENCODE_ROOT', str(Path.home() / 'opencode'))).resolve()
    entry = os.environ.get('AGENTX_OPENCODE_ENTRY', 'bin/opencode').strip()
    if not entry or entry.startswith('/') or '..' in Path(entry).parts or not re.fullmatch(r'[A-Za-z0-9._/-]+', entry):
        raise RuntimeError('AGENTX_OPENCODE_ENTRY must be a relative executable path')
    executable = root / entry
    if not root.is_dir() or not executable.is_file():
        raise RuntimeError('The configured OpenCode runtime is unavailable')
    return root, entry


def opencode_config(model: str, context_size: int | None, relay_port=8377) -> str:
    limits = {'output': 32768}
    if context_size:
        limits['context'] = context_size
    value = {
        '$schema': 'https://opencode.ai/config.json',
        'model': f'agentx-core/{model}',
        'provider': {'agentx-core': {
            'npm': '@ai-sdk/openai-compatible', 'name': 'AgentX Core',
            'options': {'baseURL': f'http://127.0.0.1:{relay_port}/v1', 'apiKey': 'local-no-auth'},
            'models': {model: {'name': model, 'limit': limits}},
        }},
        'permission': {
            'read': 'allow', 'edit': 'allow', 'glob': 'allow', 'grep': 'allow', 'list': 'allow',
            'shell': 'allow', 'task': 'deny', 'external_directory': 'deny',
            'webfetch': 'deny', 'websearch': 'deny', 'question': 'deny',
        },
        'plugin': [],
    }
    return json.dumps(value, separators=(',', ':'))


def invocation(harness: str, prompt_path: str, model: str, context_size: int | None = None,
               relay_port=8377, dsh_root: Path | None = None) -> dict:
    relay = ['python3', '/opt/coding/model_relay.py', 'inside', '/home/agent/model.sock', str(relay_port), '--']
    if harness == 'dsh':
        binds = [(str(dsh_root), '/opt/dsh')] if dsh_root is not None else []
        return {'command': [*relay, *dsh_command(prompt_path)], 'environment': {}, 'binds': binds}
    if harness == 'opencode':
        root, entry = opencode_runtime()
        # OpenCode's --file option is variadic. Keep the positional instruction
        # before it and the single prompt path last, or the instruction is parsed
        # as a second filename and the run exits before reaching the model.
        command = ['/opt/harness/' + entry, 'run',
                   'Implement the attached task. Follow its instructions exactly.',
                   '--model', f'agentx-core/{model}', '--agent', 'build',
                   '--format', 'json', '--auto', '--file', prompt_path]
        environment = {
            'OPENCODE_CONFIG_CONTENT': opencode_config(model, context_size, relay_port),
            'OPENCODE_DISABLE_AUTOUPDATE': 'true', 'OPENCODE_DISABLE_DEFAULT_PLUGINS': 'true',
            'OPENCODE_DISABLE_LSP_DOWNLOAD': 'true', 'OPENCODE_DISABLE_MODELS_FETCH': 'true',
            'OPENCODE_CONFIG_DIR': '/home/agent/.config/opencode',
            'XDG_DATA_HOME': '/home/agent/.local/share', 'XDG_CACHE_HOME': '/home/agent/.cache',
        }
        return {'command': [*relay, *command], 'environment': environment,
                'binds': [(str(root), '/opt/harness')]}
    raise RuntimeError(f'Unsupported coding harness: {harness}')
