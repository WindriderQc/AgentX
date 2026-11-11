#!/usr/bin/env python3
"""Refresh configured AgentX HTTP tool catalogues without restarting Codex.

Uses the native configuration CAS and reload APIs. Does not invoke tools.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import threading
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from uuid import uuid4

from app_server_rpc import Client


def log(message):
    print(f'[agentx-catalog-watch] {message}', flush=True)


def read_catalog(server, timeout=15):
    """Read one complete stateless Core catalogue, retaining its bus boundary."""
    tools, names, cursors = [], set(), set()
    cursor = None
    for _ in range(100):
        request_id = f'agentx-catalog-{uuid4()}'
        message = {'jsonrpc': '2.0', 'id': request_id, 'method': 'tools/list'}
        if cursor is not None:
            message['params'] = {'cursor': cursor}
        headers = {
            'Content-Type': 'application/json', 'Accept': 'application/json',
            **(server.get('http_headers') or {}),
        }
        request = Request(server['url'], data=json.dumps(message).encode(), headers=headers)
        with urlopen(request, timeout=timeout) as response:
            payload = response.read(8_000_001)
        if len(payload) > 8_000_000:
            raise RuntimeError('catalogue response too large')
        response = json.loads(payload)
        result = response.get('result', {})
        if response.get('id') != request_id or response.get('error') or not isinstance(result.get('tools'), list):
            raise RuntimeError('incomplete catalogue response')
        for tool in result['tools']:
            name = tool.get('name') if isinstance(tool, dict) else None
            if not isinstance(name, str) or not name or name in names:
                raise RuntimeError('invalid or duplicate tool name')
            names.add(name)
            tools.append(tool)
        cursor = result.get('nextCursor')
        if cursor is None:
            ordered = sorted(tools, key=lambda tool: tool['name'])
            fingerprint = hashlib.sha256(json.dumps(ordered, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            return fingerprint, len(tools)
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise RuntimeError('catalogue pagination did not advance')
        cursors.add(cursor)
    raise RuntimeError('catalogue exceeds 100 pages')


def revision_url(url, fingerprint):
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.netloc:
        raise ValueError('only configured HTTP MCP buses can be watched')
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
             if key != 'catalog_revision']
    query.append(('catalog_revision', fingerprint))
    return urlunsplit(parts._replace(query=urlencode(query)))


class Journal:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    def pending(self):
        return self.path.exists() and json.loads(self.path.read_text()).get('pending_reload', False)

    def write(self, pending):
        temporary = self.path.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump({'pending_reload': pending}, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.path)
        directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def refresh_once(client, server_names, journal, fetch=read_catalog):
    # A lost write or reload response is reconciled before another catalogue read.
    # Repeating a configuration reload is safe; never repeat a tool call.
    if journal.pending():
        client.rpc('config/mcpServer/reload', None)
        journal.write(False)
    snapshot = client.rpc('config/read', {'includeLayers': True})
    groups, failed = {}, []
    for name in server_names:
        if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
            raise ValueError('invalid configured server name')
        server = snapshot['config'].get('mcp_servers', {}).get(name)
        if not server or server.get('enabled') is False or not server.get('url'):
            continue
        # Restrict edits to the original user-owned URL, never credentials or tools.
        key = f'mcp_servers.{name}.url'
        origin = snapshot.get('origins', {}).get(key, {})
        source = origin.get('name', {})
        if source.get('type') != 'user' or not source.get('file') or not origin.get('version'):
            raise RuntimeError(f'{name}: HTTP URL is not user-owned')
        try:
            fingerprint, count = fetch(server)
        except Exception:
            failed.append(name)
            continue
        updated = revision_url(server['url'], fingerprint)
        if updated == server['url']:
            continue
        group = (source['file'], origin['version'])
        groups.setdefault(group, []).append((name, count, {
            'keyPath': key, 'value': updated, 'mergeStrategy': 'replace',
        }))
    for (filename, version), changes in groups.items():
        # Persist intent before CAS: failure/uncertainty keeps a reload pending.
        journal.write(True)
        result = client.rpc('config/batchWrite', {
            'filePath': filename, 'expectedVersion': version,
            'edits': [change[2] for change in changes],
        })
        if result.get('status') != 'ok':
            raise RuntimeError('Codex configuration write did not complete')
        client.rpc('config/mcpServer/reload', None)
        journal.write(False)
        for name, count, _ in changes:
            log(f'{name}: refreshed {count} tools')
    if failed:
        raise RuntimeError('one or more catalogues unavailable')
    return sum(len(changes) for changes in groups.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    codex_home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    state_home = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state')))
    parser.add_argument('--socket', default=str(codex_home / 'app-server-control/app-server-control.sock'))
    parser.add_argument('--server', action='append', required=True)
    parser.add_argument('--state-file', default=str(state_home / 'agentx/codex-catalog-watch.json'))
    parser.add_argument('--interval', type=float, default=30)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    if args.interval <= 0:
        parser.error('--interval must be positive')
    journal = Journal(args.state_file)
    lock = open(str(journal.path) + '.lock', 'a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        parser.exit(1, 'another catalogue watcher owns this state file\n')
    stopped = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopped.set())
    log(f'watching {len(set(args.server))} configured buses every {args.interval:g}s')
    failures = 0
    while not stopped.is_set():
        client = None
        try:
            client = Client(args.socket)
            refresh_once(client, args.server, journal)
            if failures:
                log('discovery recovered')
            failures = 0
        except Exception as error:
            # Do not print exception payloads: upstream errors may contain private URLs.
            if not failures:
                log(f'discovery unavailable ({type(error).__name__}); catalogue retained')
            failures += 1
            if args.once:
                return 1
        finally:
            if client:
                try:
                    client.close()
                except OSError:
                    pass
        if args.once:
            return 0
        stopped.wait(args.interval * 2 ** min(failures, 4))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
