#!/usr/bin/env python3
"""Host side of the Pipeline page's "Run one task": list what can start, start one."""

from __future__ import annotations

import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import shlex
import base64
import hashlib
from datetime import datetime, timezone
from urllib.request import urlopen


HERE = Path(__file__).resolve().parent
CORE = os.environ.get("AGENTX_CORE_URL", "http://127.0.0.1:3180").rstrip("/")
STATE = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "agentx"
RECEIPTS = STATE / "coding-run-requests"
LEGACY_RECEIPTS = STATE / "coding-dispatch-requests"
# Model, GitHub token and other settings of the run; they stay outside Git.
ENV_FILE = Path(os.environ.get("AGENTX_CODING_ENV_FILE", Path.home() / ".config/agentx/coding.env"))
UNIT = "agentx-coding-run"
CODING_SERVICE = "agentx-coding"
_spec = importlib.util.spec_from_file_location("coding_progress", HERE / "coding_progress.py")
progress_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(progress_module)
# Mirror of core/src/helpers/workerTaskScope.js: the canonical private task lane
# boundary. Keep it in sync with the Core helper.
PRIVATE_SERVICE = re.compile(r"^\s*(personal|family|household|secretary)\s*$", re.IGNORECASE)
PRIVATE_SOURCE = re.compile(r"^\s*(idea-drop\s*$|household-)", re.IGNORECASE)
REQUEST_ID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")


class ControlError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.status = code, status


QUEUE_EVIDENCE = None


def queued_tasks() -> list[dict]:
    global QUEUE_EVIDENCE
    # Filter private and unrelated services before pagination, just like Core's claim scope.
    with urlopen(f"{CORE}/api/pipeline/tasks?status=queued&service=agentx-coding&scope=engineering&limit=1000", timeout=10) as response:
        data = json.load(response)['data']
    rows = data['tasks']
    evidence, summary = data.get('evidence') or {}, data.get('summary') or {}
    scoped = (evidence.get('authority') == 'core.pipeline' and (evidence.get('scope') or {}).get('taskScope') == 'engineering'
              and (evidence.get('scope', {}).get('filters') or {}).get('service') == CODING_SERVICE)
    total = summary.get('matchedCount')
    QUEUE_EVIDENCE = {'scope': 'engineering_coding' if scoped else 'loaded_tasks',
                      'queuedTasks': total if scoped and type(total) is int and total >= len(rows) else len(rows),
                      'eligibleCountExact': bool(scoped and (evidence.get('rows') or {}).get('truncated') is False)}
    return rows


def is_private_task(task: dict) -> bool:
    # The Core service rule is anchored at both ends, the source rule only at the start.
    return bool(PRIVATE_SERVICE.fullmatch(str(task.get("service") or ""))
                or PRIVATE_SOURCE.match(str(task.get("source") or "")))


def can_start(task: dict, *, autonomous=False) -> bool:
    if not (task.get('status') == 'queued' and not task.get('assignee')
            and task.get('service') == CODING_SERVICE and not is_private_task(task)):
        return False
    # The separately authorized loop keeps its native manifest and atomic admission.
    if autonomous:
        return True
    if not autonomous and (task.get('codingAutonomy') or task.get('automationLease') or task.get('automationAttemptCount')
            or task.get('automationAttempts') or task.get('codingCapacity') or (task.get('automation') or {}).get('mode') == 'review_only'):
        return False
    if task.get('notBefore'):
        try:
            when = datetime.fromisoformat(str(task['notBefore']).replace('Z', '+00:00'))
            if when.tzinfo is None or when > datetime.now(timezone.utc):
                return False
        except (ValueError, TypeError):
            return False
    code = (task.get('nextAction') or {}).get('code')
    if code in {'wait_not_before', 'inspect_dependencies', 'inspect_owner'}:
        return False
    return not task.get('dependsOn') or code in {'await_claim', 'review_due_date'}


def unit_active() -> bool:
    state = subprocess.run(["systemctl", "--user", "is-active", UNIT], capture_output=True, text=True, timeout=8)
    return state.stdout.strip() in {"active", "activating", "deactivating"}


