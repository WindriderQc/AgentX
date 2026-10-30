"""Island runner unit tests: CPU only, no Clawblox world, no model."""
import io
import json
import os
import sys
import tempfile
import threading
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
        self.assertIn('base_url="http://127.0.0.1:8443/api/llm/v1"', args)
        self.assertIn("model_auto_compact_token_limit=29491", args)
        self.assertEqual(runner.PRINCIPAL_ALIAS, "agentx-primary")

    def test_activity_requires_model_output_instead_of_session_metadata(self):
        sessions=self.root/'sessions';sessions.mkdir()
        log=sessions/'rollout.jsonl'
        log.write_text('{"type":"session_meta","payload":{}}\n')
        self.assertFalse(runner.episode.latest_activity(sessions)['modelActivity'])
        log.write_text('{"type":"response_item","payload":{"type":"message","role":"assistant"}}\n')
        self.assertTrue(runner.episode.latest_activity(sessions)['modelActivity'])

    def test_error_traffic_does_not_refresh_the_last_model_activity(self):
        import datetime as dt
        sessions = self.root / 'sessions'
        sessions.mkdir()
        old = dt.datetime.fromtimestamp(time.time() - 1000, dt.timezone.utc).isoformat()
        records = [
            {'timestamp': old, 'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant'}},
            {'timestamp': runner.now_iso(), 'type': 'event_msg', 'payload': {'type': 'error', 'message': 'upstream unavailable'}},
        ]
        log = sessions / 'rollout.jsonl'
        log.write_text('\n'.join(map(json.dumps, records)))
        self.assertGreater(runner.episode.latest_activity(sessions)['age'], 900)
        log.write_text(json.dumps(records[-1]))
        activity = runner.episode.latest_activity(sessions)
        self.assertFalse(activity['modelActivity'])
        self.assertGreater(activity['age'], 900)

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
        self.assertFalse((played / "w.sh").exists())
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

    def test_snapshot_reads_only_the_tail_and_never_follows_links_or_fifos(self):
        workspace = self.root / 'ws'
        workspace.mkdir()
        path = workspace / 'SEMANTIC_MEMORY.md'
        with path.open('wb') as stream:
            stream.truncate(64 * 1024 * 1024)
            stream.seek(-4, os.SEEK_END)
            stream.write(b'tail')
        with mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('unbounded read')):
            file = runner.memory_snapshot(workspace)['SEMANTIC_MEMORY.md']
        self.assertEqual(file['bytes'], 64 * 1024 * 1024)
        self.assertEqual(len(file['text']), runner.MAX_MEMORY_BYTES)
        self.assertTrue(file['text'].endswith('tail'))
        path.unlink()
        path.symlink_to(self.config_path)
        self.assertIsNone(runner.memory_snapshot(workspace)['SEMANTIC_MEMORY.md'])
        path.unlink()
        os.mkfifo(path)
        self.assertIsNone(runner.memory_snapshot(workspace)['SEMANTIC_MEMORY.md'])


