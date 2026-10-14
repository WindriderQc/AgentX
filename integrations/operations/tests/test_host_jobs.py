import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_jobs.store import JobError, save
from host_jobs.supervisor import Supervisor
from host_jobs.worker import Worker
from host_jobs import schedule


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = {"version": 1, "revision": 1, "label": "Operations server", "hosts": {"desktop": {"label": "Workstation"}},
                       "jobs": [{"id": "usage", "name": "Usage counters", "kind": "codex-usage", "hostId": "desktop", "enabled": True,
                                 "schedule": {"type": "interval", "minutes": 15, "timezone": "UTC"}, "options": {"private": "on-host"}}]}
        save(self.root / "config.json", self.config)
        self.launches = []
        self.effects = []
        self.native = {}
        self.supervisor = Supervisor(self.root, launcher=lambda record: self.launches.append(record["requestId"]), remote=self.remote)

    def tearDown(self):
        self.temp.cleanup()

    def remote(self, host, verb, identifier=None, request_id=None, timeout=20, source_at=None):
        if verb == "inventory":
            return []
        if verb == "status":
            return self.native.get(request_id, {"state": "not-found"})
        self.effects.append(request_id)
        result = {"requestId": request_id, "jobId": identifier, "state": "completed", "finishedAt": datetime.now(timezone.utc).isoformat(),
                  "exitCode": 0, "metrics": {"files": 2, "verified": True}}
        self.native[request_id] = result
        return result

    def request(self):
        return str(uuid.uuid4())

    def test_same_identity_replays_the_result_without_another_launch(self):
        identity = self.request()
        self.supervisor.start("usage", identity, 1)
        self.supervisor.execute(identity)
        replay = self.supervisor.start("usage", identity, 1)
        self.assertEqual(replay["state"], "completed")
        self.assertEqual(self.launches, [identity])
        self.assertEqual(self.effects, [identity])

    def test_another_request_cannot_overlap_an_accepted_job(self):
        self.supervisor.start("usage", self.request())
        with self.assertRaisesRegex(JobError, "accepted or unresolved"):
            self.supervisor.start("usage", self.request())
        self.assertEqual(len(self.launches), 1)

    def test_lost_response_and_missing_native_receipt_stay_fenced(self):
        identity = self.request()
        self.supervisor.start("usage", identity)
        self.supervisor.remote = lambda *args, **kwargs: (_ for _ in ()).throw(JobError("NATIVE_OUTCOME_UNKNOWN", "Lost answer"))
        result = self.supervisor.execute(identity)
        self.assertEqual(result["state"], "unknown")
        self.supervisor.remote = lambda *args, **kwargs: {"state": "not-found"}
        self.supervisor.reconcile(identity)
        self.supervisor.tick()
        self.assertEqual(self.supervisor.store.record(identity)["state"], "unknown")
        with self.assertRaises(JobError):
            self.supervisor.start("usage", self.request())
        self.assertEqual(self.launches, [identity])

    def test_later_native_receipt_reconciles_the_original_identity(self):
        identity = self.request()
        self.supervisor.start("usage", identity)
        record = self.supervisor.store.record(identity)
        record.update(state="unknown", phase="dispatched")
        self.supervisor.store.write_record(record)
        self.native[identity] = {"requestId": identity, "jobId": "usage", "state": "completed", "finishedAt": schedule.instant("2026-01-01T00:00:00Z").isoformat(), "exitCode": 0}
        self.assertEqual(self.supervisor.reconcile(identity)["state"], "completed")
        self.assertEqual(self.effects, [])

    def test_proven_handshake_failure_retries_the_same_request(self):
        identity = self.request()
        self.supervisor.start("usage", identity)
        self.supervisor.remote = lambda *args, **kwargs: (_ for _ in ()).throw(JobError("HOST_UNAVAILABLE", "Offline"))
        result = self.supervisor.execute(identity)
        self.assertEqual(result["state"], "waiting-host")
        record = self.supervisor.store.record(identity)
        record["nextAttemptAt"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        self.supervisor.store.write_record(record)
        self.supervisor.tick()
        self.assertEqual(self.launches, [identity, identity])
        self.supervisor.remote = self.remote
        self.assertEqual(self.supervisor.execute(identity)["state"], "completed")
        self.assertEqual(self.effects, [identity])

    def test_installation_does_not_replay_old_occurrences(self):
        self.supervisor.tick()
        self.assertEqual(self.launches, [])
        state = self.supervisor.store.state()
        state["jobs"]["usage"]["lastDueAt"] = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        save(self.root / "state.json", state)
        self.supervisor.tick()
        self.supervisor.tick()
        self.assertEqual(len(self.launches), 1)

    def test_native_identity_mismatch_cannot_complete_or_release_a_job(self):
        identity = self.request()
        self.supervisor.start("usage", identity)
        self.supervisor.remote = lambda *args, **kwargs: {"requestId": self.request(), "jobId": "usage", "state": "completed", "finishedAt": schedule.instant("2026-01-01T00:00:00Z").isoformat()}
        self.assertEqual(self.supervisor.execute(identity)["state"], "unknown")

    def test_edits_are_revision_fenced_and_cannot_install_commands(self):
        self.supervisor.patch("usage", 1, {"enabled": False})
        with self.assertRaisesRegex(JobError, "configuration changed"):
            self.supervisor.patch("usage", 1, {"enabled": True})
        with self.assertRaises(JobError):
            self.supervisor.patch("usage", 2, {"command": "anything"})
        self.assertFalse(self.supervisor.store.config()["jobs"][0]["enabled"])
        self.assertEqual(self.launches, [])

    def test_public_status_has_no_executor_paths_or_options(self):
        identity = self.request()
        self.supervisor.start("usage", identity)
        status = self.supervisor.status()
        text = json.dumps(status)
        self.assertNotIn('"options"', text)
        self.assertNotIn('"private"', text)
        self.assertEqual(status["historyTotal"], 1)

    def test_interval_and_daily_time_zone_recurrence(self):
        previous, following = schedule.window({"type": "interval", "minutes": 15, "timezone": "UTC"}, schedule.instant("2026-01-01T10:17:00Z"))
        self.assertEqual(previous.minute, 15)
        self.assertEqual(following.minute, 30)
        previous, following = schedule.window({"type": "daily", "at": "03:45", "timezone": "America/New_York"}, schedule.instant("2026-03-08T07:00:00Z"))
        self.assertEqual(previous.isoformat(), "2026-03-07T08:45:00+00:00")
        self.assertEqual(following.isoformat(), "2026-03-08T07:45:00+00:00")
        for value in [True, 0, 1441]:
            with self.assertRaises(JobError):
                schedule.validate({"type": "interval", "minutes": value})

    def test_publication_gate_does_not_run_when_unchanged(self):
        source = self.root / "published.json"
        source.write_text('{"generatedAt":"2026-01-01T00:00:00Z"}')
        job = self.config["jobs"][0]
        job["gate"] = {"type": "file", "path": str(source), "dateField": "generatedAt"}
        save(self.root / "config.json", self.config)
        self.supervisor.tick()
        identity = self.request()
        self.supervisor.start("usage", identity)
        self.supervisor.execute(identity)
        state = self.supervisor.store.state()
        state["jobs"]["usage"]["lastDueAt"] = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        save(self.root / "state.json", state)
        self.supervisor.tick()
        self.assertEqual(len(self.effects), 1)
        self.assertEqual(len(self.launches), 1)

    def test_pause_and_schedule_edits_fence_a_stale_scheduler_dispatch(self):
        self.supervisor.patch("usage", 1, {"enabled": False})
        with self.assertRaises(JobError):
            self.supervisor.start("usage", self.request(), 1, trigger="scheduled")
        with self.assertRaises(JobError):
            self.supervisor.start("usage", self.request(), 2, trigger="scheduled")
        self.assertEqual(self.launches, [])

    def test_backup_handler_receives_the_acknowledged_completion_boundary(self):
        from host_jobs.handlers import prepare
        job = {"kind": "offhost-backup", "options": {"powershell": "pwsh", "script": "backup.ps1", "sourceHost": "operator@source", "sourceRoot": "/backups", "destination": "/destination", "applyRetention": True}}
        command, *_ = prepare(job, self.request(), "2026-01-01T03:00:38Z")
        self.assertIn("-CompletedBefore", command)
        self.assertIn("2026-01-01T03:00:38Z", command)
        self.assertIn("-ApplyRetention", command)

    def test_handlers_drop_stale_openssh_descriptors_but_preserve_their_environment(self):
        from unittest.mock import patch
        from host_jobs.handlers import prepare
        job = {"kind": "codex-usage", "options": {"node": "node", "script": "usage.js", "endpoint": "https://example.invalid"}}
        with patch.dict(os.environ, {"native_POSIX_FD_STATE": "stale-handles", "SSL_CERT_FILE": "owner-ca.pem"}):
            _, _, environment, _ = prepare(job, self.request())
        self.assertNotIn("native_POSIX_FD_STATE", environment)
        self.assertEqual(environment["SSL_CERT_FILE"], "owner-ca.pem")

    def test_usage_metrics_read_the_native_pretty_printed_summary_without_private_fields(self):
        from host_jobs.handlers import metrics
        output = json.dumps({"ok": True, "summary": {"sessions": 3, "tokens": 100, "hostId": "private-host"}}, indent=2)
        self.assertEqual(metrics({"kind": "codex-usage"}, None, output), {"sessions": 3, "accepted": True})

    def test_worker_state_survives_a_versioned_runtime_upgrade(self):
        import base64
        from host_jobs.transport import windows_command
        host = {"root": "C:/runtime/new", "stateRoot": "C:/state/stable", "python": "python"}
        command = windows_command(host, "status", request_id=self.request())
        script = base64.b64decode(command.split()[-1]).decode("utf-16le")
        self.assertIn(r"C:\runtime\new\host_job_worker.py", script)
        self.assertIn(r"C:\state\stable", script)

    def test_worker_replays_and_keeps_nonzero_child_exit_code(self):
        script = self.root / "child.py"
        marker = self.root / "effects.txt"
        script.write_text(f"from pathlib import Path\np=Path({str(marker)!r})\np.write_text(p.read_text()+'x' if p.exists() else 'x')\nraise SystemExit(7)\n")
        job = self.config["jobs"][0]
        job["options"] = {"node": sys.executable, "script": str(script), "endpoint": "https://example.invalid"}
        save(self.root / "config.json", self.config)
        worker = Worker(self.root)
        identity = self.request()
        result = worker.run("usage", identity)
        self.assertEqual(result["exitCode"], 7)
        self.assertEqual(worker.run("usage", identity)["state"], "failed")
        self.assertEqual(marker.read_text(), "x")


if __name__ == "__main__":
    unittest.main()
