"""Read-only profile disclosures and bounded operational events for the Atelier."""
import hashlib
import json
from pathlib import Path
import selectors
import subprocess
import time

FILES = {
    'identity': ('SOUL.md', 'Identité et mission'),
    'agentx-images': ('skills/agentx-images/SKILL.md', 'Interface image AgentX'),
    'comfyui': ('skills/creative/comfyui/SKILL.md', 'Compétence ComfyUI'),
    'learning': ('workspace/atelier-learning.md', 'Carnet de capacités'),
    'memory': ('memories/MEMORY.md', 'Mémoire du spécialiste'),
}


def resource(home, name, content=False):
    if name not in FILES:
        raise ValueError('Unknown expert resource')
    relative, title = FILES[name]
    file = home / relative
    try:
        resolved = file.resolve(strict=True)
        resolved.relative_to(home.resolve())
        if not resolved.is_file() or resolved.stat().st_size > 65536:
            raise ValueError('Expert resource unavailable')
        raw = resolved.read_bytes()
        if len(raw) > 65536:
            raise ValueError('Expert resource too large')
        result = {'id': name, 'title': title, 'path': relative, 'available': True,
                  'sha256': hashlib.sha256(raw).hexdigest(),
                  'updatedAt': int(resolved.stat().st_mtime * 1000), 'bytes': len(raw)}
        if content:
            result['content'] = raw.decode('utf-8')
        return result
    except (OSError, UnicodeError, ValueError):
        return {'id': name, 'title': title, 'path': relative, 'available': False}


def describe(home):
    # Only selected model fields leave the profile; credentials and endpoints never do.
    try:
        raw = (home / 'config.yaml').read_text()
        try:
            config = json.loads(raw)
        except ValueError:
            import yaml
            config = yaml.safe_load(raw)
        model = config.get('model', {})
        fallback = config.get('fallback_providers', [])
        routing = {'model': model.get('default'), 'provider': model.get('provider'),
                   'freeOnly': str(model.get('default', '')).endswith(':free') and config.get('auxiliary', {}).get('free_only') is True,
                   'fallbackModels': [row.get('model') for row in fallback if isinstance(row, dict)]}
    except (OSError, ValueError, ImportError, AttributeError, TypeError):
        routing = {'model': None, 'provider': None, 'freeOnly': None, 'fallbackModels': []}
    return {'ok': True, 'expert': 'hermes', 'profile': 'imagex', 'routing': routing,
            'resources': [resource(home, key) for key in FILES],
            'capabilities': {'chat': True, 'planning': True, 'visualInspection': False,
                             'profileWrites': False, 'shell': False}}


def communicate_events(child, prompt, emit, timeout=150):
    """Drain both pipes with an absolute deadline; expose names/timings, never tool payloads."""
    child.stdin.write(prompt)
    child.stdin.close()
    deadline = time.monotonic() + timeout
    output, pending, size, count = [], b'', 0, 0
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(child.args, timeout)
            for key, _ in selector.select(min(0.5, max(0, deadline - time.monotonic()))):
                data = key.fileobj.buffer.read1(8192)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                if key.data == 'stderr':
                    continue
                size += len(data)
                if size > 1048576:
                    raise ValueError('Expert response exceeded its limit')
                output.append(data)
                pending += data
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    kind = event.get('type')
                    if count >= 80:
                        continue
                    safe = None
                    if kind == 'system' and event.get('subtype') == 'init':
                        safe = {'type': 'started', 'reportedModel': str(event.get('model') or '')[:200]}
                    elif kind in ('tool_use', 'tool_result'):
                        safe = {'type': kind, 'name': str(event.get('name') or 'unknown')[:120]}
                        if kind == 'tool_result':
                            safe.update(durationMs=event.get('duration_ms'), failed=event.get('is_error') is True)
                    if safe:
                        count += 1
                        emit({**safe, 'at': int(time.time() * 1000)})
        child.wait(timeout=max(0.01, deadline - time.monotonic()))
    return b''.join(output).decode('utf-8'), ''
