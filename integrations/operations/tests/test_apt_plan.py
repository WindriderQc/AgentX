import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_jobs.apt_plan import NativeApt, in_window, policy_at, qualify
from host_jobs.handlers import prepare, metrics
from host_jobs.schedule import window, validate
from host_jobs.store import JobError, load, save
from host_jobs.transport import posix_command
from host_jobs.worker import Worker


def candidate(**changes):
    return {"package": "browser:amd64", "installed": "1.0", "candidate": "2.0", "source": "browser",
            "action": "upgrade", "held": False, "origins": ["Example"], "trusted": True, "security": True, **changes}


class Backend:
    def __init__(self):
        self.rows = [candidate()]
        self.changes = None
        self.calls = []
        self.exit = 0
        self.drift = False

    def snapshot(self):
        self.calls.append("snapshot")
        return "changed" if self.drift and self.calls.count("snapshot") > 1 else "stable"

    def audit(self):
        self.calls.append("audit")

    def candidates(self):
        return copy.deepcopy(self.rows)

    def resolve(self, selected):
        return copy.deepcopy(self.changes if self.changes is not None else selected)

    def simulate(self, changes):
        self.calls.append("simulate")
        return self.exit

    def index_age(self, at):
        return None


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.policy_path = self.root / "policy.json"
        self.receipt = self.root / "receipt.json"
        self.request = str(uuid.uuid4())
        self.policy = {"version": 1, "revision": 1, "mode": "simulate", "allowedSources": ["browser"],
                       "excludedSources": ["linux*", "systemd"], "allowedOrigins": ["Example"], "maxPackages": 4,
                       "maxIndexAgeHours": 48, "window": {"timezone": "America/Toronto", "weekday": 6,
                                                                  "start": "04:00", "end": "05:00"}}
        save(self.policy_path, self.policy)
        self.backend = Backend()

    def tearDown(self):
        self.temp.cleanup()

    def run_plan(self, **kwargs):
        return qualify(self.policy_path, self.receipt, self.request, self.backend,
                       datetime(2026, 11, 22, 9, 10, tzinfo=timezone.utc), **kwargs)

    def test_receipt_distinguishes_candidates_exclusions_simulation_and_missing_freshness(self):
        self.backend.rows.append(candidate(package="kernel", source="linux-image", security=False))
        receipt = self.run_plan()
        self.assertFalse(receipt["installationPerformed"])
        self.assertEqual(receipt["metrics"], {"simulationOnly": True, "pendingPackages": 2, "selectedPackages": 1,
                                            "excludedPackages": 1, "verified": True, "withinWindow": True, "indexesFresh": False})
        self.assertEqual(receipt["indexEvidence"], "unknown")

    def test_empty_security_batch_does_not_run_unqualified_candidates(self):
        self.backend.rows = [candidate(security=False)]
        receipt = self.run_plan()
        self.assertEqual(receipt["selected"], [])
        self.assertFalse(receipt["aptInvoked"])
        self.assertIsNone(receipt["aptExitCode"])
        self.assertNotIn("simulate", self.backend.calls)

    def test_every_resolved_dependency_is_checked_before_apt(self):
        for changed in [candidate(action="remove"), candidate(action="install"), candidate(action="downgrade"),
                        candidate(source="systemd"), candidate(held=True), candidate(trusted=False),
                        candidate(origins=["Other"]), candidate(package="--option"), candidate(candidate="2;echo")]:
            with self.subTest(changed=changed):
                self.receipt.unlink(missing_ok=True)
                self.backend = Backend()
                self.backend.changes = [changed]
                with self.assertRaises(JobError):
                    self.run_plan()
                self.assertNotIn("simulate", self.backend.calls)
                self.assertEqual(load(self.receipt)["state"], "failed")

    def test_explicit_exclusion_wins_over_allowlist(self):
        self.policy["excludedSources"].append("browser")
        save(self.policy_path, self.policy)
        self.assertEqual(self.run_plan()["metrics"]["selectedPackages"], 0)

    def test_batch_limit_is_applied_to_dependency_closure(self):
        self.backend.changes = [candidate(package="browser" + str(i)) for i in range(5)]
        with self.assertRaises(JobError):
            self.run_plan()
        self.assertNotIn("simulate", self.backend.calls)

    def test_true_apt_failure_cannot_be_a_completed_receipt(self):
        self.backend.exit = 100
        with self.assertRaises(JobError):
            self.run_plan()
        self.assertEqual(load(self.receipt)["aptExitCode"], 100)
        self.assertEqual(load(self.receipt)["code"], "APT_SIMULATION_FAILED")

    def test_changed_inputs_refuse_success(self):
        self.backend.drift = True
        with self.assertRaises(JobError):
            self.run_plan()
        self.assertEqual(load(self.receipt)["code"], "PATCH_INPUT_CHANGED")

    def test_replay_never_simulates_again_and_policy_change_conflicts(self):
        self.run_plan()
        self.run_plan()
        self.assertEqual(self.backend.calls.count("simulate"), 1)
        self.policy["revision"] = 2
        save(self.policy_path, self.policy)
        with self.assertRaises(JobError):
            self.run_plan()

    def test_string_receipt_path_from_cli_is_supported_for_new_qualification(self):
        result = qualify(str(self.policy_path), str(self.receipt), self.request, self.backend)
        self.assertEqual(result["state"], "completed")
        self.assertEqual(load(self.receipt)["requestId"], self.request)

    def test_actual_cli_replays_its_receipt_without_loading_native_apt(self):
        self.run_plan()
        before = self.receipt.read_bytes()
        script = Path(__file__).resolve().parents[1] / "apt-maintenance-plan.py"
        result = subprocess.run([sys.executable, str(script), "--policy", str(self.policy_path),
                                 "--receipt", str(self.receipt), "--request", self.request],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.receipt.read_bytes(), before)

    def test_apply_and_arbitrary_policy_fields_are_not_supported(self):
        for change in [{"mode": "apply"}, {"command": "apt-get upgrade"}, {"maxPackages": True}]:
            save(self.policy_path, {**self.policy, **change})
            with self.assertRaises(JobError):
                policy_at(self.policy_path)
        self.assertEqual(self.backend.calls, [])

    def test_manual_qualification_cannot_be_reused_as_window_enforced_occurrence(self):
        self.run_plan()
        with self.assertRaises(JobError):
            self.run_plan(enforce_window=True)

    def test_native_priority_update_stops_before_resolving_other_packages(self):
        backend = NativeApt.__new__(NativeApt)
        with patch("host_jobs.apt_plan.subprocess.run") as run:
            run.return_value.stdout = '{"priority":true,"security":[]}'
            with self.assertRaises(JobError) as caught:
                backend.candidates()
            self.assertEqual(caught.exception.code, "MINT_PRIORITY_UPDATE")

    def test_root_invocation_refuses_before_loading_apt(self):
        with patch("host_jobs.apt_plan.os.geteuid", return_value=0, create=True):
            with self.assertRaises(JobError):
                NativeApt()

    def test_real_window_rejects_suspend_catchup_before_package_work(self):
        with self.assertRaises(JobError):
            qualify(self.policy_path, self.receipt, self.request, self.backend,
                    datetime(2026, 11, 22, 16, tzinfo=timezone.utc), enforce_window=True)
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(load(self.receipt)["code"], "PATCH_WINDOW_MISSED")

    def test_weekly_cadence_tracks_local_hour_across_dst_and_no_missed_week_burst(self):
        schedule = {"type": "weekly", "weekday": 6, "at": "04:00", "timezone": "America/Toronto"}
        previous, following = window(schedule, datetime(2026, 10, 31, 18, tzinfo=timezone.utc))
        self.assertEqual(previous.isoformat(), "2026-10-25T08:00:00+00:00")
        self.assertEqual(following.isoformat(), "2026-11-01T09:00:00+00:00")
        self.assertTrue(in_window(self.policy, datetime(2026, 11, 22, 9, tzinfo=timezone.utc)))
        self.assertFalse(in_window(self.policy, datetime(2026, 11, 22, 10, tzinfo=timezone.utc)))
        for weekday in [True, -1, 7]:
            with self.assertRaises(JobError):
                validate({**schedule, "weekday": weekday})

    def test_posix_transport_quotes_local_configuration_and_only_named_inputs(self):
        command = posix_command({"root": "/opt/a path/operations", "python": "/usr/bin/python3"}, "run", "patch-plan", self.request)
        self.assertEqual(shlex.split(command)[:2], ["/usr/bin/python3", "/opt/a path/operations/host_job_worker.py"])
        with self.assertRaises(JobError):
            posix_command({"root": "/opt", "python": "python3"}, "run", "--command", self.request)

    def test_named_handler_fixes_simulation_entry_and_private_receipt_per_request(self):
        job = {"kind": "apt-maintenance-plan", "options": {"python": "/usr/bin/python3", "policy": str(self.policy_path), "stateRoot": str(self.root)}}
        command, _, _, path = prepare(job, self.request)
        self.assertIn("--enforce-window", command)
        self.assertEqual(path.name, self.request + ".json")
        self.assertNotIn("--apply", command)
        save(path, self.run_plan())
        projection = metrics(job, path, "")
        self.assertTrue(projection["simulationOnly"])
        self.assertNotIn("candidates", projection)

    def test_native_apt_always_simulates_and_propagates_exit_code(self):
        backend = NativeApt.__new__(NativeApt)
        with patch("host_jobs.apt_plan.subprocess.run") as run:
            run.return_value.returncode = 100
            run.return_value.stdout = run.return_value.stderr = ""
            self.assertEqual(backend.simulate([candidate()]), 100)
            args = run.call_args.args[0]
            self.assertIn("--simulate", args)
            self.assertIn("--no-remove", args)
            self.assertIn("--only-upgrade", args)
            self.assertEqual(args[-1], "browser:amd64=2.0")

    def test_worker_replay_reuses_original_native_receipt_without_a_child(self):
        save(self.root / "config.json", {"version": 1, "jobs": [{"id": "plan", "kind": "apt-maintenance-plan"}]})
        worker = Worker(self.root)
        worker.store.write_record({"requestId": self.request, "jobId": "plan", "state": "completed", "sourceAt": None})
        with patch("host_jobs.worker.subprocess.Popen") as child:
            self.assertEqual(worker.run("plan", self.request)["state"], "completed")
            child.assert_not_called()
