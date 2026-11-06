#!/usr/bin/env python3
"""Read-only native observations. Targets belong to a private instance manifest.

No discovery, credentials, execution of configured commands, model calls or raw
Docker inspect output. Timestamps attest the observed source, never cache reads.
"""
import argparse
import concurrent.futures
import datetime
import hashlib
import ipaddress
import json
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

ID = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
TARGET = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}$')
SOURCES = {'docker': 'native_process', 'systemd': 'native_process',
           'http': 'http_interface', 'network': 'network_presence'}


def stamp(seconds=None):
    at = datetime.datetime.now(datetime.timezone.utc) if seconds is None else datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
    return at.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def local_url(value):
    url = urllib.parse.urlsplit(value)
    address = ipaddress.ip_address(url.hostname or '')
    if (url.scheme not in ('http', 'https') or url.username or url.password or url.query or url.fragment
            or not (address.is_loopback or address in ipaddress.ip_network('10.0.0.0/8')
                    or address in ipaddress.ip_network('172.16.0.0/12') or address in ipaddress.ip_network('192.168.0.0/16'))
            or re.search(r'[\s\\]', value) or url.port is not None and not 1 <= url.port <= 65535):
        raise ValueError('Invalid private HTTP target')
    return value


def validate(raw):
    if set(raw) != {'version', 'checks'} or raw['version'] != 1 or not isinstance(raw['checks'], list) or len(raw['checks']) > 64:
        raise ValueError('Invalid observations manifest')
    seen = set()
    for row in raw['checks']:
        kind = row.get('kind')
        allowed = {'id', 'kind'}
        if not ID.fullmatch(row.get('id', '')) or row['id'] in seen:
            raise ValueError('Invalid observation identity')
        seen.add(row['id'])
        if kind in ('docker', 'systemd'):
            allowed |= {'targets'}
            targets = row.get('targets')
            if not isinstance(targets, list) or not 1 <= len(targets) <= 8 or len(set(targets)) != len(targets) or any(not TARGET.fullmatch(t) for t in targets):
                raise ValueError('Invalid process targets')
            if kind == 'systemd':
                allowed |= {'scope'}
                if row.get('scope') not in ('user', 'system') or any(not t.endswith('.service') for t in targets):
                    raise ValueError('Invalid service scope')
        elif kind == 'http':
            allowed |= {'url'}
            local_url(row['url'])
        elif kind == 'network':
            allowed |= {'deviceId'}
            if not re.fullmatch(r'[a-f0-9]{24}', row.get('deviceId', '')):
                raise ValueError('Invalid device identity')
        elif kind == 'prometheus':
            allowed |= {'metric', 'labels', 'source'}
            if row.get('metric') not in ('up', 'node_zfs_zpool_state') or row.get('source') not in ('host_collector', 'monitoring_collector', 'storage_health'):
                raise ValueError('Invalid metric scope')
            labels = row.get('labels')
            if not isinstance(labels, dict) or not labels or len(labels) > 5 or any(not re.fullmatch('[a-zA-Z_][a-zA-Z0-9_]*', k) or not isinstance(v, str) or not 1 <= len(v) <= 128 for k, v in labels.items()):
                raise ValueError('Invalid metric selector')
            if (row['source'] == 'storage_health') != (row['metric'] == 'node_zfs_zpool_state') or row['metric'] == 'node_zfs_zpool_state' and labels.get('state') != 'online':
                raise ValueError('Invalid storage selector')
        else:
            raise ValueError('Invalid observation kind')
        if set(row) != allowed:
            raise ValueError('Invalid observation fields')
    return raw


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Explicitly ignore process proxy settings and never forward redirects or secrets.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def http_status(url):
    try:
        with OPENER.open(url, timeout=1.2) as response:
            return response.status
    except urllib.error.HTTPError as error:
        error.close()
        return error.code


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=1.5, check=False)
    if len(result.stdout) > 262144:
        raise ValueError('Oversized native answer')
    return result.stdout


def aggregate(states):
    if not states or 'unknown' in states:
        return 'unknown'
    if all(s == 'offline' for s in states):
        return 'offline'
    return 'degraded' if any(s != 'online' for s in states) else 'online'


