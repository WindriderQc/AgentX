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
from studio import describe, resource, communicate_events
from text_policy import planning_instruction, budget_instruction

MAX_BRIEF = 32000
MAX_PROMPT = 8000
MAX_ENVELOPE_UNITS = 60000
MAX_ENVELOPE_BYTES = 65536
CONSTRAINT_KINDS = {'exact-text': 'Texte exact à afficher', 'required-element': 'Élément obligatoire',
                    'composition': 'Composition ou relation'}
JS_TRIM = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def utf16_length(value):
    try:
        return len(value.encode('utf-16-le')) // 2
    except UnicodeEncodeError:
        raise ValueError('Invalid Unicode text') from None


def protected_suffix(value):
    if not isinstance(value, dict) or set(value) != {'version', 'items'} or type(value['version']) is not int or value['version'] != 1:
        raise ValueError('Invalid explicit image constraints')
    items = value['items']
    if not isinstance(items, list) or len(items) > 20:
        raise ValueError('Invalid explicit image constraints')
    identifiers, lines, total = set(), [], 0
    for item in items:
        if not isinstance(item, dict) or set(item) != {'id', 'kind', 'text'}:
            raise ValueError('Invalid explicit image constraints')
        identifier, kind, text = item['id'], item['kind'], item['text']
        if (not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', identifier)
                or identifier in identifiers or not isinstance(kind, str) or kind not in CONSTRAINT_KINDS
                or not isinstance(text, str) or not text.strip(JS_TRIM) or len(text) > 300):
            raise ValueError('Invalid explicit image constraints')
        if any((ord(character) < 32 and character not in '\t\n\r') or 0xD800 <= ord(character) <= 0xDFFF
               or ord(character) in (0xFFFE, 0xFFFF) for character in text):
            raise ValueError('Invalid explicit image constraints')
        identifiers.add(identifier)
        total += len(text)
        if total > 4000:
            raise ValueError('Invalid explicit image constraints')
        lines.append('- ' + CONSTRAINT_KINDS[kind] + ' : «' + text + '»')
    return 'CONTRAINTES EXPLICITES À CONSERVER\n' + '\n'.join(lines) + '\nFIN DES CONTRAINTES EXPLICITES' if lines else ''


