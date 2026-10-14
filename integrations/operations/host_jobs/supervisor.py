"""Server-owned recurrence, durable dispatch fences and bounded native controls."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import subprocess
import sys
import uuid

from . import schedule, transport
from .store import JobError, Store, TERMINAL, exact_id, exact_request, now, save

PUBLIC_RUN_KEYS = ("requestId", "jobId", "state", "trigger", "createdAt", "startedAt", "finishedAt", "dueAt", "nextAttemptAt", "code", "exitCode", "metrics", "sourceAt")


def public_run(record):
    return {key: record.get(key) for key in PUBLIC_RUN_KEYS if key in record}


class Supervisor:
    def __init__(self, root, launcher=None, remote=None):
        self.store = Store(root)
        self.launcher = launcher or self.launch_unit
        self.remote = remote or transport.call

    def launch_unit(self, record):
        control = str(Path(__file__).resolve().parents[1] / "host_jobs_control.py")
        command = ["systemd-run", "--user", "--quiet", "--collect", "--unit", "agentx-operations-" + record["requestId"],
                   "--property=Type=exec", "--property=TimeoutStopSec=30", "--property=RuntimeMaxSec=" + str(record["job"].get("timeoutSeconds", 3600) + 90),
                   sys.executable, control, "--root", str(self.store.root), "execute", "--request", record["requestId"]]
        try:
            result = subprocess.run(command, capture_output=True, timeout=15)
        except subprocess.TimeoutExpired:
            raise JobError("SUPERVISOR_OUTCOME_UNKNOWN", "The supervisor response is unavailable.", 503)
        except OSError:
            raise JobError("SUPERVISOR_UNAVAILABLE", "The native supervisor is unavailable.", 503)
        if result.returncode:
            raise JobError("SUPERVISOR_REFUSED", "The native supervisor refused this execution.", 503)

    def _launch(self, record):
        try:
            self.launcher(record)
        except JobError as error:
            with self.store.locked():
                current = self.store.record(record["requestId"])
                # A worker may already have advanced while the launch answer was
                # lost. Never replace its running or completed result.
                if current["state"] in {"accepted", "waiting-host"}:
                    current.update(state="unknown" if error.code == "SUPERVISOR_OUTCOME_UNKNOWN" else "failed", code=error.code)
                    if current["state"] == "failed":
                        current["finishedAt"] = now()
                    self.store.write_record(current)
            raise

    def start(self, identifier, request_id, revision=None, trigger="manual", due_at=None, gate=None):
        exact_id(identifier)
        exact_request(request_id)
        with self.store.locked():
            config = self.store.config()
            existing = self.store.record(request_id)
            if existing:
                if existing["jobId"] != identifier:
                    raise JobError("REQUEST_CONFLICT", "This request belongs to another job.")
                return public_run(existing)
            if revision is not None and revision != config.get("revision", 1):
                raise JobError("REVISION_CONFLICT", "The configuration changed. Refresh before editing.")
            job = self.store.job(config, identifier)
            if trigger == "scheduled" and not job.get("enabled"):
                raise JobError("JOB_PAUSED", "Automatic starts are paused for this job.")
            state = self.store.state()
            own = state["jobs"].setdefault(identifier, {})
            active = self.store.record(own["activeRequest"]) if own.get("activeRequest") else None
            if active and active["state"] not in TERMINAL:
                raise JobError("JOB_ACTIVE", "This job already has an accepted or unresolved execution.")
            resolved_gate = gate or schedule.source_marker(job, own.get("source"))
            if not resolved_gate.get("ready"):
                raise JobError(resolved_gate.get("code", "SOURCE_UNAVAILABLE"), resolved_gate.get("label", "The source is unavailable."))
            record = {"requestId": request_id, "jobId": identifier, "state": "accepted", "phase": "prepared", "trigger": trigger,
                      "createdAt": now(), "dueAt": due_at, "source": resolved_gate, "sourceAt": resolved_gate.get("sourceAt"),
                      "job": job, "host": config["hosts"][job["hostId"]], "revision": config.get("revision", 1)}
            self.store.write_record(record)
            own.update(activeRequest=request_id, lastRequest=request_id, source=resolved_gate)
            if due_at:
                own["lastDueAt"] = due_at
            save(self.store.state_path, state)
        self._launch(record)
        return public_run(self.store.record(request_id))

    def execute(self, request_id):
        from .store import lock
        exact_request(request_id)
        with lock(self.store.root / (request_id + ".dispatch.lock"), blocking=False):
            with self.store.locked():
                record = self.store.record(request_id)
                if not record:
                    raise JobError("RUN_NOT_FOUND", "This execution was not accepted.", 404)
                if record["state"] in TERMINAL:
                    return public_run(record)
                already_dispatched = record.get("phase") != "prepared"
                if not already_dispatched:
                    record.update(state="running", phase="dispatched", startedAt=now())
                    self.store.write_record(record)
            if already_dispatched:
                return self.reconcile(request_id)
            try:
                result = self.remote(record["host"], "run", record["jobId"], request_id,
                                     timeout=int(record["job"].get("timeoutSeconds", 3600)) + 30,
                                     source_at=record.get("sourceAt") if record["job"]["kind"] == "offhost-backup" else None)
                return self.accept_result(record, result)
            except JobError as error:
                with self.store.locked():
                    record = self.store.record(request_id)
                    if error.code == "HOST_UNAVAILABLE":
                        # The SSH handshake failed before a native command was
                        # accepted: the same identity may be attempted later.
                        record.update(state="waiting-host", phase="prepared", code="HOST_UNAVAILABLE",
                                      nextAttemptAt=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat())
                    else:
                        record.update(state="unknown", code=error.code)
                    self.store.write_record(record)
                return public_run(record)

    def accept_result(self, record, native):
        if native.get("requestId") != record["requestId"] or native.get("jobId") != record["jobId"]:
            raise JobError("NATIVE_IDENTITY_MISMATCH", "The native result identity does not match.", 503)
        with self.store.locked():
            current = self.store.record(record["requestId"])
            if current["state"] in TERMINAL:
                return public_run(current)
            native_state = native.get("state")
            if native_state not in TERMINAL | {"running", "unknown"}:
                raise JobError("NATIVE_RESULT_INVALID", "The native outcome is not proven.", 503)
            current.update({key: native[key] for key in ("state", "finishedAt", "exitCode", "metrics", "code") if key in native})
            if native_state in TERMINAL:
                if not native.get("finishedAt"):
                    raise JobError("NATIVE_RESULT_INVALID", "The native terminal receipt is incomplete.", 503)
                current["phase"] = "terminal"
                current.pop("nextAttemptAt", None)
                state = self.store.state()
                own = state["jobs"].setdefault(record["jobId"], {})
                own["lastRequest"] = record["requestId"]
                if native_state == "completed":
                    own.update(lastSuccessAt=native["finishedAt"], lastMarker=record["source"].get("marker"), consecutiveFailures=0)
                elif native_state == "failed":
                    own["consecutiveFailures"] = own.get("consecutiveFailures", 0) + 1
                save(self.store.state_path, state)
            self.store.write_record(current)
            return public_run(current)

    def reconcile(self, request_id):
        record = self.store.record(exact_request(request_id))
        if not record:
            raise JobError("RUN_NOT_FOUND", "This execution is unavailable.", 404)
        if record["state"] in TERMINAL | {"waiting-host"}:
            return public_run(record)
        try:
            result = self.remote(record["host"], "status", request_id=request_id)
            if result.get("state") == "not-found":
                # Not found after the dispatch fence is an uncertain outcome,
                # including a delayed SSH command. Never start a replacement.
                return public_run(record)
            return self.accept_result(record, result)
        except JobError:
            return public_run(record)

    def patch(self, identifier, revision, changes):
        if not isinstance(changes, dict) or not changes or set(changes) - {"enabled", "schedule"}:
            raise JobError("INVALID_CHANGE", "Only enabled state and cadence can be edited.", 400)
        with self.store.locked():
            config = self.store.config()
            if revision != config.get("revision", 1):
                raise JobError("REVISION_CONFLICT", "The configuration changed. Refresh before editing.")
            job = self.store.job(config, identifier)
            if "enabled" in changes:
                if not isinstance(changes["enabled"], bool):
                    raise JobError("INVALID_CHANGE", "Enabled must be a boolean.", 400)
                job["enabled"] = changes["enabled"]
            if "schedule" in changes:
                incoming = changes["schedule"]
                if not isinstance(incoming, dict) or set(incoming) - {"type", "minutes", "at", "timezone"}:
                    raise JobError("INVALID_SCHEDULE", "The cadence contains unsupported fields.", 400)
                job["schedule"] = schedule.validate(incoming)
            config["revision"] = config.get("revision", 1) + 1
            save(self.store.config_path, config)
            if changes.get("enabled") is True:
                state = self.store.state()
                state["jobs"].setdefault(identifier, {})["consecutiveFailures"] = 0
                save(self.store.state_path, state)
        return {"revision": config["revision"], "jobId": identifier}

    def tick(self):
        config = self.store.config()
        at = datetime.now(timezone.utc)
        for job in config["jobs"]:
            state = self.store.state()
            own = state["jobs"].get(job["id"], {})
            active = self.store.record(own["activeRequest"]) if own.get("activeRequest") else None
            if active and active["state"] not in TERMINAL:
                if active["state"] == "waiting-host":
                    if job.get("enabled") and schedule.instant(active["nextAttemptAt"]) <= at:
                        self._launch(active)
                else:
                    self.reconcile(active["requestId"])
                continue
            if not job.get("enabled") or own.get("consecutiveFailures", 0) >= 3:
                continue
            due, following = schedule.window(job["schedule"], at)
            if not own.get("lastDueAt"):
                # Installation anchors the next occurrence; it never immediately
                # launches all imported jobs or replays an old daily run.
                with self.store.locked():
                    state = self.store.state()
                    state["jobs"].setdefault(job["id"], {})["lastDueAt"] = due.isoformat()
                    save(self.store.state_path, state)
                continue
            if schedule.instant(own["lastDueAt"]) >= due:
                continue
            source = schedule.source_marker(job, own.get("source"))
            with self.store.locked():
                state = self.store.state()
                state["jobs"].setdefault(job["id"], {})["source"] = source
                save(self.store.state_path, state)
            if not source["ready"]:
                continue
            if job.get("gate") and source.get("marker") == own.get("lastMarker"):
                with self.store.locked():
                    state = self.store.state()
                    state["jobs"][job["id"]]["lastDueAt"] = due.isoformat()
                    save(self.store.state_path, state)
                continue
            try:
                self.start(job["id"], str(uuid.uuid4()), revision=config.get("revision", 1), trigger="scheduled", due_at=due.isoformat(), gate=source)
            except JobError:
                continue
        with self.store.locked():
            state = self.store.state()
            state["lastTickAt"] = now()
            save(self.store.state_path, state)
        self.refresh_inventory(config)
        return {"lastTickAt": now()}

    def refresh_inventory(self, config=None):
        config = config or self.store.config()
        state = self.store.state()
        inventory = state.get("inventory") or {}
        if inventory.get("observedAt") and datetime.now(timezone.utc) - schedule.instant(inventory["observedAt"]) < timedelta(minutes=5):
            return
        rows, unavailable = [], []
        for host_id, host in config.get("hosts", {}).items():
            try:
                native = self.remote(host, "inventory", timeout=45)
                if not isinstance(native, list) or len(native) > 2000 or any(not isinstance(row, dict) for row in native):
                    raise JobError("INVENTORY_UNAVAILABLE", "The native inventory is incomplete.", 503)
                rows += [{**row, "hostId": host_id, "hostLabel": host["label"]} for row in native]
            except JobError:
                unavailable.append(host_id)
        with self.store.locked():
            state = self.store.state()
            if not unavailable:
                state["inventory"] = {"observedAt": now(), "rows": rows, "unavailable": []}
            else:
                state["inventory"] = {**inventory, "lastAttemptAt": now(), "unavailable": unavailable}
            save(self.store.state_path, state)

    def status(self, limit=50, offset=0):
        config, state = self.store.config(), self.store.state()
        jobs = []
        for job in config["jobs"]:
            own = state["jobs"].get(job["id"], {})
            record = self.store.record(own["lastRequest"]) if own.get("lastRequest") else None
            _, following = schedule.window(job["schedule"])
            source = own.get("source", {})
            status = record.get("state") if record else "never"
            if record and status in TERMINAL and own.get("consecutiveFailures", 0) >= 3:
                status = "attention"
            jobs.append({"id": job["id"], "name": job["name"], "description": job.get("description", ""), "kind": job["kind"],
                         "enabled": job.get("enabled", False), "schedule": job["schedule"], "state": status,
                         "hostLabel": config["hosts"][job["hostId"]]["label"], "supervisorLabel": config.get("label", "Operations server"),
                         "nextRunAt": record.get("nextAttemptAt") if record and status == "waiting-host" else (following.isoformat() if job.get("enabled") and status not in {"unknown", "attention"} else None),
                         "source": {key: source.get(key) for key in ("ready", "label", "code", "sourceAt", "cached") if key in source},
                         "gateType": (job.get("gate") or {}).get("type"), "lastRun": public_run(record) if record else None,
                         "lastSuccessAt": own.get("lastSuccessAt"), "failureCount": own.get("consecutiveFailures", 0), "legacyTask": job.get("legacyTask")})
        history, total = self.store.history(limit, offset)
        inventory = state.get("inventory") or {}
        return {"contract": "agentx.operations/v1", "available": True, "revision": config.get("revision", 1), "observedAt": now(),
                "supervisor": {"label": config.get("label", "Operations server"), "lastTickAt": state.get("lastTickAt"), "pollSeconds": 60},
                "jobs": jobs, "history": [public_run(record) for record in history], "historyTotal": total,
                "inventory": inventory, "legacy": config.get("legacy", [])}