def process_checks(checks, kind, scope=None):
    selected = [c for c in checks if c['kind'] == kind and (scope is None or c['scope'] == scope)]
    if not selected:
        return []
    targets = sorted({t for c in selected for t in c['targets']})
    values = {}
    try:
        if kind == 'docker':
            # State only: full inspect includes private environment and credentials.
            data = command(['docker', 'inspect', '--format', '{{.Name}} {{json .State}}', *targets])
            for line in data.splitlines():
                name, body = line.split(' ', 1)
                row = json.loads(body)
                health = row.get('Health', {}).get('Status')
                values[name.lstrip('/')] = ('offline' if not row.get('Running') else
                                            'degraded' if health in ('unhealthy', 'starting') or row.get('Restarting') or row.get('Paused') else 'online')
        else:
            data = command(['systemctl', *(['--user'] if scope == 'user' else []), 'show', '--no-pager',
                            '--property=Id,LoadState,ActiveState,SubState', *targets])
            for block in data.strip().split('\n\n'):
                row = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
                values[row.get('Id')] = ('unknown' if row.get('LoadState') != 'loaded' else
                                         'online' if row.get('ActiveState') == 'active' and row.get('SubState') == 'running' else
                                         'degraded' if row.get('ActiveState') in ('activating', 'reloading', 'deactivating') else 'offline')
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    at = stamp()
    return [{'id': c['id'], 'source': 'native_process', 'state': aggregate([values.get(t, 'unknown') for t in c['targets']]), 'observedAt': at if all(t in values for t in c['targets']) else None} for c in selected]


def prom_vector(query):
    url = 'http://127.0.0.1:9090/api/v1/query?' + urllib.parse.urlencode({'query': query})
    with OPENER.open(url, timeout=1.2) as response:
        raw = response.read(262145)
    if len(raw) > 262144:
        raise ValueError('Oversized metrics answer')
    body = json.loads(raw)
    if body.get('status') != 'success' or body['data']['resultType'] != 'vector':
        raise ValueError('Invalid metrics answer')
    return body['data']['result']


def prometheus_checks(checks):
    selected = [c for c in checks if c['kind'] == 'prometheus']
    if not selected:
        return []
    values, times = {}, {}
    try:
        # timestamp() returns the ORIGINAL scrape time as the sample value.
        # The instant query's own sample timestamp is only evaluation time.
        for metric in sorted({c['metric'] for c in selected}):
            identity = lambda r: tuple(sorted((k, v) for k, v in r['metric'].items() if k != '__name__'))
            values[metric] = {identity(r): (r['metric'], float(r['value'][1])) for r in prom_vector(metric)}
            times[metric] = {identity(r): float(r['value'][1]) for r in prom_vector('timestamp(' + metric + ')')}
    except (OSError, ValueError, KeyError, urllib.error.URLError):
        pass
    result = []
    for c in selected:
        matches = [(key, value) for key, (labels, value) in values.get(c['metric'], {}).items() if all(labels.get(k) == v for k, v in c['labels'].items())]
        key, value = matches[0] if len(matches) == 1 else (None, None)
        at = times.get(c['metric'], {}).get(key)
        result.append({'id': c['id'], 'source': c['source'], 'state': 'unknown' if at is None or value not in (0, 1) else
                       'online' if value == 1 else 'degraded' if c['source'] == 'storage_health' else 'offline',
                       'observedAt': stamp(at) if at is not None else None})
    return result


def interface_check(c):
    try:
        code = http_status(c['url'])
        state = 'online' if 200 <= code < 400 or code in (401, 403) else 'offline'
    except (OSError, urllib.error.URLError, ValueError):
        state = 'offline'
    return [{'id': c['id'], 'source': 'http_interface', 'state': state, 'observedAt': stamp()}]


def observe(config):
    checks = validate(config)['checks']
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        jobs = [pool.submit(process_checks, checks, 'docker'), pool.submit(process_checks, checks, 'systemd', 'user'),
                pool.submit(process_checks, checks, 'systemd', 'system'), pool.submit(prometheus_checks, checks)]
        jobs += [pool.submit(interface_check, c) for c in checks if c['kind'] == 'http']
        return [row for job in jobs for row in job.result()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--revision', required=True)
    args = parser.parse_args()
    with open(args.config, 'rb') as stream:
        raw = stream.read(32769)
    if len(raw) > 32768 or hashlib.sha256(raw).hexdigest() != args.revision:
        raise ValueError('Configuration revision mismatch')
    rows = observe(json.loads(raw))
    print(json.dumps({'contract': 'agentx.ecosystem-observations/v1', 'configurationRevision': args.revision,
                      'observations': rows}, separators=(',', ':')))


if __name__ == '__main__':
    main()
