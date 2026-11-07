"""Host-owned request bindings and read-only snapshots of native OpenCode history."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import time
from urllib.parse import quote
from uuid import uuid4

UUID = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
SESSION = re.compile(r'^ses_[A-Za-z0-9]+$')
SCHEMA = 'agentx.opencode-worker-binding/v1'
MAX_BYTES = 16 * 1024 * 1024


class SessionError(RuntimeError):
    def __init__(self, message, code='CODING_SESSION_UNAVAILABLE', status=409):
        super().__init__(message)
        self.code, self.status = code, status


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=path.parent, mode='wb', delete=False) as stream:
        stream.write(encoded(value))
        stream.flush()
        os.fsync(stream.fileno())
        temporary = stream.name
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_json(path, limit=65536):
    if path.is_symlink() or not path.resolve().is_relative_to(path.parent.resolve()):
        raise SessionError('The native receipt path is invalid')
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise SessionError('The native receipt exceeds its bound')
    return json.loads(data)


class Capture:
    """Only the host runner can write this binding; worker stdout supplies its native id."""
    def __init__(self, progress, home, workspace):
        if not UUID.fullmatch(progress.request_id) or not re.fullmatch(r'\d{4}', progress.task_id):
            raise SessionError('An exact Core request and task are required')
        invocation = str(uuid4())
        self.path = progress.path.parent / (progress.request_id + '.sessions') / (invocation + '.json')
        if self.path.parent.resolve().is_relative_to(home.resolve()) or self.path.parent.resolve().is_relative_to(workspace.resolve()):
            raise SessionError('Native bindings must remain outside worker-writable roots')
        self.offset = 0
        self.value = {'schema': SCHEMA, 'harness': 'opencode', 'pipelineId': progress.task_id,
            'requestId': progress.request_id, 'invocationId': invocation, 'nativeSessionId': None,
            'home': str(home.resolve(strict=True)), 'workspace': str(workspace.resolve(strict=True)),
            'state': 'running', 'createdAt': int(time.time() * 1000)}
        atomic(self.path, self.value)

    def scan(self, output):
        changed = False
        with output.open('rb') as stream:
            stream.seek(self.offset)
            start = self.offset
            for _ in range(10000):
                if self.offset - start >= 32 * 1024 * 1024:
                    break
                line = stream.readline(4 * 1024 * 1024 + 1)
                if len(line) > 4 * 1024 * 1024:
                    raise SessionError('Native output record exceeds its bound')
                if not line or not line.endswith(b'\n'):
                    break  # Retry an incomplete record at its original offset.
                self.offset = stream.tell()
                try:
                    event = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue  # CLI diagnostics are not native session identities.
                sid = event.get('sessionID') if isinstance(event, dict) else None
                if sid is None:
                    continue
                if not isinstance(sid, str) or not SESSION.fullmatch(sid):
                    raise SessionError('Invalid native session identity')
                if self.value['nativeSessionId'] not in (None, sid):
                    raise SessionError('A worker invocation emitted conflicting native identities')
                if self.value['nativeSessionId'] != sid:
                    self.value['nativeSessionId'] = sid
                    changed = True
        if changed:
            atomic(self.path, self.value)

    def finish(self, returncode):
        # Local child completion is not Core model termination or task acceptance.
        self.value.update(state='exited' if returncode is not None else 'uncertain', returncode=returncode)
        atomic(self.path, self.value)


def database(home):
    root = Path(home)
    if root.is_symlink() or root.resolve(strict=True) != root:
        raise SessionError('The bound native home changed its identity')
    path = root / '.local/share/opencode/opencode.db'
    if (not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root)
            or any(Path(str(path) + suffix).is_symlink() for suffix in ('-wal', '-shm'))):
        raise SessionError('The bound native database is unavailable')
    return path


def snapshot(home, sid):
    if not SESSION.fullmatch(sid or ''):
        raise SessionError('No native session has been received for this invocation')
    path = database(home)
    # mode=ro reads committed WAL updates; immutable=1 would miss a live writer.
    connection = sqlite3.connect('file:' + quote(str(path)) + '?mode=ro', uri=True, timeout=2)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA trusted_schema=OFF')
        connection.execute('BEGIN')
        # Bound allocation before fetching potentially large JSON values.
        counts = connection.execute('SELECT count(*), coalesce(sum(length(CAST(data AS BLOB))),0) FROM message WHERE session_id=?', (sid,)).fetchone()
        part_bytes = connection.execute('SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM part WHERE session_id=?', (sid,)).fetchone()[0]
        if counts[0] > 10000 or counts[1] + part_bytes > MAX_BYTES:
            raise SessionError('Native history exceeds the complete snapshot bound', status=413)
        columns = {item[1] for item in connection.execute('PRAGMA table_info(session)')}
        required = ['id', 'slug', 'project_id', 'directory', 'title', 'version', 'time_created', 'time_updated']
        if not set(required).issubset(columns):
            raise SessionError('The native session header schema is not qualified')
        selected = required + [key for key in ('parent_id', 'workspace_id', 'agent', 'permission', 'model', 'revert', 'metadata') if key in columns]
        # Only whitelisted native columns enter SQL; bound header allocation too.
        lengths = '+'.join(f'coalesce(length(CAST("{key}" AS BLOB)),0)' for key in selected)
        header_size = connection.execute(f'SELECT {lengths} FROM session WHERE id=?', (sid,)).fetchone()
        if header_size and header_size[0] > 65536:
            raise SessionError('Native session header exceeds its bound', status=413)
        fields = ','.join('"' + key + '"' for key in selected)
        row = connection.execute(f'SELECT {fields} FROM session WHERE id=?', (sid,)).fetchone()
        if not row or row['version'] != '1.19.3':
            raise SessionError('The bound session is missing or its native schema is not qualified')
        info = {'id': sid, 'slug': row['slug'], 'projectID': row['project_id'],
            'directory': row['directory'], 'title': row['title'], 'version': row['version'],
            'time': {'created': row['time_created'], 'updated': row['time_updated']}}
        for column, key in [('parent_id', 'parentID'), ('workspace_id', 'workspaceID'), ('agent', 'agent')]:
            if column in row.keys() and row[column] is not None:
                info[key] = row[column]
        for column, key in [('permission', 'permission'), ('model', 'model'), ('revert', 'revert'), ('metadata', 'metadata')]:
            if column in row.keys() and row[column] is not None:
                info[key] = json.loads(row[column])
        messages, size = [], 0
        for message in connection.execute('SELECT id, data FROM message WHERE session_id=? ORDER BY id LIMIT 10001', (sid,)):
            size += len(message['data'].encode())
            if len(messages) >= 10000 or size > MAX_BYTES:
                raise SessionError('Native history exceeds the complete snapshot bound', status=413)
            parts = []
            for part in connection.execute('SELECT id, data FROM part WHERE session_id=? AND message_id=? ORDER BY id', (sid, message['id'])):
                size += len(part['data'].encode())
                if size > MAX_BYTES:
                    raise SessionError('Native history exceeds the complete snapshot bound', status=413)
                parts.append({**json.loads(part['data']), 'id': part['id'], 'sessionID': sid, 'messageID': message['id']})
            messages.append({'info': {**json.loads(message['data']), 'id': message['id'], 'sessionID': sid}, 'parts': parts})
        return {'info': info, 'messages': messages}
    finally:
        connection.close()


def public_binding(value):
    return {key: value.get(key) for key in ('pipelineId', 'requestId', 'invocationId', 'nativeSessionId', 'harness', 'state', 'createdAt')}


def bindings(receipts, pipeline_id, request_id):
    run = read_json(receipts / (request_id + '.json'))
    if run.get('pipelineId') != pipeline_id or run.get('requestId') != request_id:
        raise SessionError('The native run does not match this Core task and request')
    root = receipts / (request_id + '.sessions')
    if root.is_symlink():
        raise SessionError('Invalid binding root')
    values = []
    for path in sorted(root.glob('*.json')):
        value = read_json(path)
        if (value.get('schema') != SCHEMA or value.get('pipelineId') != pipeline_id
                or value.get('requestId') != request_id or value.get('harness') != 'opencode'
                or not UUID.fullmatch(value.get('invocationId', '')) or path.stem != value['invocationId']):
            raise SessionError('A native worker binding conflicts with its Core request')
        values.append(value)
    return values


def select(receipts, pipeline_id, request_id, invocation_id):
    values = [v for v in bindings(receipts, pipeline_id, request_id) if v['invocationId'] == invocation_id]
    if len(values) != 1:
        raise SessionError('The exact worker invocation is unavailable')
    return values[0]


def read(value, *, offset=0, expected_revision=None):
    data = snapshot(value['home'], value['nativeSessionId'])
    revision = digest(data)
    if expected_revision and expected_revision != revision:
        raise SessionError('Native history changed; reload its first page', 'CODING_SESSION_CHANGED')
    page, size = [], 0
    for message in data['messages'][offset:]:
        length = len(encoded(message))
        if length > 2 * 1024 * 1024:
            raise SessionError('A native message exceeds the page bound', status=413)
        if len(page) == 20 or size + length > 2 * 1024 * 1024:
            break
        page.append(message)
        size += length
    end = offset + len(page)
    return {**public_binding(value), 'revision': revision, 'messages': page, 'totalMessages': len(data['messages']),
        'nextOffset': end if end < len(data['messages']) else None,
        'canHandoff': value['state'] == 'exited' and not any(p.get('state', {}).get('status') in ('running', 'pending')
            for m in data['messages'] for p in m['parts'] if p.get('type') == 'tool')}
