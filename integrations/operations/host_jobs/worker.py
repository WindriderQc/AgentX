"""Workstation receipts fence the effect before a child process starts."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess

from . import handlers
from .store import JobError, Store, TERMINAL, exact_request, lock, load, now, save


def public_record(record):
    if not record:
        return {"state": "not-found", "dispatched": False}
    keys = ("requestId", "jobId", "state", "createdAt", "startedAt", "finishedAt", "exitCode", "metrics", "code")
    return {key: record.get(key) for key in keys if key in record}


class Worker:
    def __init__(self, root):
        self.store = Store(root)

    def status(self, request_id):
        return public_record(self.store.record(exact_request(request_id)))

    def run(self, identifier, request_id, source_at=None):
        exact_request(request_id)
        if source_at:
            from .schedule import instant
            source_at = instant(source_at).isoformat()
        config = self.store.config()
        job = self.store.job(config, identifier)
        with lock(self.store.root / (identifier + ".worker.lock"), blocking=False):
            existing = self.store.record(request_id)
            if existing:
                if existing["jobId"] != identifier or existing.get("sourceAt") != source_at:
                    raise JobError("REQUEST_CONFLICT", "This request identity belongs to another job.")
                return public_record(existing)
            active_path = self.store.root / (identifier + ".active.json")
            active = load(active_path)
            if active:
                prior = self.store.record(active["requestId"])
                if not prior or prior["state"] not in TERMINAL:
                    raise JobError("NATIVE_OUTCOME_UNKNOWN", "A prior native execution is unresolved.")
            command, cwd, environment, receipt = handlers.prepare(job, request_id, source_at)
            # No action has started before configuration is validated.
            record = {"requestId": request_id, "jobId": identifier, "state": "running", "phase": "dispatching",
                      "createdAt": now(), "startedAt": now(), "workerPid": os.getpid(), "sourceAt": source_at}
            self.store.write_record(record)
            save(active_path, {"requestId": request_id})
            logs = self.store.root / "private-logs"
            logs.mkdir(exist_ok=True)
            output = logs / (request_id + ".stdout")
            errors = logs / (request_id + ".stderr")
            try:
                flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
                with output.open("wb") as stdout, errors.open("wb") as stderr:
                    process = subprocess.Popen(command, cwd=cwd, env=environment, stdout=stdout, stderr=stderr,
                                               stdin=subprocess.DEVNULL, creationflags=flags)
                    record.update(phase="executing", childPid=process.pid)
                    self.store.write_record(record)
                    try:
                        exit_code = process.wait(timeout=int(job.get("timeoutSeconds", 3600)))
                    except subprocess.TimeoutExpired:
                        # The native child might still be executing. Keep its fence;
                        # process death or a missing response never authorizes replay.
                        record.update(state="unknown", code="CHILD_DEADLINE_UNRESOLVED")
                        self.store.write_record(record)
                        return public_record(record)
                record.update(state="completed" if exit_code == 0 else "failed", exitCode=exit_code, finishedAt=now(), phase="terminal")
                record["metrics"] = handlers.metrics(job, receipt, output.read_text(encoding="utf-8-sig", errors="replace")) if exit_code == 0 else {}
                if exit_code:
                    record["code"] = "HANDLER_FAILED"
            except OSError:
                record.update(state="failed", code="EXECUTABLE_UNAVAILABLE", finishedAt=now(), phase="terminal", exitCode=127)
            except Exception:
                # The child may have completed; if its result cannot be captured,
                # the outcome remains unknown rather than becoming a retry.
                record.update(state="unknown", code="RESULT_UNRESOLVED")
            self.store.write_record(record)
            return public_record(record)

    def inventory(self):
        if os.name != "nt":
            return []
        config = self.store.config()
        names = {job.get("legacyTask"): job["id"] for job in config["jobs"] if job.get("legacyTask")}
        legacy = {item["name"]: item for item in config.get("legacy", [])}
        script = r'''$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new();
$rows=@(Get-ScheduledTask | ForEach-Object {
$t=$_; $i=$t | Get-ScheduledTaskInfo; $exists=$true
foreach($a in $t.Actions) {if($a.Execute) {$exe=$a.Execute.Trim('"'); if([IO.Path]::IsPathRooted($exe) -and -not (Test-Path -LiteralPath $exe)) {$exists=$false}}}
[pscustomobject]@{name=$t.TaskName;folder=$t.TaskPath;state=[string]$t.State;enabled=$t.Settings.Enabled;lastResult=$i.LastTaskResult;lastRunAt=[string]$i.LastRunTime;nextRunAt=[string]$i.NextRunTime;executablePresent=$exists;triggers=@($t.Triggers|ForEach-Object {[pscustomobject]@{type=$_.CimClass.CimClassName;interval=$_.Repetition.Interval;start=$_.StartBoundary}})}
}); ConvertTo-Json -InputObject $rows -Depth 5 -Compress'''
        import base64
        command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.b64encode(script.encode("utf-16le")).decode()]
        result = subprocess.run(command, capture_output=True, timeout=40, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise JobError("INVENTORY_UNAVAILABLE", "The workstation task inventory is unavailable.", 503)
        rows = json.loads(result.stdout.decode("utf-8-sig"))
        for row in rows:
            row["category"] = "system" if row["folder"].startswith("\\Microsoft\\") else "provider"
            row["assessment"] = "provider-managed"
            if row["name"] in names:
                row.update(category="migrated", jobId=names[row["name"]], assessment="disable-legacy-schedule" if row["enabled"] else "server-managed")
            elif row["name"] in legacy:
                row.update(category="legacy", assessment=legacy[row["name"]].get("assessment", "review"))
            elif not row["executablePresent"]:
                row["assessment"] = "missing-executable"
        return rows
