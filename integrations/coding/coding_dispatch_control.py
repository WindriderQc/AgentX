#!/usr/bin/env python3
"""Durable request receipts around the existing one-shot dispatcher; no scheduler."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SPEC = importlib.util.spec_from_file_location("coding_control_admission", Path(__file__).with_name("coding-dispatcher.py"))
admission = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = admission
SPEC.loader.exec_module(admission)
UNIT = "agentx-coding-dispatch-one-shot"
ACTIVE = {"active", "activating", "deactivating", "reloading"}
TERMINAL = {"finished", "rejected", "stopped"}


class ControlError(RuntimeError):
    def __init__(self, code, message, status=409, run=None):
        super().__init__(message)
        self.code, self.status, self.run = code, status, run


def request_id(value):
    if not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", str(value or "")):
        raise ControlError("CODING_DISPATCH_INVALID_REQUEST", "A valid request id is required.", 400)
    return value


@contextmanager
def file_lock(path):
    import fcntl
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class HostControl:
    def __init__(self, root=None, state_root=None, *, config=None, read_tasks=None,
                 unit_reader=None, starter=None, executor=None, lock_factory=None, work_busy=None):
        self.root = Path(root or Path(__file__).resolve().parents[2])
        self.state = Path(state_root or Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "agentx")
        self.receipts = self.state / "coding-dispatch-requests"
        self.config = config or admission.load_config(admission.DEFAULT_CONFIG)
        self.read_tasks = read_tasks or self._read_tasks
        self.unit_reader = unit_reader or self._unit
        self.starter = starter or self._start
        self.executor = executor or self._execute
        self.lock_factory = lock_factory or (lambda: file_lock(self.state / "coding-dispatcher-control.lock"))
        self.work_busy = work_busy or self._work_busy

    def _read_tasks(self):
        client = admission.PipelineClient(self.config["apiBase"], ca_file=os.environ.get("AGENTX_CODING_CA_FILE"), timeout=8)
        return client.list_tasks(self.config["maxCandidates"])

    def _unit(self):
        result = subprocess.run(["systemctl", "--user", "show", UNIT + ".service",
                                 "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "Result"],
                                capture_output=True, text=True, timeout=8)
        properties = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        if not properties.get("LoadState") or (result.returncode and properties["LoadState"] != "not-found"):
            raise ControlError("CODING_DISPATCH_STATUS_UNAVAILABLE", "The host run state is unavailable.", 503)
        return properties

    def _work_busy(self):
        import fcntl
        path = self.state / "coding-dispatcher-one-shot.lock"
        if not path.exists():
            return False
        with path.open("r") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            fcntl.flock(handle, fcntl.LOCK_UN)
        return False

    def _start(self, run):
        settings = [f"--setenv={key}={os.environ[key]}" for key in
                    ("AGENTX_CODING_CONFIG", "AGENTX_INSTANCE_ROOT", "AGENTX_CODING_CA_FILE", "AGENTX_CODING_SOURCE_REPO")
                    if os.environ.get(key)]
        subprocess.run(["/usr/bin/systemd-run", "--user", "--collect", "--quiet", "--unit=" + UNIT,
                        "--property=Type=exec", f"--property=RuntimeMaxSec={run.get('envelopeSeconds', 2700) + 60}", *settings, "/usr/bin/python3",
                        str(self.root / "integrations/coding/coding_dispatch_control.py"), "execute", run["requestId"]],
                       check=True, capture_output=True, text=True, timeout=10)

    def _execute(self, run):
        # This helper still owns the execution flock, policy checks, admission,
        # atomic Mongo claim, worker and independent verification. The request
        # id travels to the claim as a displayable reference, never as authority.
        return subprocess.run(["/usr/bin/bash", str(self.root / "integrations/coding/run-coding-dispatcher-one-shot.sh"),
                               run["pipelineId"]], check=False,
                              env={**os.environ, "AGENTX_CODING_DISPATCH_REQUEST_ID": request_id(run["requestId"])}).returncode

    def catalog(self):
        """Tracked repository paths and existing policies, never file contents or credentials."""
        projects = []
        inventories = {}
        for key, policy in self.config["policies"].items():
            profile = self.config["executionProfiles"][policy["executionProfiles"][0]]
            repo = profile["remoteRepo"]
            if repo not in inventories:
                if policy["repository"] != "agentx":
                    raise ControlError("CODING_DISPATCH_CATALOG_UNAVAILABLE", "Select the canonical AgentX repository.", 503)
                revision = subprocess.run(["git", "-C", str(self.root), "rev-parse", "HEAD"],
                                          capture_output=True, text=True, check=True, timeout=10).stdout.strip()
                exists = subprocess.run(["git", "-C", repo, "cat-file", "-e", revision + "^{commit}"],
                                        capture_output=True, timeout=10)
                if exists.returncode:
                    # Fetch objects only; preparation never changes an active worker's checkout.
                    subprocess.run(["git", "-C", repo, "fetch", "--quiet", "origin", revision],
                                   capture_output=True, check=True, timeout=15)
                result = subprocess.run(["git", "-C", repo, "ls-tree", "-r", "--name-only", revision],
                                        capture_output=True, text=True, check=True, timeout=10)
                inventories[repo] = result.stdout.splitlines()
            files = inventories[repo]
            projects.append({"policyRef": key, **policy, "files": files,
                             "authorityFiles": [path for path in ["AGENTS.md", "README.md"] if path in files]})
        return {"projects": projects}

    def _read(self, key):
        path = self.receipts / (request_id(key) + ".json")
        return json.loads(path.read_text()) if path.exists() else None

    def _save(self, run):
        self.receipts.mkdir(parents=True, exist_ok=True)
        path = self.receipts / (request_id(run["requestId"]) + ".json")
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(run))
        temporary.replace(path)

    def _latest(self):
        path = self.receipts / "latest"
        return self._read(path.read_text().strip()) if path.exists() else None

    def _observe(self, run, tasks, unit, busy):
        if not run:
            return None
        result = dict(run)
        task = next((task for task in tasks if task.get("pipelineId") == run["pipelineId"]), None)
        result["task"] = {key: task.get(key) for key in ("pipelineId", "status", "automationAttemptCount")} if task else None
        if run["phase"] == "unknown" and not busy and task and not task.get("automationLease"):
            completed = next((row for row in task.get("automationAttempts", [])
                              if row.get("dispatchRequestId") == run["requestId"]
                              and row.get("attempt") == run["expectedAttemptCount"] + 1
                              and row.get("completedAt") and row.get("finalState") == "review"
                              and row.get("evidence", {}).get("workerReceiptFingerprint")
                              and row.get("evidence", {}).get("verification", {}).get("status") == "passed"), None)
            if completed:
                result.update(phase="finished", message="Core records the verified completion of this exact request and attempt.")
        if run["phase"] in {"accepted", "running"} and unit.get("ActiveState") not in ACTIVE and not busy:
            result.update(phase="unknown" if run.get("startedAt") else "stopped",
                          message="The host run stopped. Read the task result; remote completion is unproven and no automatic retry was made.")
        return result

    def status(self, key=None):
        if key:
            request_id(key)
        tasks = self.read_tasks()
        report = admission.build_report(tasks, config=self.config, mode="shadow", now=admission.utc_now())
        unit = self.unit_reader()
        host_busy = unit.get("ActiveState") in ACTIVE or self.work_busy()
        busy = host_busy
        latest = self._latest()
        if latest:
            recovered = self._observe(latest, tasks, unit, host_busy)
            if recovered["phase"] != latest["phase"]:
                latest = recovered
                self._save(latest)
        # A transport failure may have occurred after systemd accepted the unit.
        # Keep that observation uncertain rather than inventing a failed task.
        busy = busy or bool(latest and latest["phase"] in {"submitting", "uncertain", "unknown", "waiting"})
        run = self._read(key) if key else latest
        observed = self._observe(run, tasks, unit, busy)
        if observed:
            observed["canRetry"] = observed["phase"] in {"submitting", "uncertain"} and not run.get("startedAt") and not host_busy
            observed["canCancel"] = observed["phase"] == "waiting" and not host_busy
        if key and not run:
            observed = {"requestId": key, "phase": "not_received", "message": "No receipt for this request. Retry only with the same request id."}
        by_id = {task["pipelineId"]: task for task in tasks}
        queued = [task for task in tasks if task.get("status") == "queued"]
        return {
            "contractVersion": 2, "available": True, "observedAt": report["observedAt"],
            "launchMode": "operator-one-shot", "persistentScheduler": False, "maxConcurrent": 1,
            "providerSpendCeilingNanodollars": 0, "stopsAt": ["review", "blocked"],
            "humanGates": ["review", "merge"], "busy": busy,
            "summary": {"queuedTasks": len(queued), "eligibleTasks": report["summary"]["admissibleTasks"],
                        "privateQueuedTasks": sum(admission.task_is_private(task) for task in queued)},
            "candidates": [{"pipelineId": item["pipelineId"], "title": item["title"],
                            "expectedAttemptCount": int(by_id[item["pipelineId"]].get("automationAttemptCount") or 0)}
                           for item in report["decisions"] if item["admissible"]],
            "excluded": [{"pipelineId": item["pipelineId"], "title": item["title"], "reasons": item["reasons"]}
                         for item in report["decisions"] if not item["admissible"]],
            "run": observed,
        }

    def launch(self, pipeline_id, key, expected_attempt_count):
        request_id(key)
        if not re.fullmatch(r"\d{4}", str(pipeline_id)) or not isinstance(expected_attempt_count, int) or not 0 <= expected_attempt_count <= 10000:
            raise ControlError("CODING_DISPATCH_INVALID_TASK", "An exact task and observed attempt count are required.", 400)
        with self.lock_factory():
            previous = self._read(key)
            resuming = False
            if previous:
                if previous["pipelineId"] != pipeline_id or previous["expectedAttemptCount"] != expected_attempt_count:
                    raise ControlError("CODING_DISPATCH_REQUEST_CONFLICT", "This request id belongs to a different selection.")
                observation = self.status(key)["run"]
                resuming = observation.get("canRetry") is True
                if not resuming:
                    return self._reply(previous, replayed=True)
            snapshot = self.status()
            run = {"requestId": key, "pipelineId": pipeline_id, "expectedAttemptCount": expected_attempt_count,
                   "submittedAt": admission.isoformat(admission.utc_now()), "unitName": UNIT, "phase": "submitting"}
            candidate = next((item for item in snapshot["candidates"] if item["pipelineId"] == pipeline_id), None)
            code = "CODING_DISPATCH_BUSY" if snapshot["busy"] and not resuming else "CODING_DISPATCH_INELIGIBLE" if not candidate else "CODING_DISPATCH_TASK_CHANGED" if candidate["expectedAttemptCount"] != expected_attempt_count else None
            if code:
                run.update(phase="rejected", code=code, message="The selected task cannot start. Refresh the host admission and task state.")
                self._save(run)
                return self._reply(run)
            task = next(task for task in self.read_tasks() if task.get("pipelineId") == pipeline_id)
            adapter = admission.build_adapter(config=self.config, automation=admission.normalize_automation(task["automation"]))
            run["envelopeSeconds"] = admission.dispatch_budget.dispatcher_timeout(
                adapter.execution, adapter.verification, task["automation"])
            self._save(run)
            latest = self.receipts / "latest"
            latest.with_suffix(".tmp").write_text(key)
            latest.with_suffix(".tmp").replace(latest)
            try:
                self.starter(run)
                run.update(phase="accepted", message="The host accepted this request. Task claiming and execution continue asynchronously.")
            except (subprocess.CalledProcessError, FileNotFoundError):
                run.update(phase="rejected", code="CODING_DISPATCH_HOST_REJECTED", message="The host refused this request before accepting the unit. Refresh before making a new selection.")
            except Exception:
                # Never resubmit an uncertain accepted transport with a new id.
                run.update(phase="uncertain", message="Host acceptance could not be confirmed. Refresh this request before deciding what to do next.")
            self._save(run)
            return self._reply(run)

    @staticmethod
    def _reply(run, replayed=False):
        if run["phase"] == "rejected":
            raise ControlError(run["code"], run["message"], run=run)
        return {"accepted": run["phase"] != "uncertain", "replayed": replayed, "pipelineId": run["pipelineId"], "run": run}

    def resume_waiting(self, key):
        """The existing host tick resumes only a previously accepted request."""
        with self.lock_factory():
            run = self._read(request_id(key))
            if not run or run["phase"] != "waiting" or self.unit_reader().get("ActiveState") in ACTIVE or self.work_busy():
                return {"resumed": False}
            try:
                self.starter(run)
                run.update(phase="accepted", message="The same request is checking the selected model capacity again.")
            except (subprocess.CalledProcessError, FileNotFoundError):
                return {"resumed": False}
            except Exception:
                run.update(phase="uncertain", message="Resume acceptance is unknown. Observe this request before another launch.")
            self._save(run)
            return {"resumed": run["phase"] == "accepted", "run": run}

    def cancel_waiting(self, key):
        with self.lock_factory():
            run = self._read(request_id(key))
            if not run or run["phase"] != "waiting" or self.unit_reader().get("ActiveState") in ACTIVE or self.work_busy():
                raise ControlError("CODING_DISPATCH_CANCEL_REFUSED", "Only an inactive capacity wait can be cancelled.")
            task = next((task for task in self.read_tasks() if task.get("pipelineId") == run["pipelineId"]), {})
            if task.get("status") != "queued" or int(task.get("automationAttemptCount") or 0) != run["expectedAttemptCount"]:
                raise ControlError("CODING_DISPATCH_TASK_CHANGED", "The waiting task changed; inspect its existing attempt.")
            if task.get("codingCapacity"):
                try:
                    from integrations.coding.clawdx_dispatch_api import api_json
                except ModuleNotFoundError:
                    from clawdx_dispatch_api import api_json
                api_json(self.config["apiBase"], f"/api/pipeline/tasks/{run['pipelineId']}/capacity/cancel",
                         method="POST", payload={"requestId": key}, retries=0)
            run.update(phase="stopped", message="Capacity waiting was cancelled. The task remains queued and no attempt was consumed.")
            self._save(run)
            return {"cancelled": True, "run": run}

    def execute(self, key):
        with self.lock_factory():
            run = self._read(key)
            if not run or run.get("startedAt") or run["phase"] in TERMINAL:
                return 0
            # Repeat current admission after asynchronous acceptance. A requeue
            # cannot turn an old request into a new task attempt.
            tasks = self.read_tasks()
            report = admission.build_report(tasks, config=self.config, mode="shadow", now=admission.utc_now())
            task = next((task for task in tasks if task.get("pipelineId") == run["pipelineId"]), {})
            eligible = any(item["pipelineId"] == run["pipelineId"] and item["admissible"] for item in report["decisions"])
            if not eligible or int(task.get("automationAttemptCount") or 0) != run["expectedAttemptCount"]:
                run.update(phase="rejected", code="CODING_DISPATCH_TASK_CHANGED", message="The task changed before execution; nothing was dispatched.")
                self._save(run)
                return 0
            run.update(phase="running", startedAt=admission.isoformat(admission.utc_now()), message="The host is running the bounded dispatcher; task status remains authoritative.")
            self._save(run)
        try:
            exit_code = self.executor(run)
        except Exception:
            exit_code = -1
        with self.lock_factory():
            unknown = exit_code == admission.dispatch_budget.UNKNOWN_EXIT or exit_code < 0
            waiting = exit_code == admission.dispatch_budget.DEFERRED_EXIT
            run.update(phase="waiting" if waiting else "unknown" if unknown else "finished", exitCode=exit_code,
                       finishedAt=admission.isoformat(admission.utc_now()),
                       message="Waiting for the selected coding capacity. No attempt was consumed; the host tick resumes this same request."
                       if waiting else "Execution completion is unproven. Recover this request and task before another launch."
                       if unknown else "The host dispatcher finished. Read the task status and dossier for its outcome.")
            if waiting:
                run.setdefault("waitingSince", run["startedAt"])
                run.pop("startedAt", None)
                run.pop("finishedAt", None)
            self._save(run)
        return exit_code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["status", "launch", "execute", "catalog", "resume-waiting", "cancel-waiting"])
    parser.add_argument("values", nargs="*")
    args = parser.parse_args()
    try:
        control = HostControl()
        if args.action == "execute" and len(args.values) == 1:
            return control.execute(request_id(args.values[0]))
        if args.action == "catalog" and not args.values:
            data = control.catalog()
        elif args.action == "resume-waiting" and len(args.values) == 1:
            data = control.resume_waiting(args.values[0])
        elif args.action == "cancel-waiting" and len(args.values) == 1:
            data = control.cancel_waiting(args.values[0])
        elif args.action == "status" and len(args.values) <= 1:
            data = control.status(args.values[0] if args.values else None)
        elif args.action == "launch" and len(args.values) == 3:
            data = control.launch(args.values[0], args.values[1], int(args.values[2]))
        else:
            raise ControlError("CODING_DISPATCH_INVALID_REQUEST", "Invalid control arguments.", 400)
        print(json.dumps({"status": "success", "data": data}))
    except ControlError as error:
        print(json.dumps({"status": "error", "statusCode": error.status, "code": error.code, "message": str(error), "data": {"run": error.run}}))
    except Exception:
        print(json.dumps({"status": "error", "statusCode": 503, "code": "CODING_DISPATCH_STATUS_UNAVAILABLE", "message": "The host observation is unavailable. Refresh to recover the same request."}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
