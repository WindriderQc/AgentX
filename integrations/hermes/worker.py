#!/usr/bin/env python3
"""Bounded JSON-in/JSON-out Hermes consultation. It never submits an image."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import re
import subprocess
import sys
import tempfile


def query(payload):
    action = payload.get('action')
    brief = payload.get('request', {}).get('prompt') if action == 'plan' else payload.get('prompt')
    if action not in ('plan', 'consult') or not isinstance(brief, str) or not brief.strip() or len(brief) > 8000:
        raise ValueError('Invalid image expert request')
    instruction = (
        'Prepare an image-generation plan. Return ONLY a JSON object with prompt, profile, width, height, '
        'and reason. Choose a profile from the supplied current status. Respect every explicit profile '
        'and dimension in the request, multiples of 32 and the profile pixel budget. Use 1024x1024 '
        'when no format is specified and it fits. Improve the brief without changing its subject or intent. '
        'For editing, retain the order of image 1 and image 2. Do not execute generation: the caller '
        'will submit this plan to Core after your run exits.'
        if action == 'plan' else
        'Give concise expert advice about image generation and ComfyUI. Use supplied current status '
        'to distinguish installed capabilities from suggestions. Do not create images, change the '
        'host, install dependencies, or claim to have inspected anything absent from the supplied evidence.'
    )
    return instruction + '\n\nRequest and current Core evidence:\n' + json.dumps(payload, ensure_ascii=False)


def run(payload):
    profile = os.environ.get('IMAGEX_PROFILE', 'imagex')
    home = Path(os.environ.get('IMAGEX_HOME', str(Path.home() / '.hermes' / 'profiles' / profile)))
    if not (home / 'config.yaml').is_file():
        raise ValueError('Image expert profile is not configured')
    prompt = query(payload)
    key = payload.get('actionKey') if payload.get('action') == 'plan' else None
    if key is not None and (not isinstance(key, str) or not re.fullmatch('[a-f0-9]{64}', key)):
        raise ValueError('Invalid native request identity')
    source_hash = hashlib.sha256(json.dumps(payload.get('request'), sort_keys=True).encode()).hexdigest()
    with (home / '.worker.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Image expert is busy; no image was submitted')
        cache = home / 'plans' / (key + '.json') if key else None
        if cache and cache.exists():
            saved = json.loads(cache.read_text())
            if saved.get('sourceHash') != source_hash:
                raise ValueError('This request identity belongs to a different image brief')
            return saved['result']
        binary = os.environ.get('HERMES_BIN', str(Path.home() / '.local' / 'bin' / 'hermes'))
        command = [binary, '-p', profile, 'chat', '--query-file', '-', '--format', 'stream-json',
                   '--toolsets', 'skills', '--skills', 'agentx-images', '--skills', 'comfyui',
                   '--max-turns', '4', '--run-budget', '120', '--source', 'tool']
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, cwd=home / 'workspace', start_new_session=True)
        try:
            output, _ = child.communicate(prompt, timeout=150)
        except BaseException:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
            raise
        if child.returncode != 0 or len(output.encode()) > 1048576:
            raise ValueError('Hermes consultation did not complete')
        events = [json.loads(line) for line in output.splitlines() if line.strip().startswith('{')]
        results = [event for event in events if event.get('type') == 'result']
        if len(results) != 1 or results[0].get('exit_code') != 0 or not results[0].get('text'):
            raise ValueError('Hermes returned no final result')
        result = results[0]
        model = next((event.get('model') for event in events if event.get('subtype') == 'init'), None)
        value = {'ok': True, 'expert': 'hermes', 'profile': profile, 'model': model,
                'sessionId': result.get('session_id'), 'text': result['text'],
                'tokens': result.get('tokens'), 'durationMs': result.get('duration_ms')}
        if cache:
            cache.parent.mkdir(mode=0o700, exist_ok=True)
            fd, temporary = tempfile.mkstemp(dir=cache.parent)
            try:
                with os.fdopen(fd, 'w') as file:
                    json.dump({'sourceHash': source_hash, 'result': value}, file)
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(temporary, cache)
                directory = os.open(cache.parent, os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return value


if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise InterruptedError('Image expert interrupted')

    signal.signal(signal.SIGTERM, interrupted)
    try:
        raw = sys.stdin.read(65537)
        if len(raw.encode()) > 65536:
            raise ValueError('Request too large')
        print(json.dumps(run(json.loads(raw)), ensure_ascii=False))
    except BaseException as error:
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, ValueError) else 'Image expert invocation failed'}))
        sys.exit(1)
