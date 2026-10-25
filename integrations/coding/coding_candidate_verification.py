"""CPU-only handoff after a reconciled model-reserve stop; never grants inference."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import signal


class VerificationRefusal(RuntimeError):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def material_change(r, workspace, paths):
    rows = r.git(workspace, 'diff', '--numstat', 'HEAD', '--', *paths).splitlines()
    if any(any(value.isdigit() and int(value) > 0 for value in row.split('\t')[:2]) for row in rows):
        return True
    untracked = r.git(workspace, 'ls-files', '-z', '--others', '--exclude-standard').split('\0')
    return any(name in paths and (workspace / name).is_file() and not (workspace / name).is_symlink()
               and (workspace / name).stat().st_size > 0 for name in untracked if name)


def native_candidate(r, endpoint, task_id, key, lease, manifest):
    """GET the original authority. A lost response is a refusal, never a replay."""
    fresh = r.request(endpoint)['data']
    if (fresh.get('pipelineId') != task_id or fresh.get('requestId') != key
            or fresh.get('scope') != manifest['scope']
            or fresh.get('verificationProfile') != manifest.get('verificationProfile')
            or fresh.get('queueRequestId') != manifest.get('queueRequestId')
            or not fresh.get('queueEndAt')):
        raise VerificationRefusal('authorization_removed')
    current = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/worker?agent={r.WORKER}')['data']['task']
    owned = current.get('automationLease') or {}
    runs = (current.get('codingAutonomy') or {}).get('runs') or []
    run = runs[-1] if runs else {}
    receipts = run.get('modelReceipts') or []
    if (current.get('status') != 'in_progress' or owned.get('leaseId') != lease['leaseId']
            or owned.get('dispatchRequestId') != key or run.get('requestId') != key):
        raise VerificationRefusal('authorization_removed')
    try:
        if datetime.fromisoformat(owned['expiresAt'].replace('Z', '+00:00')) <= datetime.now(timezone.utc):
            raise VerificationRefusal('authorization_removed')
    except (KeyError, TypeError, ValueError) as error:
        raise VerificationRefusal('authorization_removed') from error
    try:
        complete = all(row['state'] == 'completed' and row['settlement']['state'] == 'completed'
                       and row['settlement']['finishedAt'] == row['finishedAt']
                       and datetime.fromisoformat(row['finishedAt'].replace('Z', '+00:00'))
                       >= datetime.fromisoformat(row['startedAt'].replace('Z', '+00:00'))
                       for row in receipts)
        unique = len({row['callId'] for row in receipts}) == len(receipts)
        identifiers = all(r.coding_progress.REQUEST_ID.fullmatch(row['callId']) for row in receipts)
    except (KeyError, TypeError, ValueError):
        complete = unique = identifiers = False
    if run.get('pendingInferences') != [] or not receipts or not complete or not unique or not identifiers:
        raise VerificationRefusal('model_termination_unverified')
    intervals = sorted((datetime.fromisoformat(row['startedAt'].replace('Z', '+00:00')).timestamp(),
                        datetime.fromisoformat(row['finishedAt'].replace('Z', '+00:00')).timestamp()) for row in receipts)
    seconds, last_end = 0, 0
    for start, end in intervals:
        seconds += max(0, end - max(start, last_end))
        last_end = max(last_end, end)
    native_usage = {'modelCalls': len(receipts), 'modelSeconds': math.ceil(seconds)}
    return fresh, hashlib.sha256(json.dumps(receipts, sort_keys=True).encode()).hexdigest(), native_usage


class CPUVerification:
    """Narrow progress view for tests/publication; original stop and limits stay intact.

    Only this view can disregard the reserve stop. The original Progress remains
    stopped, including its relay budget guidance and every subsequent worker gate.
    """
    def __init__(self, r, progress, endpoint, lease, manifest, run):
        if (progress.check_stop() != 'model_budget_reserve'
                or run.returncode not in (0, -signal.SIGTERM)
                or getattr(progress, 'last_step_failure', None)
                or getattr(progress, 'role_drained', False) is not True
                or progress.model_worker_active):
            raise VerificationRefusal(progress.stop_reason or 'worker_exit')
        self._progress, self._r = progress, r
        self._endpoint, self._lease, self._manifest = endpoint, lease, manifest
        self._calls = progress.model_calls
        self._last_native_check = None
        self._native_fingerprint = None
        self._failure = None
        self._path = progress.path.parent / f'{progress.request_id}.candidate-verification.json'
        self._receipt = {'schema': 'agentx.coding-candidate-verification/v1',
                         'requestId': progress.request_id, 'pipelineId': progress.task_id,
                         'leaseId': lease['leaseId'], 'workerExitCode': run.returncode,
                         'workerStopReason': progress.stop_reason, 'usageAtHandoff': progress.usage(),
                         'additionalModelCalls': 0}
        self.require()
        self._save()

    def __getattr__(self, name):
        return getattr(self._progress, name)

    def _save(self):
        self._receipt.update(nativeReceiptsFingerprint=self._native_fingerprint,
                             verificationStopReason=self._failure, usage=self._progress.usage())
        self._r.coding_dispatch_control.atomic_json(self._path, self._receipt)

    def check_stop(self):
        p = self._progress
        stopped = p.check_stop()
        p.account()
        if stopped != 'model_budget_reserve':
            self._failure = stopped or 'worker_exit'
        elif p.model_calls != self._calls or p.model_worker_active:
            self._failure = 'model_termination_unverified'
        elif p.now() >= p.queue_deadline:
            self._failure = 'queue_window_closed'
        elif p.model_calls >= p.call_limit():
            self._failure = 'model_call_limit'
        elif (p.now() >= min(p.hard_deadline, p.soft_deadline)
              or p.test_remaining() < 1 or p.model_remaining() <= 0):
            self._failure = 'hard_budget'
        elif (p.stage == 'test' and p.now() - p.stage_since
              >= self._r.coding_progress.STAGE_LIMITS['test']):
            self._failure = 'test_inactive'
        return self._failure

    def require(self):
        if self.check_stop():
            raise VerificationRefusal(self._failure)
        try:
            fresh, fingerprint, native_usage = native_candidate(
                self._r, self._endpoint, self.task_id, self.request_id, self._lease, self._manifest)
            if self._native_fingerprint is not None and fingerprint != self._native_fingerprint:
                raise VerificationRefusal('model_termination_unverified')
            # Never extend the original reservation even if Core moves a slot.
            if fresh['queueEndAt'] != self._manifest['queueEndAt']:
                raise VerificationRefusal('queue_window_closed')
            if native_usage['modelCalls'] < self._calls:
                raise VerificationRefusal('model_termination_unverified')
            if native_usage['modelCalls'] >= self.call_limit():
                raise VerificationRefusal('model_call_limit')
            if native_usage['modelSeconds'] >= self.cumulative_limits['modelSeconds']:
                raise VerificationRefusal('hard_budget')
            self._receipt['nativeUsage'] = native_usage
            self._native_fingerprint = fingerprint
            self._last_native_check = self.now()
        except Exception as error:
            self._failure = getattr(error, 'reason', None) or {
                'CODING_AUTONOMY_CONFLICT': 'authorization_removed',
                'CODING_AUTONOMY_QUEUE_WAIT': 'queue_window_closed',
            }.get(getattr(error, 'code', None), 'model_termination_unverified')
            self._save()
            raise VerificationRefusal(self._failure) from error
        if self.check_stop():
            raise VerificationRefusal(self._failure)

    def tick(self, home=None, workspace=None):
        self._progress.tick(home, workspace)
        if not self.check_stop() and self.now() - self._last_native_check >= 20:
            try:
                self.require()
            except VerificationRefusal:
                pass
        self._save()
        return self._failure

    def timeout(self):
        self.require()
        seconds = int(min(self.test_remaining(), self.hard_deadline - self.now(),
                          self.soft_deadline - self.now(), self.queue_deadline - self.now()))
        if seconds < 1:
            raise VerificationRefusal('hard_budget')
        return seconds

    def write(self):
        self._progress.write()
        self._save()
