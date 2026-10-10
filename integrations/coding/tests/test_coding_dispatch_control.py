import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("coding_dispatch_control", Path(__file__).resolve().parents[1] / "coding_dispatch_control.py")
control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(control)

KEY = "11111111-2222-4333-8444-555555555555"
TASKS = [
    {"pipelineId": "0001", "title": "Fix dates", "status": "queued", "service": "agentx-coding"},
    {"pipelineId": "0002", "title": "Groceries", "status": "queued", "service": "personal"},
    {"pipelineId": "0003", "title": "Owned", "status": "queued", "service": "core", "assignee": "someone"},
    {"pipelineId": "0004", "title": "Padded case", "status": "queued", "service": "  Household "},
    {"pipelineId": "0005", "title": "Family variant", "status": "queued", "service": "Family"},
    {"pipelineId": "0006", "title": "Secretary variant", "status": "queued", "service": "secretary"},
    {"pipelineId": "0007", "title": "Idea", "status": "queued", "service": "agentx-coding", "source": "idea-drop"},
    {"pipelineId": "0008", "title": "Household lane", "status": "queued", "service": "agentx-coding", "source": "Household-tasks"},
    {"pipelineId": "0009", "title": "Planning", "status": "queued", "service": "agentx-coding", "source": "idea-dropped"},
    {"pipelineId": "0010", "title": "Engineering", "status": "queued", "service": "core", "source": "household"},
]


class ControlTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.TemporaryDirectory()
        self.addCleanup(self.state.cleanup)
        for name, value in (("STATE", Path(self.state.name)), ("RECEIPTS", Path(self.state.name) / "requests"),
                            ("LEGACY_RECEIPTS", Path(self.state.name) / "legacy"),
                            ("queued_tasks", lambda: TASKS), ("unit_active", lambda: False)):
            patcher = mock.patch.object(control, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_only_explicit_coding_tasks_can_start(self):
        status = control.status()
        self.assertEqual([item["pipelineId"] for item in status["candidates"]], ["0001", "0009"])
        self.assertEqual((status["contractVersion"], status["busy"], status["run"]), (2, False, None))
        self.assertEqual(status["summary"], {"queuedTasks": 10, "eligibleTasks": 2, "privateQueuedTasks": 6})

    def test_private_lane_follows_the_core_scope_boundary(self):
        by_id = {item["pipelineId"]: item for item in TASKS}
        private = ("0002", "0004", "0005", "0006", "0007", "0008")
        for pipeline_id in private:
            self.assertTrue(control.is_private_task(by_id[pipeline_id]))
            self.assertFalse(control.can_start(by_id[pipeline_id]))
        for pipeline_id in ("0001", "0009", "0010"):
            self.assertFalse(control.is_private_task(by_id[pipeline_id]))
        for pipeline_id in ("0001", "0009"):
            self.assertTrue(control.can_start(by_id[pipeline_id]))
        self.assertFalse(control.can_start(by_id["0010"]))  # Core work needs explicit routing.
        self.assertFalse(control.can_start(by_id["0003"]))  # Owned tasks stay excluded.

    def test_launch_starts_the_runner_once_per_request(self):
        with mock.patch.object(control.subprocess, "run") as run:
            first = control.launch("0001", KEY, 0)
            again = control.launch("0001", KEY, 0)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][-4:], [str(control.HERE / "coding_run.py"), "0001", "--request-id", KEY])
        self.assertEqual((first["run"]["phase"], first["replayed"], again["replayed"]), ("accepted", False, True))
        self.assertEqual(control.status(KEY)["run"]["phase"], "unknown")

    def test_terminal_receipt_distinguishes_stopped_blocked_from_success(self):
        control.save_receipt({"requestId": KEY, "pipelineId": "0001", "phase": "accepted"})
        value = {"requestId": KEY, "pipelineId": "0001", "phase": "finished", "stage": "checkpoint",
                 "result": "blocked", "stopReason": "soft_budget_no_progress", "checkpoint": "a" * 40,
                 "command": "private-fixture", "rawOutput": "private-fixture",
                 "lastTest": {"name": "jest", "outcome": "failed", "output": "private-fixture"}}
        path = control.RECEIPTS / f"{KEY}.progress.json"
        path.write_text(json.dumps(value))
        observed = control.status(KEY)["run"]
        self.assertEqual((observed["phase"], observed["progress"]["result"]), ("finished", "blocked"))
        self.assertNotIn("private-fixture", json.dumps(observed))
        value["pipelineId"] = "0002"
        path.write_text(json.dumps(value))
        self.assertEqual(control.status(KEY)["run"]["phase"], "unknown")

    def test_inactive_accepted_launch_blocks_new_work_until_a_terminal_receipt(self):
        control.save_receipt({"requestId": KEY, "pipelineId": "0001", "phase": "accepted"})
        fresh = "22222222-2222-4333-8444-555555555555"
        with mock.patch.object(control.subprocess, "run") as run:
            with self.assertRaises(control.ControlError) as unknown:
                control.launch("0001", fresh, 0)
            self.assertEqual(unknown.exception.code, "CODING_DISPATCH_OUTCOME_UNKNOWN")
            run.assert_not_called()
            value = {"requestId": KEY, "pipelineId": "0001", "phase": "finished", "stage": "checkpoint",
                     "result": "blocked", "stopReason": "hard_budget"}
            (control.RECEIPTS / f"{KEY}.progress.json").write_text(json.dumps(value))
            self.assertFalse(control.launch("0001", fresh, 0)["replayed"])
        self.assertEqual(run.call_count, 1)

    def test_launch_refuses_a_busy_worker_and_a_private_task(self):
        with mock.patch.object(control.subprocess, "run") as run:
            with self.assertRaises(control.ControlError) as private:
                control.launch("0002", KEY, 0)
            with self.assertRaises(control.ControlError) as source_private:
                control.launch("0007", KEY, 0)
            with self.assertRaises(control.ControlError) as other_service:
                control.launch("0010", KEY, 0)
            with mock.patch.object(control, "unit_active", lambda: True), self.assertRaises(control.ControlError) as busy:
                control.launch("0001", KEY, 0)
        self.assertEqual((private.exception.code, source_private.exception.code, other_service.exception.code,
                          busy.exception.code, run.call_count),
                         ("CODING_DISPATCH_INELIGIBLE", "CODING_DISPATCH_INELIGIBLE",
                          "CODING_DISPATCH_INELIGIBLE", "CODING_DISPATCH_BUSY", 0))

    def test_command_line_always_answers_with_an_envelope(self):
        with mock.patch.object(sys, "argv", ["control", "launch", "0001", "not-a-request-id", "0"]), \
                mock.patch("builtins.print") as printed:
            control.main()
        self.assertEqual(json.loads(printed.call_args.args[0])["code"], "CODING_DISPATCH_INVALID_REQUEST")

    def test_stop_is_cooperative_idempotent_and_does_not_signal_a_shared_unit(self):
        control.save_receipt({"requestId": KEY, "pipelineId": "0001", "phase": "accepted"})
        with mock.patch.object(control, "unit_active", return_value=True), mock.patch.object(control.subprocess, "run") as host:
            self.assertTrue(control.status(KEY)["run"]["canStop"])
            first = control.stop("0001", KEY)
            path = control.RECEIPTS / f"{KEY}.stop.json"
            saved = path.read_text()
            self.assertEqual(control.stop("0001", KEY), first)
            self.assertEqual(path.read_text(), saved)
            self.assertEqual((control.status(KEY)["run"]["phase"], control.status(KEY)["run"]["canStop"]), ("stopping", False))
            host.assert_not_called()
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_stale_stop_cannot_affect_a_different_running_job(self):
        control.save_receipt({"requestId": KEY, "pipelineId": "0001", "phase": "accepted"})
        other = "22222222-2222-4333-8444-555555555555"
        control.save_receipt({"requestId": other, "pipelineId": "0009", "phase": "accepted"})
        with mock.patch.object(control, "unit_active", return_value=True), mock.patch.object(control.subprocess, "run") as host:
            with self.assertRaises(control.ControlError):
                control.stop("0001", KEY)
            with self.assertRaises(control.ControlError):
                control.stop("0001", other)
            self.assertEqual((control.status(KEY)["run"]["phase"], control.status(KEY)["run"]["canStop"]), ("unknown", False))
            self.assertTrue(control.status(other)["run"]["canStop"])
            self.assertFalse(any(control.RECEIPTS.glob("*.stop.json")))
            host.assert_not_called()

    def test_terminal_history_stays_terminal_while_another_worker_runs(self):
        control.save_receipt({"requestId": KEY, "pipelineId": "0001", "phase": "accepted"})
        value = {"requestId": KEY, "pipelineId": "0001", "phase": "finished", "stage": "checkpoint", "result": "blocked"}
        (control.RECEIPTS / f"{KEY}.progress.json").write_text(json.dumps(value))
        other = "22222222-2222-4333-8444-555555555555"
        control.save_receipt({"requestId": other, "pipelineId": "0009", "phase": "accepted"})
        with mock.patch.object(control, "unit_active", return_value=True):
            self.assertEqual((control.status(KEY)["run"]["phase"], control.status(KEY)["run"]["canStop"]), ("finished", False))
            self.assertTrue(control.stop("0001", KEY)["alreadyFinished"])
        self.assertFalse(any(control.RECEIPTS.glob("*.stop.json")))

    def test_stop_cannot_claim_to_revoke_publication_that_already_started(self):
        control.save_receipt({"requestId": KEY, "pipelineId": "0001", "phase": "accepted"})
        value = {"requestId": KEY, "pipelineId": "0001", "phase": "delivering", "stage": "publishing"}
        (control.RECEIPTS / f"{KEY}.progress.json").write_text(json.dumps(value))
        with mock.patch.object(control, "unit_active", return_value=True):
            self.assertFalse(control.status(KEY)["run"]["canStop"])
            with self.assertRaises(control.ControlError) as late:
                control.stop("0001", KEY)
        self.assertEqual(late.exception.code, "CODING_DISPATCH_STOP_TOO_LATE")
        self.assertFalse(any(control.RECEIPTS.glob("*.stop.json")))

    def test_lost_launch_reply_never_starts_the_same_or_a_new_request_again(self):
        with mock.patch.object(control.subprocess, "run", side_effect=TimeoutError) as run:
            with self.assertRaises(TimeoutError):
                control.launch("0001", KEY, 0)
            replay = control.launch("0001", KEY, 0)
            with self.assertRaises(control.ControlError) as unknown:
                control.launch("0001", "22222222-2222-4333-8444-555555555555", 0)
        self.assertEqual(run.call_count, 1)
        self.assertEqual((replay["replayed"], control.status(KEY)["run"]["phase"], unknown.exception.code),
                         (True, "unknown", "CODING_DISPATCH_OUTCOME_UNKNOWN"))

    def test_guarded_unknown_receipt_is_preserved_and_cannot_launch_the_new_worker(self):
        control.LEGACY_RECEIPTS.mkdir()
        original = {"requestId": KEY, "pipelineId": "0001", "phase": "unknown", "expectedAttemptCount": 0}
        path = control.LEGACY_RECEIPTS / f"{KEY}.json"
        path.write_text(json.dumps(original))
        with mock.patch.object(control.subprocess, "run") as run:
            observed = control.status(KEY)["run"]
            with self.assertRaises(control.ControlError) as retired:
                control.launch("0001", KEY, 0)
        self.assertEqual((observed["phase"], observed["retired"], observed["canRetry"]), ("unknown", True, False))
        self.assertEqual(retired.exception.code, "CODING_DISPATCH_RETIRED_REQUEST")
        self.assertEqual(json.loads(path.read_text()), original)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
