"""Island runner unit tests: CPU only, no Clawblox world, no model."""
import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import island_runner as runner  # noqa: E402

RUN = "00000000-0000-4000-8000-0000000000aa"
DISPATCH = "00000000-0000-4000-8000-0000000000bb"


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "runs").mkdir()
        (self.root / "worlds" / "mesa-island").mkdir(parents=True)
        self.config_path = self.root / "runner.json"
        self.config_path.write_text(json.dumps({"runsRoot": str(self.root / "runs"),
                                                "worldsRoot": str(self.root / "worlds")}))
        self.config = runner.load_config(self.config_path)

    def tearDown(self):
        for path in self.root.rglob("SOUL.md"):
            path.chmod(0o644)
        self.tmp.cleanup()

    def call(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = runner.main([*argv, "--config", str(self.config_path)])
        return code, json.loads(out.getvalue())


class PureHelpers(Fixture):
    def test_prompt_placeholders_are_filled(self):
        text = runner.render_system_prompt("I am ${WORLD_AGENT_NAME} in ${WORKSPACE_DIR}.", "Eko")
        self.assertEqual(text, "I am Eko in /workspace.")

    def test_provider_uses_the_gateway_and_never_a_model_name(self):
        args = " ".join(runner.codex_provider_args("gateway.example", 8443, 32768))
        self.assertIn('base_url="https://gateway.example:8443/api/llm/v1"', args)
        self.assertIn("model_auto_compact_token_limit=29491", args)
        self.assertEqual(runner.PRINCIPAL_ALIAS, "agentx-primary")

    def test_stall_reason_reads_the_newest_rollout(self):
        sessions = self.root / "sessions"
        sessions.mkdir()
        self.assertIsNone(runner.stall_reason(sessions, 90, 900))
        rollout = sessions / "a.jsonl"
        rollout.write_text(json.dumps({"payload": {"type": "task_complete",
                                                   "error": {"message": "max_output_tokens"}}}) + "\n")
        now = rollout.stat().st_mtime
        self.assertIsNone(runner.stall_reason(sessions, 90, 900, now=now + 10))
        self.assertEqual(runner.stall_reason(sessions, 90, 900, now=now + 100),
                         "turn ended without continuing (max_output_tokens)")
        rollout.write_text(json.dumps({"payload": {"type": "user_message"}}) + "\n")
        now = rollout.stat().st_mtime
        self.assertIsNone(runner.stall_reason(sessions, 90, 900, now=now + 100))
        self.assertEqual(runner.stall_reason(sessions, 90, 900, now=now + 1000), "no activity for 1000 s")

    def test_spectator_link_is_read_from_the_world_log(self):
        log = self.root / "world.log"
        log.write_text("boot\nSpectator frontend: http://localhost:18080/?spectator_token=abc\n")
        self.assertEqual(runner.spectator_path(log), {"port": 18080, "path": "/?spectator_token=abc"})
        self.assertIsNone(runner.spectator_path(self.root / "missing.log"))


class Memory(Fixture):
    def test_fresh_seeds_from_templates_and_continue_from_the_store(self):
        templates = runner.templates_dir(self.config)
        store = runner.memory_store(self.config, "Eko")
        fresh = self.root / "w1"
        self.assertEqual(runner.seed_workspace(fresh, templates, store, "continue"), "template")
        self.assertTrue((fresh / "EPISODIC_MEMORY.jsonl").exists())
        self.assertEqual(oct((fresh / "SOUL.md").stat().st_mode & 0o777), "0o444")
        (fresh / "EPISODIC_MEMORY.jsonl").write_text('{"summary": "built a tower"}\n')
        (fresh / "w.sh").write_text("echo tool\n")
        self.assertTrue(runner.save_memory(fresh, store)["saved"])
        played = self.root / "w2"
        self.assertEqual(runner.seed_workspace(played, templates, store, "continue"), "previous-run")
        self.assertIn("built a tower", (played / "EPISODIC_MEMORY.jsonl").read_text())
        self.assertTrue((played / "w.sh").exists())
        other = self.root / "w3"
        self.assertEqual(runner.seed_workspace(other, templates, store, "fresh"), "template")
        self.assertEqual((other / "EPISODIC_MEMORY.jsonl").read_text(), "")

    def test_snapshot_is_bounded(self):
        workspace = self.root / "ws"
        workspace.mkdir()
        (workspace / "SEMANTIC_MEMORY.md").write_text("x" * (runner.MAX_MEMORY_BYTES + 10))
        files = runner.memory_snapshot(workspace)
        self.assertTrue(files["SEMANTIC_MEMORY.md"]["truncated"])
        self.assertEqual(len(files["SEMANTIC_MEMORY.md"]["text"]), runner.MAX_MEMORY_BYTES)
        self.assertIsNone(files["SOUL.md"])


class Actions(Fixture):
    def start(self, **extra):
        argv = ["start", "--run-id", RUN, "--dispatch-id", DISPATCH, "--minutes", "60", "--context-window", "32768"]
        for key, value in extra.items():
            argv += [f"--{key.replace('_', '-')}", str(value)]
        fake = mock.Mock(pid=4242)
        with mock.patch.object(runner.subprocess, "Popen", return_value=fake) as popen:
            result = self.call(*argv)
        return result, popen

    def test_start_creates_the_run_once_and_never_again(self):
        (code, answer), popen = self.start()
        self.assertEqual(code, 0, answer)
        self.assertEqual(answer["data"]["phase"], "starting")
        self.assertEqual(popen.call_args.args[0][2:5], ["supervise", "--run-id", RUN])
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        request = json.loads((self.root / "runs" / RUN / "request.json").read_text())
        self.assertEqual(request["dispatchId"], DISPATCH)
        with mock.patch.object(runner, "active_run", return_value=None):
            (code, answer), popen = self.start()
        self.assertEqual((code, answer["code"]), (1, "RUN_EXISTS"))
        popen.assert_not_called()

    def test_start_refuses_a_busy_runner_and_bad_input_before_any_file(self):
        with mock.patch.object(runner, "active_run", return_value="00000000-0000-4000-8000-0000000000cc"):
            (code, answer), popen = self.start()
        self.assertEqual(answer["code"], "RUNNER_BUSY")
        (code, answer), popen = self.start(world="not-installed")
        self.assertEqual(answer["code"], "INVALID")
        code, answer = self.call("start", "--run-id", RUN, "--dispatch-id", DISPATCH, "--minutes", "60")
        self.assertEqual(answer["code"], "INVALID")  # no context window
        code, answer = self.call("start", "--run-id", "not-a-uuid", "--dispatch-id", DISPATCH)
        self.assertEqual(answer["code"], "RUN_ID")
        self.assertFalse((self.root / "runs" / RUN).exists())

    def test_a_dead_supervisor_reads_as_interrupted_and_is_terminal(self):
        self.start()
        with mock.patch.object(runner, "leftover_processes", return_value=[]):
            code, answer = self.call("status", "--run-id", RUN)
        self.assertEqual(code, 0)
        self.assertEqual(answer["data"]["phase"], "interrupted")
        self.assertTrue(answer["data"]["terminal"])
        self.assertEqual(answer["data"]["model"], "agentx-primary")

    def test_finished_state_reports_resumes_recording_and_memory(self):
        self.start()
        run = self.root / "runs" / RUN
        state = json.loads((run / "state.json").read_text())
        state.update(phase="finished", outcome="completed", endedAt="2026-10-29T10:00:00-04:00",
                     events=[{"event": "resumed", "reason": "memory-reminder"}, {"event": "started"}])
        (run / "state.json").write_text(json.dumps(state))
        (run / "recordings").mkdir()
        (run / "recordings" / "20261029_100000.clawrec").write_text("")
        (run / "memory-after").mkdir()
        (run / "memory-after" / "SEMANTIC_MEMORY.md").write_text("[verified] blocks stay put")
        with mock.patch.object(runner, "leftover_processes", return_value=[]):
            code, answer = self.call("status", "--run-id", RUN)
        data = answer["data"]
        self.assertEqual((data["phase"], data["outcome"], data["resumeCount"]), ("finished", "completed", 1))
        self.assertEqual(data["recording"], f"{RUN}/recordings/20261029_100000.clawrec")
        code, answer = self.call("memory", "--run-id", RUN)
        self.assertTrue(answer["data"]["final"])
        self.assertIn("blocks stay put", answer["data"]["files"]["SEMANTIC_MEMORY.md"]["text"])

    def test_unknown_run_and_missing_config_are_typed_errors(self):
        code, answer = self.call("status", "--run-id", RUN)
        self.assertEqual(answer["code"], "RUN_NOT_FOUND")
        out = io.StringIO()
        with redirect_stdout(out):
            runner.main(["check", "--config", str(self.root / "absent.json")])
        self.assertEqual(json.loads(out.getvalue())["code"], "RUNNER_CONFIG")


if __name__ == "__main__":
    unittest.main()
