"""Use Core's existing operator protocol; never store a parallel work queue."""
import json
from pathlib import Path
import urllib.error
import urllib.request

from .common import now, save


class Uncertain(RuntimeError):
    """An accepted native effect cannot be replaced without its original result."""


class Queue:
    def __init__(self, config, work, request_id):
        self.config, self.work, self.request_id = config, Path(work), request_id
        self.path = self.work / 'queue.private.json'
        self.job = None

    def api(self, suffix='', body=None):
        request = urllib.request.Request(self.config['coreUrl'].rstrip('/') + '/api/cluster/schedule/work-queue' + suffix,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json', 'x-service-caller': self.config['actor']})
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
        if result.get('ok') is False:
            raise RuntimeError('Core queue refused the operation')
        return result.get('data', result)

    def remember(self, job):
        self.job = job
        save(self.path, job)
        return job

    def admit(self):
        receipt = str(self.work / 'operator-terminal.private.json')
        key = self.config.get('keyPrefix', 'recovery-set') + ':' + self.request_id
        request = {
            'key': key, 'title': self.config.get('title', 'Native recovery-set capture'),
            'kind': 'diagnostic', 'hosts': self.config['hosts'],
            'estimatedMinutes': self.config.get('estimatedMinutes', 60),
            'notBefore': now(), 'source': self.config['source'],
            'executor': {'mode': 'operator', 'receiptRef': receipt},
        }
        save(self.work / 'queue-intent.private.json', request)
        try:
            submitted = self.api(body=request)
        except Exception as error:
            try:
                matches = [job for job in self.api().get('jobs', []) if job.get('key') == key]
            except Exception:
                matches = []
            if len(matches) != 1:
                raise Uncertain('Original queue submission outcome is unavailable') from error
            submitted = matches[0]
        self.remember(submitted)
        if self.job['state'] == 'requested':
            self.remember(self.api('/' + self.job['id'] + '/reserve', {
                'expectedRevision': self.job['revision'], 'start': now(), 'priority': self.config.get('priority', 5)}))
        if self.job['state'] != 'reserved':
            raise Uncertain('Original recovery admission is not available for dispatch')
        # Save the request ID before crossing the dispatch fence. An absent reply
        # can only be reconciled by that exact identity, never by another submit.
        try:
            begun = self.api('/' + self.job['id'] + '/begin', {'expectedRevision': self.job['revision']})
        except Exception:
            current = self.api('/' + self.job['id'])
            self.remember(current)
            if not current.get('dispatchId'):
                raise
            begun = current  # No capture child has been started yet.
        self.remember(begun)
        if not begun.get('dispatchId'):
            raise RuntimeError('Core returned no dispatch fence')

    def finish(self, success):
        if not self.job:
            return
        if not self.job.get('dispatchId'):
            current = self.api('/' + self.job['id'])
            if current['state'] in ('requested', 'reserved') and not current.get('dispatchId'):
                self.remember(self.api('/' + current['id'] + '/cancel', {'expectedRevision': current['revision']}))
                return
            if current.get('dispatchId'):
                raise Uncertain('A dispatch was accepted without a local native execution record')
            return
        from .common import digest
        path = self.work / 'operator-terminal.private.json'
        save(path, {
            'contract': 'agentx.operator-heavy-work/v1', 'queueRequestId': self.job['id'],
            'dispatchId': self.job['dispatchId'], 'receiptRef': str(path),
            'actor': self.config['actor'], 'state': 'completed' if success else 'failed',
            'runtimeReleased': True, 'finishedAt': now(),
            'evidence': 'Synchronous native backup commands terminated; no model or maintenance lease acquired.',
        })
        current = self.api('/' + self.job['id'])
        if current['state'] in ('completed', 'failed'):
            return self.remember(current)
        self.remember(self.api('/' + self.job['id'] + '/operator-finish', {
            'expectedRevision': current['revision'], 'dispatchId': self.job['dispatchId'],
            'state': 'completed' if success else 'failed', 'receiptRef': str(path),
            'receiptSha256': digest(path), 'confirmation': 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED',
        }))
