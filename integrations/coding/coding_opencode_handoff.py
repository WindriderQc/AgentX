"""Idempotent human handoff: independent Git copy and native OpenCode import."""
from __future__ import annotations

import base64
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('handoff_history', HERE / 'coding_opencode_history.py')
history = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(history)
SessionError = history.SessionError


def environment(root):
    # This is the human runtime's existing configuration, never the worker relay
    # config, provider token, MCP setup or private worker home.
    return {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(root),
        'XDG_CONFIG_HOME': str(root / '.config'), 'XDG_DATA_HOME': str(root / '.local/share'),
        'XDG_CACHE_HOME': str(root / '.cache'), 'XDG_STATE_HOME': str(root / '.local/state'),
        'OPENCODE_CONFIG_DIR': str(root / '.config/opencode'),
        'OPENCODE_DISABLE_AUTOUPDATE': 'true', 'OPENCODE_DISABLE_DEFAULT_PLUGINS': 'true',
        'OPENCODE_DISABLE_MODELS_FETCH': 'true', 'OPENCODE_DISABLE_LSP_DOWNLOAD': 'true',
        'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}


def native(command, *, cwd, env, seconds=30):
    process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True)
    try:
        out, err = process.communicate(timeout=seconds)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise SessionError('Native operation timed out; reconcile the original handoff receipt')
    if process.returncode:
        raise SessionError('Native operation failed; retain and reconcile the original handoff receipt')
    return out


def rekey(source, request_id, directory, pipeline_id, recorded_at):
    """Retain native payloads while giving each handoff collision-free native identities."""
    data = copy.deepcopy(source)
    sid = 'ses_' + request_id.replace('-', '')
    def mapped(value, prefix):
        if not isinstance(value, str) or not re.fullmatch(prefix + r'_[a-f0-9]{12}[A-Za-z0-9]{14}', value):
            raise SessionError('The source uses an unqualified native identifier format')
        # Native supplied ids require the type prefix, not a fixed length.
        # Keeping the entire original id preserves order even for equal time
        # prefixes; the full handoff UUID prevents cross-copy collisions.
        return value + request_id.replace('-', '')
    message_ids = {m['info']['id']: mapped(m['info']['id'], 'msg') for m in data['messages']}
    if len(message_ids) != len(data['messages']):
        raise SessionError('Source message identities are ambiguous')
    if data['info'].get('revert'):
        raise SessionError('A reverted source session needs explicit native reconciliation before handoff')
    for key in ('parentID', 'workspaceID', 'revert', 'permission', 'share'):
        data['info'].pop(key, None)
    data['info'].update(id=sid, directory=str(directory), title='Reprise · ' + pipeline_id,
        agent='build', model={'id': 'agentx-primary', 'providerID': 'agentx-core'},
        time={'created': recorded_at, 'updated': recorded_at})
    # The human profile owns permissions and routing. Preserve historical model
    # attribution in messages; never activate worker permission or relay config.
    for message in data['messages']:
        info = message['info']
        info['id'], info['sessionID'] = message_ids[info['id']], sid
        if info.get('parentID'):
            if info['parentID'] not in message_ids:
                raise SessionError('Source message has an unresolved parent reference')
            info['parentID'] = message_ids[info['parentID']]
        for part in message['parts']:
            part.update(id=mapped(part['id'], 'prt'), sessionID=sid, messageID=info['id'])
            if part.get('type') == 'tool' and part.get('state', {}).get('status') not in ('completed', 'error'):
                raise SessionError('An in-flight tool cannot be replayed into a human continuation')
    # A user notice is native history, created without a prompt or inference.
    # Preserve historical arguments/paths verbatim and explain their provenance.
    stamp = ((recorded_at * 4096) + 1) & ((1 << 48) - 1)
    suffix = hashlib.sha256(request_id.encode()).hexdigest()[:14]
    mid = f'msg_{stamp:012x}{suffix}'
    if message_ids and mid <= max(message_ids.values()):
        raise SessionError('Source timestamps exceed the human handoff clock')
    notice = (f'Independent human continuation of Core task {pipeline_id}. '
        f'Source native session: {source["info"]["id"]}. Historical tool arguments and paths belong to the original worker. '
        f'Current working directory: {directory}. Use paths relative to this independent copy. '
        'The original worker, task, budget and publication remain unchanged. '
        'A rejected candidate may be in refs/stash; inspect it before applying it.')
    data['messages'].append({'info': {'id': mid, 'sessionID': sid, 'role': 'user',
        'time': {'created': recorded_at}, 'agent': 'build',
        'model': {'providerID': 'agentx-core', 'modelID': 'agentx-primary'}},
        'parts': [{'id': f'prt_{stamp:012x}{suffix}', 'sessionID': sid, 'messageID': mid,
                   'type': 'text', 'text': notice}]})
    return data


