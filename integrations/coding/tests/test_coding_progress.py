import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("coding_progress", Path(__file__).resolve().parents[1] / "coding_progress.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
KEY = "11111111-2222-4333-8444-555555555555"


class ProgressTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        module.git(self.workspace, "init", "--quiet")
        (self.workspace / "README.md").write_text("Source A")
        module.git(self.workspace, "add", "README.md")
        self.clock = [0]
        self.heartbeats = []
        self.progress = module.Progress("0001", KEY, receipts=self.root / "receipts", now=lambda: self.clock[0],
                                        heartbeat=lambda: self.heartbeats.append(self.clock[0]))
        self.progress.phase = "running"
        self.progress.baseline(self.root, self.workspace)

    def test_model_liveness_does_not_extend_budget_without_useful_progress(self):
        self.clock[0] = 7199
        self.progress.event({"type": "assistant/chunk", "data": {"chunk": "Synthetic private model text"}})
        self.clock[0] = 7200
        self.assertEqual(self.progress.tick(), "soft_budget_no_progress")
        self.assertEqual(self.progress.last_useful, 0)

    def test_new_source_extends_soft_budget_but_cannot_cross_hard_ceiling(self):
        self.clock[0] = 7100
        self.progress.set_stage("model_wait")
        (self.workspace / "README.md").write_text("Source B")
        self.progress.tick(self.root, self.workspace)
        self.clock[0] = 7201
        self.assertIsNone(self.progress.tick())
        self.assertEqual(self.progress.extensions, 1)
        self.assertGreater(self.progress.soft_deadline, 7201)
        self.clock[0] = 14400
        self.assertEqual(self.progress.tick(), "hard_budget")

    def test_cache_churn_touches_and_repeated_source_states_are_not_progress(self):
        for name in [".npmcache/cache", ".lab/probe", "nested/session.jsonl"]:
            path = self.workspace / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("Private fixture")
        self.clock[0] = 10
        os.utime(self.workspace / "README.md", None)
        self.progress.tick(self.root, self.workspace)
        self.assertEqual(self.progress.last_useful, 0)
        (self.workspace / "README.md").write_text("Source B")
        self.progress.tick(self.root, self.workspace)
        self.clock[0] = 20
        (self.workspace / "README.md").write_text("Source A")
        self.progress.tick(self.root, self.workspace)
        self.assertEqual(self.progress.last_useful, 10)

    def call(self, call_id="1", command="node scripts/run-jest.js tests/unit/fixture.test.js"):
        self.progress.event({"type": "tool/call", "data": {"callId": call_id, "name": "bash",
                            "arguments": json.dumps({"command": command})}})

    def result(self, call_id="1", content="3 passed", error=False):
        self.progress.event({"type": "tool/result", "data": {"message": {
            "source": {"callId": call_id}, "content": [{"type": "tool-result", "isError": error,
            "content": [{"type": "text", "text": content}]}]}}})

    def test_installed_dsh_json_arguments_and_nested_test_results_are_correlated(self):
        self.clock[0] = 10
        self.call()
        self.assertEqual((self.progress.stage, self.progress.current_test), ("test", "jest"))
        self.result("another-call", "irrelevant")
        self.assertEqual(self.progress.stage, "test")
        self.result(content="Synthetic private fixture\n[exit code: 1]")
        self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "failed"})
        self.assertEqual(self.progress.last_useful, 10)
        self.clock[0] = 20
        self.call("2")
        self.result("2", "Same failure, different timing\n[exit code: 1]")
        self.assertEqual(self.progress.last_useful, 10)
        self.progress.write()
        self.assertNotIn("private", self.progress.path.read_text())
        self.assertNotIn("command", self.progress.path.read_text())

    def test_incomplete_session_record_is_retried_and_old_history_is_not_replayed(self):
        log = self.root / ".dsh/progress-sessions/project/session/session.jsonl"
        log.parent.mkdir(parents=True)
        log.write_text(json.dumps({"type": "tool/call", "data": {"name": "bash", "callId": "old", "arguments": "{}"}}) + "\n")
        self.progress.baseline(self.root, self.workspace)
        event = json.dumps({"type": "assistant/chunk", "data": {"chunk": "Private fixture"}})
        with log.open("a") as stream:
            stream.write(event[:20])
        self.progress.scan(self.root, self.workspace)
        self.assertEqual(self.progress.stage, "preparing")
        with log.open("a") as stream:
            stream.write(event[20:] + "\n")
        self.progress.scan(self.root, self.workspace)
        self.assertEqual(self.progress.stage, "model_generation")

    def test_actual_relay_requests_have_a_bound_and_heartbeat_is_independent(self):
        for _ in range(128):
            self.progress.model_events.put("model_request")
        self.assertEqual(self.progress.tick(), "model_call_limit")
        self.assertEqual(self.progress.model_calls, 128)
        self.assertEqual(self.heartbeats, [0])
        self.assertIsNone(self.progress.progress_at)

    def test_stage_limits_allow_a_long_test_and_stop_a_stalled_tool(self):
        self.call()
        self.clock[0] = 1800
        self.assertIsNone(self.progress.tick())
        self.clock[0] = 2400
        self.assertEqual(self.progress.tick(), "test_inactive")

    def test_projection_rejects_foreign_identity_and_removes_unknown_nested_data(self):
        self.progress.finish("blocked", "worker_exit", "a" * 40)
        value = json.loads(self.progress.path.read_text())
        value.update(command="private-fixture", checkpoint="/private/fixture", rawOutput="private-fixture")
        value["lastTest"] = {"name": "jest", "outcome": "passed", "output": "private-fixture"}
        safe = module.safe_progress(value, KEY, "0001")
        self.assertNotIn("private-fixture", json.dumps(safe))
        self.assertIsNone(safe["checkpoint"])
        self.assertIsNone(module.safe_progress(value, KEY, "0002"))
        self.assertEqual(self.progress.path.stat().st_mode & 0o777, 0o600)
        value.update(stopReason={}, currentTest=[])
        value["lastTest"] = {"name": [], "outcome": {}}
        self.assertIsNone(module.safe_progress(value, KEY, "0001")["lastTest"])
        value["stage"] = []
        self.assertIsNone(module.safe_progress(value, KEY, "0001"))

    def test_echoing_test_names_is_not_test_evidence(self):
        self.assertIsNone(module.test_kind("echo pytest"))
        self.assertEqual(module.test_kind("cd core && node scripts/run-jest.js fixture.test.js"), "jest")


if __name__ == "__main__":
    unittest.main()
