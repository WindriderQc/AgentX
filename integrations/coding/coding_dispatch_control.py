#!/usr/bin/env python3
"""Host side of the Pipeline page's "Run one task": list what can start, start one."""

from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone
from urllib.request import urlopen


HERE = Path(__file__).resolve().parent
CORE = os.environ.get("AGENTX_CORE_URL", "http://127.0.0.1:3180").rstrip("/")
STATE = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "agentx"
RECEIPTS = STATE / "coding-dispatch-requests"
# Model, GitHub token and other settings of the run; they stay outside Git.
ENV_FILE = Path(os.environ.get("AGENTX_CODING_ENV_FILE", Path.home() / ".config/agentx/coding.env"))
UNIT = "agentx-coding-run"
PRIVATE_SERVICES = {"personal", "family", "household", "secretary"}
REQUEST_ID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")


class ControlError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.status = code, status


def queued_tasks() -> list[dict]:
    with urlopen(f"{CORE}/api/pipeline/tasks?status=queued&limit=2000", timeout=10) as response:
        return json.load(response)["data"]["tasks"]


def can_start(task: dict) -> bool:
    return (task.get("status") == "queued" and not task.get("assignee")
            and str(task.get("service") or "").lower() not in PRIVATE_SERVICES)


def unit_active() -> bool:
    state = subprocess.run(["systemctl", "--user", "is-active", UNIT], capture_output=True, text=True, timeout=8)
    return state.stdout.strip() in {"active", "activating", "deactivating"}


def read_receipt(key: str) -> dict | None:
    path = RECEIPTS / f"{key}.json"
    return json.loads(path.read_text()) if path.exists() else None


def save_receipt(run: dict) -> None:
    RECEIPTS.mkdir(parents=True, exist_ok=True)
    (RECEIPTS / f"{run['requestId']}.json").write_text(json.dumps(run))
    (RECEIPTS / "latest").write_text(run["requestId"])


def status(key: str | None = None) -> dict:
    tasks = queued_tasks()
    busy = unit_active()
    latest = RECEIPTS / "latest"
    run = read_receipt(key or (latest.read_text().strip() if latest.exists() else ""))
    if run and run["phase"] == "accepted":
        run["phase"] = "running" if busy else "finished"
        run["message"] = ("The coding worker is running." if busy
                          else "The coding worker stopped. Read the task for its result.")
    elif run and run["phase"] == "uncertain":
        run["phase"] = "running" if busy else "unknown"
        run["message"] = "Read the task and host unit to reconcile this launch; it will not be started again."
    if key and not run:
        run = {"requestId": key, "phase": "not_received", "message": "No receipt for this request."}
    return {
        "contractVersion": 2, "available": True, "busy": busy,
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "summary": {"queuedTasks": len(tasks), "eligibleTasks": sum(map(can_start, tasks)),
                    "privateQueuedTasks": sum(str(task.get("service") or "").lower() in PRIVATE_SERVICES for task in tasks)},
        "candidates": [{"pipelineId": task["pipelineId"], "title": task.get("title", ""),
                        "expectedAttemptCount": int(task.get("automationAttemptCount") or 0)}
                       for task in tasks if can_start(task)],
        "excluded": [], "run": run,
    }


def launch(pipeline_id: str, key: str, expected_attempt_count: int) -> dict:
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / "coding-dispatcher-control.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = read_receipt(key)
        if previous:
            if previous["pipelineId"] != pipeline_id:
                raise ControlError("CODING_DISPATCH_REQUEST_CONFLICT", "This request id belongs to a different selection.")
            return {"accepted": True, "replayed": True, "pipelineId": pipeline_id, "run": previous}
        if unit_active():
            raise ControlError("CODING_DISPATCH_BUSY", "The coding worker is already running a task.")
        latest = RECEIPTS / "latest"
        pending = read_receipt(latest.read_text().strip()) if latest.exists() else None
        if pending and pending["phase"] == "uncertain":
            raise ControlError("CODING_DISPATCH_OUTCOME_UNKNOWN", "Reconcile the previous launch before starting another task.")
        if not any(task["pipelineId"] == pipeline_id and can_start(task) for task in queued_tasks()):
            raise ControlError("CODING_DISPATCH_INELIGIBLE", "This task is not queued, is owned, or is a private task.")
        run = {"requestId": key, "pipelineId": pipeline_id, "expectedAttemptCount": expected_attempt_count,
               "submittedAt": datetime.now(timezone.utc).isoformat(), "unitName": UNIT, "phase": "uncertain",
               "message": "The host is starting the coding worker."}
        save_receipt(run)
        subprocess.run(["systemd-run", "--user", "--collect", "--quiet", f"--unit={UNIT}",
                        f"--property=EnvironmentFile=-{ENV_FILE}", f"--setenv=AGENTX_CORE_URL={CORE}",
                        f"--setenv=PATH={os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')}",
                        sys.executable, str(HERE / "coding_run.py"), pipeline_id],
                       check=True, capture_output=True, text=True, timeout=10)
        run.update(phase="accepted", message="The coding worker started on this task.")
        save_receipt(run)
        return {"accepted": True, "replayed": False, "pipelineId": pipeline_id, "run": run}


def main() -> int:
    action, values = (sys.argv[1] if len(sys.argv) > 1 else ""), sys.argv[2:]
    try:
        if any(not REQUEST_ID.fullmatch(value) for value in (values[:1] if action == "status" else values[1:2])):
            raise ControlError("CODING_DISPATCH_INVALID_REQUEST", "A valid request id is required.", 400)
        if action == "status" and len(values) <= 1:
            data = status(values[0] if values else None)
        elif action == "launch" and len(values) == 3 and re.fullmatch(r"\d{4}", values[0]) and values[2].isdigit():
            data = launch(values[0], values[1], int(values[2]))
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
