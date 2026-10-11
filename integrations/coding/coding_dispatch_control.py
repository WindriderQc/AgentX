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


def queued_tasks() -> list[dict]:
    with urlopen(f"{CORE}/api/pipeline/tasks?status=queued&limit=2000", timeout=10) as response:
        return json.load(response)["data"]["tasks"]


def is_private_task(task: dict) -> bool:
    # The Core service rule is anchored at both ends, the source rule only at the start.
    return bool(PRIVATE_SERVICE.fullmatch(str(task.get("service") or ""))
                or PRIVATE_SOURCE.match(str(task.get("source") or "")))


def can_start(task: dict) -> bool:
    return (task.get("status") == "queued" and not task.get("assignee")
            and task.get("service") == CODING_SERVICE
            and not is_private_task(task))


def unit_active() -> bool:
    state = subprocess.run(["systemctl", "--user", "is-active", UNIT], capture_output=True, text=True, timeout=8)
    return state.stdout.strip() in {"active", "activating", "deactivating"}


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
        return progress_module.safe_progress(json.loads(path.read_text()), key, run["pipelineId"])
    except (OSError, ValueError, TypeError):
        return None


def status(key: str | None = None) -> dict:
    tasks = queued_tasks()
    busy = unit_active()
    latest = RECEIPTS / "latest"
    run = read_receipt(key or (latest.read_text().strip() if latest.exists() else ""))
    progress = read_progress(run) if run else None
    current = bool(run and latest.exists() and latest.read_text().strip() == run["requestId"])
    if run and run["phase"] == "accepted":
        run["phase"] = "running" if busy and current else "finished" if progress and progress["phase"] == "finished" else "unknown"
        run["message"] = ("The coding worker is running." if run["phase"] == "running"
                          else "The coding worker stopped. Read its recorded result." if run["phase"] == "finished"
                          else "The host unit stopped without a terminal receipt. Inspect the task and checkpoint.")
    elif run and run["phase"] == "uncertain":
        run["phase"] = "running" if busy and current else "unknown"
        run["message"] = "Read the task and host unit to reconcile this launch; it will not be started again."
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
                    "privateQueuedTasks": sum(map(is_private_task, tasks))},
        "candidates": [{"pipelineId": task["pipelineId"], "title": task.get("title", ""),
                        "expectedAttemptCount": int(task.get("automationAttemptCount") or 0)}
                       for task in tasks if can_start(task)],
        "excluded": [], "run": run,
    }


def launch(pipeline_id: str, key: str, expected_attempt_count: int, *, autonomous=False) -> dict:
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / "coding-dispatcher-control.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = read_receipt(key)
        if previous:
            if previous.get('cancelledBeforeLaunch'):
                if previous['pipelineId'] != pipeline_id:
                    raise ControlError('CODING_DISPATCH_REQUEST_CONFLICT', 'Cancelled request belongs to another task.')
                return {'accepted': False, 'replayed': True, 'pipelineId': pipeline_id, 'run': previous}
            if previous["pipelineId"] != pipeline_id or previous.get("expectedAttemptCount", 0) != expected_attempt_count or bool(previous.get("autonomous")) != autonomous:
                raise ControlError("CODING_DISPATCH_REQUEST_CONFLICT", "This request id belongs to a different selection.")
            return {"accepted": True, "replayed": True, "pipelineId": pipeline_id, "run": previous}
        if (LEGACY_RECEIPTS / f"{key}.json").exists():
            raise ControlError("CODING_DISPATCH_RETIRED_REQUEST", "This request belongs to the retired guarded worker; inspect its preserved result.")
        if unit_active():
            raise ControlError("CODING_DISPATCH_BUSY", "The coding worker is already running a task.")
        latest = RECEIPTS / "latest"
        pending = read_receipt(latest.read_text().strip()) if latest.exists() else None
        terminal = read_progress(pending) if pending else None
        if pending and (pending["phase"] == "uncertain" or
                        pending["phase"] == "accepted" and not (terminal and terminal["phase"] == "finished")):
            raise ControlError("CODING_DISPATCH_OUTCOME_UNKNOWN", "Reconcile the previous launch before starting another task.")
        selected = next((task for task in queued_tasks() if task["pipelineId"] == pipeline_id and can_start(task)), None)
        if not selected:
            raise ControlError("CODING_DISPATCH_INELIGIBLE", "Only unowned, queued, non-private agentx-coding tasks can start.")
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
        save_receipt(run)
        subprocess.run(["systemd-run", "--user", "--collect", "--quiet", f"--unit={UNIT}",
                        f"--property=EnvironmentFile=-{ENV_FILE}", f"--setenv=AGENTX_CORE_URL={CORE}",
                        f"--setenv=PATH={os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')}",
                        sys.executable, str(HERE / "coding_run.py"), pipeline_id, "--request-id", key,
                        *(["--autonomous"] if autonomous else [])],
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
        if progress and progress["stage"] == "publishing":
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


def reconcile(pipeline_id, key):
    # Only replay the exact saved native verdict. Never restart the worker or
    # its model, and never manufacture a receipt from an absent process.
    run = read_receipt(key)
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
        elif action == "observe" and len(values) == 2 and re.fullmatch(r"\d{4}", values[0]):
            data = observe(values[0], values[1])
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