def query(payload, serialized=None):
    if not isinstance(payload, dict):
        raise ValueError('Invalid image expert request')
    action = payload.get('action')
    request = payload.get('request', {}) if action == 'plan' else payload.get('context', {})
    if not isinstance(request, dict):
        raise ValueError('Invalid image expert context')
    brief = request.get('prompt') if action == 'plan' else payload.get('prompt')
    if action not in ('plan', 'consult') or not isinstance(brief, str) or not brief.strip(JS_TRIM) or utf16_length(brief) > MAX_BRIEF:
        raise ValueError('Invalid image expert request')
    if 'prompt' in request and (not isinstance(request['prompt'], str) or utf16_length(request['prompt']) > MAX_BRIEF):
        raise ValueError('Invalid image expert context')
    if 'instruction' in request and (not isinstance(request['instruction'], str) or utf16_length(request['instruction']) > MAX_BRIEF):
        raise ValueError('Invalid image expert instruction')
    suffix = protected_suffix(request['constraints']) if 'constraints' in request else ''
    visual = request.get('prompt', '').strip(JS_TRIM)
    if suffix and visual.endswith('\n\n' + suffix):
        visual = visual[:-len(suffix) - 2].strip(JS_TRIM)
    if utf16_length(visual + ('\n\n' + suffix if suffix else '')) > MAX_BRIEF:
        raise ValueError('Brief and explicit constraints exceed 32000 UTF-16 units')
    visual_budget = MAX_PROMPT - (utf16_length(suffix) + 2 if suffix else 0)
    text_instruction = planning_instruction(request['textPolicy'], request.get('constraints')) if 'textPolicy' in request else ''
    if text_instruction:
        label_units = sum(utf16_length(item['text']) + utf16_length(item['placement']) + 40
                          for item in request['textPolicy']['labels'])
        visual_budget = max(128, visual_budget - max(1800, label_units + 600))
    budget_text = ''
    if action == 'plan' and 'renderBudget' in request:
        budget_text, visual_budget = budget_instruction(request['renderBudget'])
    instruction = (
        'Prepare an image-generation plan. Return ONLY a JSON object with prompt, profile, width, height, '
        'and reason, plus textPlan only when the text preparation instructions below require it. Choose a profile from the supplied current status ONLY when the request has no profile. Respect every explicit profile '
        'and dimension in the request, multiples of 32 and the profile pixel budget. Use 1024x1024 '
        'when no format is specified and it fits. Improve the brief without changing its subject or intent. '
        'For editing, retain the order of image 1 and image 2. Do not execute generation: the caller '
        'will submit this plan to Core after your run exits. The final rendering prompt must contain '
        f'at most {MAX_PROMPT} UTF-16 code units INCLUDING the exact protected-constraints suffix. '
        f'The effective maximum for your visual description is {visual_budget} UTF-16 code units. '
        'Return only the visual description in prompt; Core appends the protected suffix unchanged. '
        'Condense the original brief into that budget while preserving its intent and explicit constraints.'
        if action == 'plan' else
        'Give concise expert advice about image generation and ComfyUI. Use supplied current status '
        'to distinguish installed capabilities from suggestions. Do not create images, change the '
        'host, install dependencies, or claim to have inspected anything absent from the supplied evidence.'
    )
    instruction += text_instruction
    instruction += budget_text
    if text_instruction:
        instruction += (' The budget also includes Core text instructions. For two-pass, Core retains exact '
                        'texts as saved metadata and editable layers, and removes exact-text entries from the '
                        'rendering suffix. Do not include lettering instructions or a Core suffix in prompt.')
    if action == 'plan':
        fixed = {key: request[key] for key in ('profile', 'width', 'height') if key in request}
        if fixed:
            instruction += (' Fixed request settings (copy these JSON values unchanged into your result): '
                            + json.dumps(fixed, ensure_ascii=False) + '. These settings take priority over '
                            'any recipe or resolution mentioned in the brief, instructions or earlier history. '
                            'Refine the visual prompt and reason; do not redesign these fixed settings.')
    boundary = (' Core currently exposes text creation, zero to two ordered image references, configured '
                'profiles, dimensions, seed, archived history/details and verified recipe export. Installed '
                'ComfyUI nodes do not establish a Core capability. Core does not expose masks, denoise '
                'controls, standalone upscaling, ControlNet, LoRA, arbitrary graphs or recipe import. '
                'Do not claim these are live, or promise identical pixels from seed or export alone.')
    boundary += (' In this Atelier, imageX is the image specialist implemented with Hermes. AgentX hosts '
                 'the UI and owns the canonical conversation history and production state. Hermes owns '
                 'its private specialist skills, memory and execution transcripts; those are not the '
                 'Atelier canonical history. OpenClaw transports this consultation. ComfyUI executes '
                 'Core-built workflows. Step counts alone prove neither relative speed nor image quality; '
                 'do not invent performance ratios or assert superior detail without measured evidence. '
                 'Use plain text for advice unless the request explicitly asks for Markdown.')
    history = payload.get('history', [])
    if not isinstance(history, list) or len(history) > 12 or any(
            not isinstance(row, dict) or row.get('role') not in ('user', 'assistant')
            or not isinstance(row.get('content'), str) or utf16_length(row['content']) > MAX_ENVELOPE_UNITS for row in history):
        raise ValueError('Invalid bounded conversation history')
    # The CLI checks the original transport JSON. Direct callers use compact JSON.
    serialized = serialized if serialized is not None else json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    if utf16_length(serialized) > MAX_ENVELOPE_UNITS or len(serialized.encode('utf-8')) > MAX_ENVELOPE_BYTES:
        raise ValueError('Image expert envelope exceeds 60000 UTF-16 units or 65536 JSON bytes')
    return instruction + boundary + ' Reply in French; image prompts may use English. Reference images are NOT supplied to you: never describe their visual content.' + '\n\nRequest and current Core evidence:\n' + serialized


def run(payload, emit=None, serialized=None):
    profile = os.environ.get('IMAGEX_PROFILE', 'imagex')
    home = Path(os.environ.get('IMAGEX_HOME', str(Path.home() / '.hermes' / 'profiles' / profile)))
    if not (home / 'config.yaml').is_file():
        raise ValueError('Image expert profile is not configured')
    if payload.get('action') == 'describe':
        return describe(home)
    if payload.get('action') == 'resource':
        return {'ok': True, 'expert': 'hermes', 'resource': resource(home, payload.get('id'), True)}
    prompt = query(payload, serialized)
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
                   '--toolsets', 'skills,vision', '--skills', 'agentx-images', '--skills', 'comfyui',
                   '--max-turns', '4', '--run-budget', '120', '--source', 'tool']
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, cwd=home / 'workspace', start_new_session=True)
        try:
            output, _ = communicate_events(child, prompt, emit) if emit else child.communicate(prompt, timeout=150)
        except BaseException:
            os.killpg(child.pid, signal.SIGTERM)
            if emit:
                # communicate() must not try to flush the already closed stdin.
                child.stdin = None
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
        streaming = '--events' in sys.argv
        emit = (lambda event: print(json.dumps(event, ensure_ascii=False), flush=True)) if streaming else None
        value = run(json.loads(raw), emit, raw)
        print(json.dumps({'type': 'result', 'result': value} if streaming else value, ensure_ascii=False), flush=True)
    except BaseException as error:
        value = {'ok': False, 'error': str(error) if isinstance(error, ValueError) else 'Image expert invocation failed'}
        print(json.dumps({'type': 'result', 'result': value} if '--events' in sys.argv else value), flush=True)
        sys.exit(1)
