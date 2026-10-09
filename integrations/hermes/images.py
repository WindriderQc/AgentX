#!/usr/bin/env python3
"""AgentX's local image API, with idempotent creation and verified downloads."""
import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Images:
    def __init__(self, base=None):
        base = base or os.environ.get('AGENTX_URL', '')
        url = urllib.parse.urlsplit(base)
        try:
            local = url.hostname == 'localhost' or ipaddress.ip_address(url.hostname).is_private
        except ValueError:
            local = False
        if not local or url.scheme not in ('http', 'https') or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
            raise ValueError('Configure AGENTX_URL as an explicit local/LAN Core origin')
        self.base = base.rstrip('/')
        self.opener = urllib.request.build_opener(NoRedirect())

    def read(self, path, body=None, limit=1048576):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data,
                                        headers={'Content-Type': 'application/json'} if data else {})
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(limit + 1)
        except urllib.error.HTTPError as error:
            try:
                message = json.loads(error.read(4096)).get('message')
            except (ValueError, UnicodeError):
                message = None
            raise ValueError(message or f'Core image API refused the request ({error.code})') from None
        if len(raw) > limit:
            raise ValueError('Core response exceeded its limit')
        return raw

    def json(self, path, body=None):
        value = json.loads(self.read(path, body))
        if not isinstance(value, dict) or value.get('ok') is not True:
            raise ValueError('Core returned no successful image receipt')
        return value

    def download(self, operation, output):
        value = self.json('/api/images/operations/' + str(uuid.UUID(operation)))['operation']
        artifact = value.get('artifact', {})
        expected = '/api/images/operations/' + str(uuid.UUID(operation)) + '/image'
        if value.get('state') != 'completed' or value.get('runtimeRestored') is not True or artifact.get('url') != expected:
            raise ValueError('Image is not completed with verified runtime restoration')
        raw = self.read(expected, limit=50 * 1024 * 1024)
        if hashlib.sha256(raw).hexdigest() != artifact.get('sha256'):
            raise ValueError('Archived image integrity check failed')
        target = Path(output).expanduser()
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as file:
            file.write(raw)
        return {'ok': True, 'operationId': operation, 'sha256': artifact['sha256'], 'file': str(target.resolve())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('status')
    sub.add_parser('workshop')
    create = sub.add_parser('create')
    create.add_argument('--key', required=True)
    create.add_argument('--prompt', required=True)
    create.add_argument('--profile')
    create.add_argument('--width', type=int, default=1024)
    create.add_argument('--height', type=int, default=1024)
    create.add_argument('--seed', type=int)
    create.add_argument('--reference', action='append', default=[])
    create.add_argument('--parent-operation')
    create.add_argument('--parent-sha')
    for name in ['operation', 'download']:
        command = sub.add_parser(name)
        command.add_argument('operation_id')
        if name == 'download':
            command.add_argument('--output', required=True)
    args = parser.parse_args()
    client = Images()
    if args.action in ('status', 'workshop'):
        return client.json('/api/images/' + args.action)
    if args.action == 'download':
        return client.download(args.operation_id, args.output)
    if args.action == 'operation':
        return client.json('/api/images/operations/' + str(uuid.UUID(args.operation_id)))
    if not re.fullmatch('[a-zA-Z0-9:_.-]{8,160}', args.key):
        raise ValueError('Request key must contain 8–160 letters, digits or :_.-')
    if len(args.reference) > 2:
        raise ValueError('Two references at most')
    body = {'actionKey': args.key, 'prompt': args.prompt, 'width': args.width, 'height': args.height}
    for key in ['profile', 'seed']:
        if getattr(args, key) is not None:
            body[key] = getattr(args, key)
    if args.reference:
        references = []
        for name in args.reference:
            raw = Path(name).read_bytes()
            if len(raw) > 2.25 * 1024 * 1024:
                raise ValueError('Reference exceeds the Core request limit')
            references.append(base64.b64encode(raw).decode())
        body['references'] = references
    if args.parent_operation or args.parent_sha:
        if not args.parent_operation or not re.fullmatch('[a-f0-9]{64}', args.parent_sha or ''):
            raise ValueError('A parent requires its operation ID and exact SHA-256')
        body['parent'] = {'operationId': str(uuid.UUID(args.parent_operation)), 'sha256': args.parent_sha}
    return client.json('/api/images/operations', body)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except (ValueError, OSError, urllib.error.URLError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
