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
]


class ControlTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.TemporaryDirectory()
        self.addCleanup(self.state.cleanup)
        for name, value in (("STATE", Path(self.state.name)), ("RECEIPTS", Path(self.state.name) / "requests"),
                            ("queued_tasks", lambda: TASKS), ("unit_active", lambda: False)):
            patcher = mock.patch.object(control, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_any_queued_unowned_non_private_task_can_start(self):
        status = control.status()
        self.assertEqual([item["pipelineId"] for item in status["candidates"]], ["0001"])
        self.assertEqual((status["contractVersion"], status["busy"], status["run"]), (2, False, None))

    def test_launch_starts_the_runner_once_per_request(self):
        with mock.patch.object(control.subprocess, "run") as run:
            first = control.launch("0001", KEY, 0)
            again = control.launch("0001", KEY, 0)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][-2:], [str(control.HERE / "coding_run.py"), "0001"])
        self.assertEqual((first["run"]["phase"], first["replayed"], again["replayed"]), ("accepted", False, True))
        self.assertEqual(control.status(KEY)["run"]["phase"], "finished")

    def test_launch_refuses_a_busy_worker_and_a_private_task(self):
        with mock.patch.object(control.subprocess, "run") as run:
            with self.assertRaises(control.ControlError) as private:
                control.launch("0002", KEY, 0)
            with mock.patch.object(control, "unit_active", lambda: True), self.assertRaises(control.ControlError) as busy:
                control.launch("0001", KEY, 0)
        self.assertEqual((private.exception.code, busy.exception.code, run.call_count),
                         ("CODING_DISPATCH_INELIGIBLE", "CODING_DISPATCH_BUSY", 0))

    def test_command_line_always_answers_with_an_envelope(self):
        with mock.patch.object(sys, "argv", ["control", "launch", "0001", "not-a-request-id", "0"]), \
                mock.patch("builtins.print") as printed:
            control.main()
        self.assertEqual(json.loads(printed.call_args.args[0])["code"], "CODING_DISPATCH_INVALID_REQUEST")

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


if __name__ == "__main__":
    unittest.main()