class AgentMessages(Fixture):
    def rollout(self, records):
        sessions = self.root / "runs" / RUN / "agents" / "eko" / "sandbox-home" / ".codex" / "sessions" / "2026" / "10" / "29"
        sessions.mkdir(parents=True)
        (sessions / "rollout.jsonl").write_text("\n".join(json.dumps(r) for r in records) + "\n")

    def test_thoughts_words_and_commands_only_bounded_and_elided(self):
        item = lambda payload, at="2026-10-29T22:04:14Z": {"timestamp": at, "type": "response_item", "payload": payload}
        self.rollout([
            item({"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "system prompt"}]}),
            item({"type": "reasoning", "summary": [{"type": "summary_text", "text": "Read my memory first."}]}),
            item({"type": "function_call", "name": "exec_command",
                  "arguments": json.dumps({"cmd": "curl -H 'X-Session: s' http://world/observe " + "A" * 60})}),
            item({"type": "function_call_output", "output": "secret world dump"}),
            item({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Both mysteries solved."}]}),
            {"type": "event_msg", "payload": {"type": "token_count"}},
            "not a dict",
        ])
        messages = runner.agent_messages(self.root / "runs" / RUN, "Eko")
        self.assertEqual([m["kind"] for m in messages], ["thought", "command", "say"])
        self.assertEqual(messages[0]["text"], "Read my memory first.")
        self.assertNotIn("A" * 40, messages[1]["text"])
        self.assertTrue(messages[1]["text"].endswith("…"))
        self.assertNotIn("system prompt", json.dumps(messages))
        self.assertNotIn("secret world dump", json.dumps(messages))

    def test_limit_length_and_missing_sessions(self):
        many = [{"timestamp": "t", "type": "response_item",
                 "payload": {"type": "reasoning", "summary": [{"text": f"{i} " + "word " * 400}]}} for i in range(60)]
        self.rollout(many)
        messages = runner.agent_messages(self.root / "runs" / RUN, "Eko")
        self.assertEqual(len(messages), runner.AGENT_MESSAGES)
        self.assertTrue(messages[-1]["text"].startswith("59 "))
        self.assertTrue(all(len(m["text"]) <= runner.AGENT_TEXT for m in messages))
        self.assertEqual(runner.agent_messages(self.root / "runs" / "nothing", "Eko"), [])
        self.assertEqual(runner.agent_messages(self.root / "runs" / RUN, "../eko"), [])


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

class RelaySocketPath(Fixture):
    def test_check_and_start_refuse_a_runs_root_too_long_for_relay_sockets(self):
        deep = self.root / ("d" * 60) / "runs"
        deep.mkdir(parents=True)
        self.config_path.write_text(json.dumps({"runsRoot": str(deep), "worldsRoot": str(self.root / "worlds")}))
        code, answer = self.call("check")
        self.assertFalse(answer["data"]["ready"])
        self.assertTrue(any("relay sockets" in problem for problem in answer["data"]["problems"]))
        with mock.patch.object(runner.subprocess, "Popen") as popen:
            code, answer = self.call("start", "--run-id", RUN, "--dispatch-id", DISPATCH,
                                     "--minutes", "60", "--context-window", "32768")
        self.assertEqual((code, answer["code"]), (1, "RUNS_ROOT_TOO_LONG"))
        popen.assert_not_called()
        self.assertFalse((deep / RUN).exists())

    def test_the_planned_runner_layout_fits(self):
        self.assertIsNone(runner.relay_socket_problem({**self.config, "runsRoot": "/home/eko/island/runs"}, "Eko"))
        self.assertIsNotNone(runner.relay_socket_problem(
            {**self.config, "runsRoot": "/home/yb/codes/clawblox-runs/agentx-v1/runs"}, "Eko"))


class SafetyRegression(Fixture):
    def test_fast_supervisor_cannot_be_overwritten_by_the_starting_parent(self):
        workers, errors = [], []
        attempted, finished = threading.Event(), threading.Event()
        args = runner.parse(['start', '--run-id', RUN, '--netcheck', '--minutes', '1'])

        def supervise():
            attempted.set()
            try:
                runner.action_supervise(self.config, args)
            except Exception as error:
                errors.append(error)
            finally:
                finished.set()

        def spawn(*_args, **_kwargs):
            worker = threading.Thread(target=supervise)
            workers.append(worker)
            worker.start()
            self.assertTrue(attempted.wait(5))
            # Force the child to run before the parent's last state write. It
            # must wait on the start lock rather than finish under the parent.
            finished.wait(0.2)
            return mock.Mock(pid=12345)

        def execute(a, **_kwargs):
            runner.write_json(a.run_dir / 'receipt.json', {'outcome': 'failed', 'localStopped': True})

        try:
            with mock.patch.object(runner.subprocess, 'Popen', side_effect=spawn), \
                 mock.patch.object(runner.episode, 'execute', side_effect=execute):
                runner.action_start(self.config, args)
                for worker in workers:
                    worker.join(5)
                self.assertTrue(finished.is_set())
            self.assertEqual(errors, [])
            state = runner.read_json(self.root / 'runs' / RUN / 'state.json')
            self.assertEqual(state['phase'], 'finished')
            self.assertTrue(state['localStopped'])
            self.assertIsNone(runner.active_run(self.config))
        finally:
            for worker in workers:
                worker.join(5)

    def test_spawn_failure_releases_only_the_runner_that_never_started(self):
        with mock.patch.object(runner.subprocess, 'Popen', side_effect=OSError('synthetic spawn failure')):
            code, answer = self.call('start', '--run-id', RUN, '--netcheck')
        self.assertEqual((code, answer['code']), (1, 'RUNNER_START_FAILED'))
        state = runner.read_json(self.root / 'runs' / RUN / 'state.json')
        self.assertTrue(state['localStopped'])
        self.assertEqual(state['phase'], 'finished')
        self.assertIsNone(runner.active_run(self.config))

    def test_preparation_failure_has_no_runtime_to_release(self):
        run = self.root / 'runs' / RUN
        run.mkdir()
        runner.write_json(run / 'request.json', {'agent': 'Agent', 'memory': 'fresh'})
        runner.write_json(self.root / 'runs' / 'active.json', {'runId': RUN})
        with mock.patch.object(runner, 'seed_workspace', side_effect=ValueError('invalid memory')), \
             mock.patch.object(runner.episode, 'execute') as execute:
            runner.action_supervise(self.config, runner.parse(['supervise', '--run-id', RUN]))
        execute.assert_not_called()
        state = runner.read_json(run / 'state.json')
        self.assertEqual(state['outcome'], 'failed')
        self.assertTrue(state['localStopped'])
        self.assertIsNone(runner.active_run(self.config))

    def test_memory_carries_only_four_regular_files_and_refuses_symlinks(self):
        source=self.root/'source';store=runner.memory_store(self.config,'Agent')
        runner.seed_workspace(source,runner.templates_dir(self.config),store,'fresh')
        (source/'tool.sh').write_text('not persistent memory')
        (source/'auth.json').write_text('synthetic secret')
        (source/'EPISODIC_MEMORY.jsonl').write_text('{"summary":"first episode"}\n')
        runner.save_memory(source,store)
        second=self.root/'second'
        runner.seed_workspace(second,runner.templates_dir(self.config),store,'continue')
        self.assertEqual({p.name for p in second.iterdir()},set(runner.MEMORY))
        self.assertIn('first episode',(second/'EPISODIC_MEMORY.jsonl').read_text())
        (source/'SEMANTIC_MEMORY.md').unlink()
        (source/'SEMANTIC_MEMORY.md').symlink_to(source/'auth.json')
        with self.assertRaises(ValueError):runner.save_memory(source,store)
        self.assertNotIn('synthetic secret',(store/'SEMANTIC_MEMORY.md').read_text())

    def test_failed_pgrep_is_not_an_empty_process_list(self):
        result=mock.Mock(returncode=2,stdout='',stderr='synthetic error')
        with mock.patch.object(runner.subprocess,'run',return_value=result):
            with self.assertRaises(runner.RunnerError):runner.leftover_processes(self.root)

    def test_status_marks_process_observation_unavailable(self):
        run=self.root/'runs'/RUN;run.mkdir()
        runner.write_json(run/'request.json',{'runId':RUN,'dispatchId':DISPATCH})
        runner.write_json(run/'state.json',{'phase':'finished','outcome':'completed','localStopped':True})
        with mock.patch.object(runner,'leftover_processes',side_effect=runner.RunnerError('PROCESS_OBSERVATION','synthetic')):
            data=runner.describe(self.config,RUN)
        self.assertFalse(data['processObservationOk']);self.assertIsNone(data['leftover'])


class StopAction(Fixture):
    def test_stop_signals_the_live_supervisor(self):
        """`stop` sends SIGTERM to the run's supervisor (it raised NameError since the hourly reset)."""
        import signal
        import subprocess
        run = self.root / "runs" / RUN
        run.mkdir()
        # A stand-in whose command line looks like the supervisor of this run.
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "supervise", RUN])
        try:
            (run / "state.json").write_text(json.dumps({"runId": RUN, "pid": child.pid, "phase": "running"}))
            deadline = time.monotonic() + 5
            while not runner.pid_alive(child.pid, RUN) and time.monotonic() < deadline:
                time.sleep(0.05)
            code, out = self.call("stop", "--run-id", RUN)
            self.assertEqual(code, 0, out)
            self.assertEqual(out["data"], {"runId": RUN, "signalled": True})
            self.assertEqual(child.wait(timeout=5), -signal.SIGTERM)
            code, out = self.call("stop", "--run-id", RUN)
            self.assertEqual(out["data"]["signalled"], False, "a finished supervisor is not signalled again")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()


if __name__ == "__main__":
    unittest.main()
