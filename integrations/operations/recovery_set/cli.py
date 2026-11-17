"""Recurring native recovery capture, replication, freshness and safe status."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import urllib.request
import uuid

from host_jobs.store import lock
from .capture import capture, fingerprint_hash, shared_fingerprint
from .common import now, save, verify
from .queue import Uncertain
from .replica import replicate


def age(value):
    if not value:
        return None
    return max(0, (datetime.now(timezone.utc) - datetime.fromisoformat(value.replace('Z', '+00:00'))).total_seconds())


def read(path):
    return json.loads(path.read_text()) if path.exists() else {}


def status(config):
    root = Path(config['root'])
    latest, replica = read(root / 'latest.private.json'), read(root / 'replica-latest.private.json')
    local_age = age(latest.get('completedAt'))
    replica_age = age(replica.get('capturedAt'))
    stale = float(config.get('staleAfterSeconds', 30 * 3600))
    return {
        'state': 'ready' if local_age is not None and replica_age is not None and max(local_age, replica_age) <= stale else 'attention',
        'verified': bool(replica.get('verified')) and replica.get('generation') == latest.get('generation'),
        'captureAgeSeconds': local_age, 'offhostCaptureAgeSeconds': replica_age,
        'fresh': local_age is not None and replica_age is not None and max(local_age, replica_age) <= stale,
        'generation': latest.get('generation'), 'replicaGeneration': replica.get('generation'),
    }


def report_health(config, result):
    if not config.get('health'):
        return
    health = config['health']
    payload = {'source': health['source'], 'data': {
        'component': health.get('component', 'Native recovery set'), 'metric': health['metric'],
        'value': 0 if result['fresh'] else 1, 'threshold': 0,
        'additionalData': {key: result[key] for key in ('captureAgeSeconds', 'offhostCaptureAgeSeconds', 'fresh')},
    }}
    request = urllib.request.Request(health['coreUrl'].rstrip('/') + '/api/alerts/evaluate',
        data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json', 'x-service-caller': 'recovery-set-health'})
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status >= 300:
            raise RuntimeError('Recovery health report was refused')


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('capture', 'replicate', 'status', 'verify'))
    parser.add_argument('--config', required=True)
    parser.add_argument('--request-id', default=os.environ.get('AGENTX_OPERATION_REQUEST_ID'))
    parser.add_argument('--directory')
    args = parser.parse_args(argv)
    config = json.loads(Path(args.config).read_text())
    if config.get('version') != 1:
        raise ValueError('Unsupported recovery configuration')
    root = Path(config['root'])
    if not root.is_absolute() or len(root.parts) < 4 or root.is_symlink():
        raise ValueError('Unsafe recovery root')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.action == 'verify':
        value = verify(args.directory)
        print(json.dumps({'state': 'verified', 'verified': True, 'files': len(value['artifacts'])}))
        return 0
    if args.action == 'status':
        print(json.dumps(status(config)))
        return 0
    request_id = args.request_id
    if not request_id or str(uuid.UUID(request_id)) != request_id:
        raise ValueError('An exact operation UUID is required')
    result, exit_code = {}, 0
    try:
        # Separate locks permit an off-host retry of the last complete capture
        # while a new source generation is being prepared.
        with lock(root / (args.action + '.lock'), blocking=False):
            if args.action == 'capture':
                prior = read(root / 'active.private.json')
                if prior and read(root / 'runs' / prior['requestId'] / 'capture.private.json').get('state') not in ('complete', 'failed'):
                    raise Uncertain('Previous capture outcome is unresolved')
                current = status(config)
                due = current['captureAgeSeconds'] is None or current['captureAgeSeconds'] >= config.get('minimumCaptureIntervalSeconds', 86400)
                if not due and config.get('refreshOnCriticalChange'):
                    control = root / 'source-check'
                    control.mkdir(exist_ok=True, mode=0o700)
                    observed = fingerprint_hash(shared_fingerprint(config, control, 'observed'))
                    due = observed != read(root / 'latest.private.json').get('criticalFingerprint')
                if not due:
                    result = {'state': 'unchanged', 'verified': True}
                else:
                    save(root / 'active.private.json', {'requestId': request_id, 'acceptedAt': now()})
                    manifest = capture(config, request_id)
                    result = {'state': 'captured', 'verified': True, 'files': len(manifest['artifacts']),
                              'bytes': sum(a['bytes'] for a in manifest['artifacts'])}
            else:
                result = replicate(config)
    except Uncertain:
        result, exit_code = {'state': 'unknown', 'verified': False, 'code': 'NATIVE_OUTCOME_UNKNOWN'}, 3
    except Exception as error:
        # A terminal refusal or offline destination is a checked deferred
        # occurrence. The existing supervisor can retry on its next tick, even
        # through prolonged destination downtime; no native mutation is replayed.
        result = {'state': 'deferred', 'verified': False, 'code': type(error).__name__}
        save(root / (args.action + '-error.private.json'), {'observedAt': now(), 'error': str(error)})
    result.update(status(config), attemptState=result.get('state'), attemptVerified=result.get('verified'), checkedAt=now())
    save(root / (args.action + '-latest.private.json'), result)
    try:
        report_health(config, result)
    except Exception:
        result['healthReported'] = False
    else:
        result['healthReported'] = bool(config.get('health'))
    print(json.dumps(result))
    return exit_code