def report_name(value: str) -> bool:
    return isinstance(value, str) and len(value) <= 120 and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.md", value))


def read_receipt(key: str) -> dict | None:
    path = RECEIPTS / f"{key}.json"
    return json.loads(path.read_text()) if path.exists() else None


def save_receipt(run: dict) -> None:
    RECEIPTS.mkdir(parents=True, exist_ok=True)
    atomic_json(RECEIPTS / f"{run['requestId']}.json", run)
    atomic_json(RECEIPTS / "latest", run["requestId"], raw=True)


def atomic_json(path, value, raw=False):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".receipt-", delete=False) as out:
        out.write(str(value) if raw else json.dumps(value))
        out.flush()
        os.fsync(out.fileno())
        name = out.name
    os.replace(name, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_progress(run: dict) -> dict | None:
    key = run.get("requestId", "")
    if not REQUEST_ID.fullmatch(key):
        return None
    try:
        path = RECEIPTS / f"{key}.progress.json"
        if path.stat().st_size > 65536:
            return None
        progress = progress_module.safe_progress(json.loads(path.read_text()), key, run["pipelineId"])
        return progress if progress and (progress["phase"] != "finished" or progress["result"]) else None
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def report_profile(task):
    allowed = not (task.get('codingAutonomy') or task.get('automationLease') or task.get('automationAttemptCount')
                   or task.get('automationAttempts') or (task.get('automation') or {}).get('mode') == 'review_only')
    latest = next((row.get('reportOutcome') for row in reversed(task.get('feedback') or []) if row.get('reportOutcome')), None)
    result = {'canReport': allowed}
    if task.get('codingResult'):
        result.update(codingResult=task['codingResult'])
        if task['codingResult'].get('profile') == 'report':
            result.update(reportName=task['codingResult']['reportName'])
    if task.get('reportCheckpointArchive') and not task.get('codingResult'):
        result.update(reportName=task['reportCheckpointArchive']['reportName'], reportCheckpoint=task['reportCheckpointArchive'])
    if latest:
        result['reportName'] = latest['reportName'] if report_name(latest.get('reportName')) else 'REVIEW.md'
        saved = latest.get('partial') or latest
        if (isinstance(latest.get('requestId'), str) and REQUEST_ID.fullmatch(latest['requestId'])
                and saved.get('deliverableId') and isinstance(saved.get('sha256'), str) and re.fullmatch(r'[a-f0-9]{64}', saved['sha256'])):
            result['reportCheckpoint'] = {'parentRequestId': latest['requestId'], 'parentSha256': saved['sha256']}
    selected = task.get('codingResult') or {}
    grants = (task.get('codingReportAuthority') or {}).get('grants') or []
    if selected.get('parentRequestId') and not any(row.get('requestId') == (latest or {}).get('requestId') and grants and row.get('grantKey') == grants[-1]['key'] for row in (task.get('codingReportAuthority') or {}).get('bindings', [])):
        result.update(reportName=selected['reportName'], reportCheckpoint={name: selected.get(name) for name in ('parentRequestId', 'parentSha256')})
    return result


def status(key: str | None = None) -> dict:
    global QUEUE_EVIDENCE
    QUEUE_EVIDENCE = None
    tasks = queued_tasks()
    busy = unit_active()
    latest = RECEIPTS / "latest"
    run = read_receipt(key or (latest.read_text().strip() if latest.exists() else ""))
    progress = read_progress(run) if run else None
    current = bool(run and latest.exists() and latest.read_text().strip() == run["requestId"])
    if run and run["phase"] in {"accepted", "uncertain"}:
        run["phase"] = "running" if busy and current else "finished" if progress and progress["phase"] == "finished" else "unknown"
        run["message"] = ("The coding worker is running." if run["phase"] == "running"
                          else "The coding worker stopped. Read its recorded result." if run["phase"] == "finished"
                          else "The host unit stopped without a terminal receipt. Inspect the task and checkpoint.")
    if run and run.get('reportName') and progress and not progress.get('coreRecorded') and (progress['phase'] == 'finished'
            or any((RECEIPTS/f"{run['requestId']}.{suffix}.json").exists() for suffix in ('report-start', 'report-preflight')) and not busy) and not (
            progress.get('preflight') and progress.get('modelCalls') == 0 and not any((RECEIPTS/f"{run['requestId']}.{suffix}.json").exists() for suffix in ('report-start', 'report-preflight'))):
        run.update(phase='unknown', message='The local report worker stopped; reconcile its original Core result before another launch.')
    if run and run.get('reportName'):
        run['canReconcile'] = not busy and run['phase'] == 'unknown'
    if key and not run:
        legacy = LEGACY_RECEIPTS / f"{key}.json"
        run = ({**json.loads(legacy.read_text()), "retired": True, "canRetry": False, "canCancel": False,
                "message": "This guarded request is retained for observation; the simple worker cannot resume it."}
               if legacy.exists() else {"requestId": key, "phase": "not_received", "message": "No receipt for this request."})
    if run and progress:
        run["progress"] = progress
    if run and not run.get("retired"):
        run["canStop"] = bool(current and busy and run["phase"] == "running"
                               and not (progress and (progress["phase"] == "finished" or progress["stage"] == "publishing")))
        if (RECEIPTS / f"{run['requestId']}.stop.json").is_file() and run["canStop"]:
            run.update(phase="stopping", canStop=False,
                       message="Stop requested; waiting for the local checkpoint. Core may still drain the in-flight inference.")
    return {
        "contractVersion": 2, "available": True, "busy": busy,
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "summary": {"queuedTasks": len(tasks), "eligibleTasks": sum(map(can_start, tasks)),
                    "privateQueuedTasks": sum(map(is_private_task, tasks)), **(QUEUE_EVIDENCE or {
                        "scope": "loaded_tasks", "eligibleCountExact": False})},
        "candidates": [{"pipelineId": task["pipelineId"], "title": task.get("title", ""),
                        "expectedAttemptCount": int(task.get("automationAttemptCount") or 0), **report_profile(task)}
                       for task in tasks if can_start(task)],
        "excluded": [{"pipelineId": task['pipelineId'], "title": task.get('title', ''), "reasons": [
            {"code": (task.get('nextAction') or {}).get('code', 'manual_worker_ineligible'),
             "detail": 'Use the existing correction loop for this managed task.' if not report_profile(task)['canReport']
                       else (task.get('nextAction') or {}).get('detail', 'Current task conditions do not admit a manual worker.')} ]}
            for task in tasks if not is_private_task(task) and not can_start(task)][:50], "run": run,
    }


def launch(pipeline_id: str, key: str, expected_attempt_count: int, *, autonomous=False, report="", model_call_limit=None, parent_request_id=None, parent_sha256=None) -> dict:
    if report and (autonomous or not report_name(report)):
        raise ControlError("CODING_DISPATCH_INVALID_REQUEST", "Report mode needs a plain Markdown file name and a manual request.", 400)
    try:
        if model_call_limit is not None and not report:
            raise ValueError('A model call override requires report mode')
        limit = progress_module.report_call_limit(model_call_limit)
    except ValueError as error:
        raise ControlError('CODING_DISPATCH_INVALID_REQUEST', str(error), 400) from error
    if parent_request_id is not None or parent_sha256 is not None:
        if not report or not isinstance(parent_request_id, str) or not REQUEST_ID.fullmatch(parent_request_id) or parent_sha256 is not None and (not isinstance(parent_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', parent_sha256)) or parent_request_id == key:
            raise ControlError('CODING_DISPATCH_INVALID_REQUEST', 'A report continuation needs its original request and file digest.', 400)
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / "coding-dispatcher-control.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = read_receipt(key)
        if previous:
            if previous.get('cancelledBeforeLaunch'):
                if previous['pipelineId'] != pipeline_id:
                    raise ControlError('CODING_DISPATCH_REQUEST_CONFLICT', 'Cancelled request belongs to another task.')
                return {'accepted': False, 'replayed': True, 'pipelineId': pipeline_id, 'run': previous}
            if (previous["pipelineId"] != pipeline_id or previous.get("expectedAttemptCount", 0) != expected_attempt_count
                    or bool(previous.get("autonomous")) != autonomous or previous.get('reportName', '') != report
                    or report and previous.get('modelCallLimit', progress_module.MANUAL_MODEL_CALL_LIMIT) != limit
                    or previous.get('parentRequestId') != parent_request_id or previous.get('parentSha256') != parent_sha256):
                raise ControlError("CODING_DISPATCH_REQUEST_CONFLICT", "This request id belongs to a different selection.")
            return {"accepted": True, "replayed": True, "pipelineId": pipeline_id, "run": previous}
        if (LEGACY_RECEIPTS / f"{key}.json").exists():
            raise ControlError("CODING_DISPATCH_RETIRED_REQUEST", "This request belongs to the retired guarded worker; inspect its preserved result.")
        if unit_active():
            raise ControlError("CODING_DISPATCH_BUSY", "The coding worker is already running a task.")
        latest = RECEIPTS / "latest"
        pending = read_receipt(latest.read_text().strip()) if latest.exists() else None
        terminal = read_progress(pending) if pending else None
        if pending and pending["phase"] in {"accepted", "uncertain"} and not (
                terminal and terminal["phase"] == "finished" and
                (not (pending.get("autonomous") or pending.get('reportName')) or terminal["coreRecorded"]
                 or pending.get('reportName') and terminal.get('preflight') and terminal.get('modelCalls') == 0
                 and not any((RECEIPTS/f"{pending['requestId']}.{suffix}.json").exists() for suffix in ('report-start', 'report-preflight')))):
            raise ControlError("CODING_DISPATCH_OUTCOME_UNKNOWN", "Reconcile the previous launch before starting another task.")
        selected = next((task for task in queued_tasks() if task["pipelineId"] == pipeline_id and can_start(task, autonomous=autonomous)), None)
        if not selected:
            raise ControlError("CODING_DISPATCH_INELIGIBLE", "Only unowned, queued, non-private agentx-coding tasks can start.")
        durable = selected.get('codingResult')
        if durable and (durable.get('profile') != ('report' if report else 'code')
                or report and any(durable.get(name) != value for name, value in (
                    ('reportName', report), ('modelCallLimit', limit), ('parentRequestId', parent_request_id), ('parentSha256', parent_sha256)))):
            raise ControlError('REPORT_PROFILE_CONFLICT', 'Launch must retain the result selection saved by Core.')
        if report and ((selected.get('automation') or {}).get('mode') == 'review_only' or selected.get('codingAutonomy') or selected.get('automationLease') or selected.get('automationAttemptCount') or selected.get('automationAttempts')):
            raise ControlError('CODING_DISPATCH_INELIGIBLE', 'Report mode cannot replace an automated attempt.')
        if int(selected.get("automationAttemptCount") or 0) != expected_attempt_count:
            raise ControlError("CODING_DISPATCH_REQUEST_CONFLICT", "The task attempt changed before launch.")
        if autonomous:
            with urlopen(f"{CORE}/api/pipeline/coding-autonomy/tasks/{pipeline_id}/runs/{key}/manifest", timeout=10) as response:
                manifest = json.load(response)["data"]
            if manifest.get("requestId") != key or manifest.get("pipelineId") != pipeline_id:
                raise ControlError("CODING_DISPATCH_INELIGIBLE", "Core has no matching autonomous authorization.")
        run = {"requestId": key, "pipelineId": pipeline_id, "expectedAttemptCount": expected_attempt_count,
               "submittedAt": datetime.now(timezone.utc).isoformat(), "unitName": UNIT, "phase": "uncertain",
               "message": "The host is starting the coding worker."}
        if autonomous:
            run["autonomous"] = True
        if report:
            run['reportName'] = report
            run['modelCallLimit'] = limit
            if parent_request_id:
                run.update(parentRequestId=parent_request_id, parentSha256=parent_sha256)
        save_receipt(run)
        subprocess.run(["systemd-run", "--user", "--collect", "--quiet", f"--unit={UNIT}",
                        f"--property=EnvironmentFile=-{ENV_FILE}", f"--setenv=AGENTX_CORE_URL={CORE}",
                        f"--setenv=PATH={os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')}",
                        sys.executable, str(HERE / "coding_run.py"), pipeline_id, "--request-id", key,
                        *(["--autonomous"] if autonomous else []), *(["--report-name", report] if report else []),
                        *(["--model-call-limit", str(limit)] if report and limit != progress_module.MANUAL_MODEL_CALL_LIMIT else []),
                        *(["--parent-request-id", parent_request_id] if parent_request_id else []),
                        *(["--parent-sha256", parent_sha256] if parent_sha256 else [])],
                       check=True, capture_output=True, text=True, timeout=10)
        run.update(phase="accepted", message="The coding worker started on this task.")
        save_receipt(run)
        return {"accepted": True, "replayed": False, "pipelineId": pipeline_id, "run": run}


def stop(pipeline_id: str, key: str) -> dict:
    """Record a cooperative stop for this request only; never signal a shared unit."""
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / "coding-dispatcher-control.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        run = read_receipt(key)
        if not run:
            # The same launch/stop lock closes a selected but unreceived ID.
            # Do not change latest or touch an unrelated active host job.
            run = {'pipelineId': pipeline_id, 'requestId': key, 'phase': 'finished',
                   'autonomous': True, 'cancelledBeforeLaunch': True}
            atomic_json(RECEIPTS / f'{key}.json', run)
            atomic_json(RECEIPTS / f'{key}.progress.json', {'pipelineId': pipeline_id, 'requestId': key,
                'phase': 'finished', 'stage': 'preparing', 'coreRecorded': True, 'preflight': True,
                'result': 'blocked', 'stopReason': 'operator_stop', 'usage': {}})
            return {'accepted': True, 'cancelledBeforeLaunch': True, 'pipelineId': pipeline_id, 'requestId': key}
        if run["pipelineId"] != pipeline_id:
            raise ControlError("CODING_DISPATCH_REQUEST_CONFLICT", "No matching coding request and task.")
        progress = read_progress(run)
        if progress and progress["phase"] == "finished":
            return {"accepted": True, "alreadyFinished": True, "requestId": key, "pipelineId": pipeline_id}
        if (progress and progress["stage"] == "publishing") or (run.get('reportName') and (RECEIPTS/f'{key}.report-intent.json').exists()):
            raise ControlError("CODING_DISPATCH_STOP_TOO_LATE", "Publication already started; its external effects cannot be revoked by stopping the worker.")
        latest = RECEIPTS / "latest"
        if not latest.exists() or latest.read_text().strip() != key or not unit_active():
            raise ControlError("CODING_DISPATCH_OUTCOME_UNKNOWN", "This request is not the active worker; inspect its preserved receipt.")
        path = RECEIPTS / f"{key}.stop.json"
        if not path.exists():
            value = {"requestId": key, "pipelineId": pipeline_id,
                     "requestedAt": datetime.now(timezone.utc).isoformat()}
            with tempfile.NamedTemporaryFile(mode="w", dir=RECEIPTS, prefix=".stop-", delete=False) as output:
                json.dump(value, output)
                output.flush()
                os.fsync(output.fileno())
                temporary = output.name
            os.replace(temporary, path)
        return {"accepted": True, "requestId": key, "pipelineId": pipeline_id, "phase": "stopping"}


def load_runner():
    spec = importlib.util.spec_from_file_location("coding_run", HERE / "coding_run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def setting(name, fallback=""):
    if os.environ.get(name):
        return os.environ[name]
    if not ENV_FILE.is_file():
        return fallback
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith(name + "="):
            parts = shlex.split(line.split("=", 1)[1])
            return parts[0] if len(parts) == 1 else fallback
    return fallback


def observe(pipeline_id, key):
    run = read_receipt(key)
    progress = read_progress(run) if run else None
    if not run or run["pipelineId"] != pipeline_id or not progress or not progress.get("pr"):
        raise ControlError("CODING_DISPATCH_REQUEST_CONFLICT", "No matching published PR receipt.")
    token = setting("GH_TOKEN")
    if not token:
        raise ControlError("CODING_GITHUB_UNAVAILABLE", "The GitHub token is not configured.", 503)
    spec = importlib.util.spec_from_file_location("coding_github", HERE / "coding_github.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    runner = load_runner()
    repository = setting("AGENTX_CODING_REPOSITORY", "WindriderQc/AgentX")
    return module.observe(runner.request, repository, pipeline_id, progress["pr"], token)


def read_checkpoint(pipeline_id, key, path):
    """Read original legacy model bytes at its recorded checkpoint; never publish it."""
    if not re.fullmatch(r'\.review-work/[A-Za-z0-9_./-]+\.md', path) or '..' in Path(path).parts:
        raise ControlError('REPORT_ARCHIVE_INVALID', 'Choose a Markdown artifact inside the private review checkpoint.', 400)
    run = read_receipt(key); progress = read_progress(run) if run else None
    if unit_active() or not run or run.get('pipelineId') != pipeline_id or not progress or progress.get('phase') != 'finished':
        raise ControlError('REPORT_NATIVE_RELEASE_UNVERIFIED', 'The original worker is not received as terminal.')
    commit = progress.get('checkpoint')
    if not isinstance(commit, str) or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ControlError('REPORT_ARCHIVE_INVALID', 'The native source checkpoint is unverified.')
    workspace = Path.home() / 'dsh-workspaces' / f'task-{pipeline_id}'
    prefix = ['git', '-C', str(workspace), '-c', 'core.hooksPath=/dev/null']
    size = int(subprocess.check_output([*prefix, 'cat-file', '-s', f'{commit}:{path}'], timeout=15))
    if not 0 < size <= 2 * 1024 * 1024:
        raise ControlError('REPORT_ARCHIVE_INVALID', 'The native Markdown checkpoint exceeds its file budget.')
    data = subprocess.check_output([*prefix, 'show', f'{commit}:{path}'], timeout=15)
    data.decode('utf-8', errors='strict')
    return {'pipelineId': pipeline_id, 'requestId': key, 'sourceCommit': commit, 'path': path,
            'sha256': hashlib.sha256(data).hexdigest(), 'dataUrl': 'data:text/markdown;base64,' + base64.b64encode(data).decode()}


def reconcile(pipeline_id, key):
    # Only replay the exact saved native verdict. Never restart the worker or
    # its model, and never manufacture a receipt from an absent process.
    run = read_receipt(key)
    if run and run.get('reportName') and run['pipelineId'] == pipeline_id:
        spec = importlib.util.spec_from_file_location('coding_report', HERE/'coding_report.py')
        reporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reporter)
        return reporter.reconcile(load_runner(),pipeline_id,key)
    if not run or run["pipelineId"] != pipeline_id or not run.get("autonomous"):
        raise ControlError("CODING_DISPATCH_REQUEST_CONFLICT", "No matching autonomous receipt.")
    path = RECEIPTS / f"{key}.verdict.json"
    publication = RECEIPTS / f"{key}.publication.json"
    if not path.is_file() and publication.is_file() and publication.stat().st_size <= 65536:
        intent = json.loads(publication.read_text())
        if intent.get('requestId') != key or intent.get('pipelineId') != pipeline_id:
            raise ControlError('CODING_DISPATCH_REQUEST_CONFLICT', 'Publication receipt identity mismatch.')
        runner = load_runner()
        spec = importlib.util.spec_from_file_location('coding_publication', HERE / 'coding_publication.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        pr = module.recover(runner.request, intent, setting('GH_TOKEN'))
        value = json.loads((RECEIPTS / f'{key}.progress.json').read_text())
        value.update(pr=pr, checkpoint=pr['head'])
        atomic_json(RECEIPTS / f'{key}.progress.json', value)
        atomic_json(path, module.verdict(intent, pr))
    if not path.is_file() or path.stat().st_size > 65536:
        raise ControlError("CODING_DISPATCH_OUTCOME_UNKNOWN", "No durable native verdict to reconcile.")
    body = json.loads(path.read_text())
    runner = load_runner()
    runner.request(f"{CORE}/api/pipeline/tasks/{pipeline_id}/feedback", body)
    path = RECEIPTS / f"{key}.progress.json"
    value = json.loads(path.read_text())
    value.update(coreRecorded=True, phase="finished", result="review" if body.get("status") == "done" else "blocked",
                 stopReason=(body.get("attemptEvidence") or {}).get("failureCodes", [None])[0]
                 if (body.get("attemptEvidence") or {}).get("failureCodes") else None)
    atomic_json(path, value)
    return {"reconciled": True, "pipelineId": pipeline_id, "requestId": key}


def main() -> int:
    action, values = (sys.argv[1] if len(sys.argv) > 1 else ""), sys.argv[2:]
    try:
        if any(not REQUEST_ID.fullmatch(value) for value in (values[:1] if action == "status" else values[1:2])):
            raise ControlError("CODING_DISPATCH_INVALID_REQUEST", "A valid request id is required.", 400)
        if action == "status" and len(values) <= 1:
            data = status(values[0] if values else None)
        elif action in {"launch", "launch-autonomous"} and len(values) == 3 and re.fullmatch(r"\d{4}", values[0]) and values[2].isdigit():
            data = launch(values[0], values[1], int(values[2]), autonomous=action == "launch-autonomous")
        elif action == 'launch-report' and len(values) >= 4 and re.fullmatch(r'\d{4}', values[0]) and values[2].isdigit() and report_name(values[3]):
            flags = values[4:]
            allowed = {'--model-call-limit', '--parent-request-id', '--parent-sha256'}
            if len(flags) % 2 or any(flag not in allowed for flag in flags[::2]) or len(set(flags[::2])) != len(flags[::2]):
                raise ControlError('CODING_DISPATCH_INVALID_REQUEST', 'Invalid report launch options.', 400)
            options = dict(zip(flags[::2], flags[1::2]))
            raw_limit = options.get('--model-call-limit')
            if raw_limit is not None and not raw_limit.isdigit():
                raise ControlError('CODING_DISPATCH_INVALID_REQUEST', 'Invalid report call limit.', 400)
            data = launch(values[0], values[1], int(values[2]), report=values[3],
                          model_call_limit=int(raw_limit) if raw_limit is not None else None,
                          parent_request_id=options.get('--parent-request-id'), parent_sha256=options.get('--parent-sha256'))
        elif action == "observe" and len(values) == 2 and re.fullmatch(r"\d{4}", values[0]):
            data = observe(values[0], values[1])
        elif action == 'read-checkpoint' and len(values) == 3 and re.fullmatch(r'\d{4}', values[0]):
            data = read_checkpoint(values[0], values[1], values[2])
        elif action == "reconcile" and len(values) == 2 and re.fullmatch(r"\d{4}", values[0]):
            data = reconcile(values[0], values[1])
        elif action == "stop" and len(values) == 2 and re.fullmatch(r"\d{4}", values[0]):
            data = stop(values[0], values[1])
        else:
            raise ControlError("CODING_DISPATCH_INVALID_REQUEST", "Invalid control arguments.", 400)
        print(json.dumps({"status": "success", "data": data}))
    except ControlError as error:
        print(json.dumps({"status": "error", "statusCode": error.status, "code": error.code, "message": str(error)}))
    except Exception as error:
        print(json.dumps({"status": "error", "statusCode": 503, "code": "CODING_DISPATCH_STATUS_UNAVAILABLE",
                          "message": f"The host could not answer: {type(error).__name__}."}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