def human_url(origin, directory, sid):
    url = urlsplit(origin)
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment
            or url.path not in ('', '/') or url.scheme == 'http' and url.hostname not in ('127.0.0.1', 'localhost', '::1')):
        raise SessionError('A private HTTPS or loopback human OpenCode origin is required')
    encoded = base64.urlsafe_b64encode(str(directory).encode()).decode().rstrip('=')
    return origin.rstrip('/') + '/' + encoded + '/session/' + sid


def handoff(value, request_id, revision, *, state_root, human_home, binary, origin, node_bin='node'):
    if not history.UUID.fullmatch(request_id or '') or not re.fullmatch(r'[a-f0-9]{64}', revision or ''):
        raise SessionError('A stable handoff request and exact source revision are required')
    # Resolve configured roots before any effect; neither may expose a worker's
    # writable home/repository or nest the human runtime in disposable copies.
    state_root, human_home = Path(state_root), Path(human_home)
    for root in (state_root, human_home):
        if not root.is_absolute() or root.is_symlink() or root.resolve() != root:
            raise SessionError('Handoff roots must be absolute real directories')
    worker_roots = [Path(value['home']), Path(value['workspace'])]
    if any(a.is_relative_to(b) or b.is_relative_to(a) for a in (state_root, human_home) for b in worker_roots):
        raise SessionError('Human and worker state must be independent')
    if state_root == human_home or human_home.is_relative_to(state_root):
        raise SessionError('Keep human runtime state outside disposable handoff repositories')
    sid = 'ses_' + request_id.replace('-', '')
    directory = state_root / request_id
    workspace = directory / 'workspace'
    url = human_url(origin, workspace, sid)
    state_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    human_home.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state_root / '.handoff.lock').open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        receipt_path = directory / 'receipt.json'
        identity = {'pipelineId': value['pipelineId'], 'requestId': value['requestId'],
            'invocationId': value['invocationId'], 'sourceSessionId': value['nativeSessionId'],
            'handoffRequestId': request_id, 'sourceRevision': revision}
        if directory.exists():
            if directory.is_symlink() or not receipt_path.exists():
                raise SessionError('An incomplete handoff directory must be reconciled without replacement')
            receipt = history.read_json(receipt_path)
            if any(receipt.get(k) != v for k, v in identity.items()):
                raise SessionError('This handoff request belongs to another source or revision')
            if receipt['state'] == 'ready':
                return receipt
            # A lost native import response can be reconciled, never relaunched.
            if receipt.get('importHash'):
                imported = history.snapshot(human_home, sid)
                if (history.digest(imported['messages']) == receipt['importHash']
                        and imported['info']['directory'] == str(workspace)):
                    receipt['state'] = 'ready'
                    history.atomic(receipt_path, receipt)
                    return receipt
            raise SessionError('The original handoff is incomplete; no copy or import was retried')
        if value['state'] != 'exited':
            raise SessionError('Wait for the original worker invocation to exit before making a human copy')
        source = history.snapshot(value['home'], value['nativeSessionId'])
        if history.digest(source) != revision:
            raise SessionError('The source history changed; reload before choosing a handoff', 'CODING_SESSION_CHANGED')
        directory.mkdir(mode=0o700)
        receipt = {**identity, 'schema': 'agentx.opencode-human-handoff/v1', 'state': 'preparing',
            'createdAt': int(time.time() * 1000), 'nativeSessionId': sid, 'url': url}
        history.atomic(receipt_path, receipt)
        try:
            env = environment(human_home)
            copied = native([node_bin, str(HERE / 'coding_workspace_copy.mjs'),
                value['workspace'], str(workspace)], cwd=state_root, env=env, seconds=120)
            receipt['files'] = json.loads(copied)
            planned = rekey(source, request_id, workspace, value['pipelineId'], receipt['createdAt'])
            if history.digest(history.snapshot(value['home'], value['nativeSessionId'])) != revision:
                raise SessionError('The native source changed while its repository was copied')
            history.atomic(directory / 'native-import.json', planned)
            receipt.update(state='importing', importHash=history.digest(planned['messages']))
            history.atomic(receipt_path, receipt)
            version = native([str(binary), '--version'], cwd=workspace, env=env).decode().strip()
            if version != '1.19.3':
                raise SessionError('The human import runtime version is not qualified')
            # Native import binds the session to its CLI cwd. Message paths remain
            # historical payloads, explained by the appended provenance notice.
            native([str(binary), 'import', str(directory / 'native-import.json')], cwd=workspace, env=env)
            imported = history.snapshot(human_home, sid)
            if imported['info']['directory'] != str(workspace) or history.digest(imported['messages']) != receipt['importHash']:
                raise SessionError('The complete native import has not been received')
            receipt['state'] = 'ready'
            history.atomic(receipt_path, receipt)
            return receipt
        except BaseException:
            receipt['state'] = 'incomplete'
            history.atomic(receipt_path, receipt)
            raise
