"""DSH and pi on the island: capability wire, runner, netcheck and turn loop. CPU only, no model."""
import http.client
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
import threading

KIT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT))
import harness_loop  # noqa: E402
import island_runner as runner  # noqa: E402
import run_island  # noqa: E402
from llm_proxy import LLMProxy  # noqa: E402
from run_state import MEMORY, REQUIRED_CHECKS, netcheck_result  # noqa: E402

RUN = "00000000-0000-4000-8000-0000000000aa"
DISPATCH = "00000000-0000-4000-8000-0000000000bb"


class ChatWire(unittest.TestCase):
    """A dsh/pi run opens Chat Completions and nothing else; Codex keeps Responses only."""

    def setUp(self):
        self.calls = []
        calls = self.calls

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_): pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                calls.append((self.path, dict(self.headers), json.loads(body)))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b'data: {"choices":[]}\n\ndata: [DONE]\n\n')

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.upstream = f"http://127.0.0.1:{self.server.server_port}/api/llm/v1"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def call(self, proxy, method, path, body=None, auth=True):
        conn = http.client.HTTPConnection("127.0.0.1", proxy.port, timeout=3)
        headers = {"Authorization": "Bearer " + proxy.capability} if auth else {}
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        result = response.status, response.read()
        conn.close()
        return result

    def test_chat_wire_forwards_only_the_alias_to_chat_completions(self):
        with LLMProxy(self.upstream, "synthetic-upstream-secret", wire="chat") as proxy:
            body = json.dumps({"model": "agentx-primary", "messages": [{"role": "user", "content": "hi"}], "stream": True})
            status, data = self.call(proxy, "POST", "/api/llm/v1/chat/completions", body)
            self.assertEqual(status, 200)
            self.assertIn(b"[DONE]", data)
            self.assertEqual([call[0] for call in self.calls], ["/api/llm/v1/chat/completions"])
            self.assertEqual(self.calls[0][1]["Authorization"], "Bearer synthetic-upstream-secret")
            self.assertNotIn(proxy.capability, json.dumps(self.calls))
            for path, payload, expected in [
                ("/api/llm/v1/responses", {"model": "agentx-primary", "input": "x"}, 403),
                ("/api/llm/v1/chat/completions", {"model": "other", "messages": []}, 403),
                ("/api/llm/v1/chat/completions?stream=1", {"model": "agentx-primary"}, 403),
                ("/api/llm/v1/%63hat/completions", {"model": "agentx-primary"}, 403),
                ("/api/llm/v1/completions", {"model": "agentx-primary"}, 403),
                ("/api/llm/v1/embeddings", {"model": "agentx-primary"}, 403),
            ]:
                with self.subTest(path=path, payload=payload):
                    self.assertEqual(self.call(proxy, "POST", path, json.dumps(payload))[0], expected)
            self.assertEqual(self.call(proxy, "POST", "/api/llm/v1/chat/completions", body, auth=False)[0], 401)
            self.assertEqual(self.call(proxy, "GET", "/api/llm/v1/models")[0], 200)
            for path in ["/health", "/api/cluster/schedule/work-queue", "/api/nerve-center/agent-runtime-config/export"]:
                self.assertEqual(self.call(proxy, "GET", path)[0], 403)
        self.assertEqual(len(self.calls), 1)

    def test_default_wire_keeps_codex_on_responses_and_refuses_chat(self):
        with LLMProxy(self.upstream, "synthetic-upstream-secret") as proxy:
            body = json.dumps({"model": "agentx-primary", "messages": []})
            self.assertEqual(self.call(proxy, "POST", "/api/llm/v1/chat/completions", body)[0], 403)
        self.assertEqual(self.calls, [])

    def test_netcheck_chat_wire_has_no_upstream_and_unknown_wire_refuses(self):
        with LLMProxy(None, wire="chat") as dry:
            body = json.dumps({"model": "agentx-primary", "messages": []})
            self.assertEqual(self.call(dry, "POST", "/api/llm/v1/chat/completions", body)[0], 503)
            self.assertEqual(self.call(dry, "POST", "/api/llm/v1/responses", body)[0], 403)
        with self.assertRaises(ValueError):
            LLMProxy(None, wire="completions")
        self.assertEqual(self.calls, [])


class HarnessEpisode(unittest.TestCase):
    """run_island with a fake Clawblox: the adapter kind, env, version gate and rollout directory."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.templates = self.root / "templates"
        self.templates.mkdir()
        for name in MEMORY:
            (self.templates / name).write_text("" if name.endswith(".jsonl") else "synthetic memory")
        (self.templates / "SYSTEM_PROMPT.md").write_text("Island ${WORLD_AGENT_NAME}")
        self.settings, self.envs, self.stops = {}, [], []
        test = self

        class World:
            def __init__(self, **kw): pass
            def start(self, **kw): pass
            def connect(self, **kw): pass
            def stop(self, **kw): test.stops.append("world")

        class Agent:
            def __init__(self, **kw):
                self.dir = kw["dir"]
                test.settings = kw

            def start(self, **kw):
                test.envs.append(kw["env"])
                rollouts = self.dir / "sandbox-home" / ".agentx-loop" / "sessions"
                rollouts.mkdir(parents=True, exist_ok=True)
                (rollouts / "rollout-s1.jsonl").write_text(
                    '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}\n')
                checks = [{"name": n, "passed": True} for n in REQUIRED_CHECKS | {"harness-config"}]
                (self.dir / "workspace" / "netcheck.json").write_text(json.dumps(
                    {"schema": "agentx.island-netcheck/v1", "harness": kw["env"].get("AGENTX_NETCHECK_HARNESS"), "checks": checks}))
                return SimpleNamespace(tmux_pane_id="%1")

            def stop(self, **kw): test.stops.append("agent")

        self.runtime = SimpleNamespace(agentx_isolation_version=lambda: 2, World=World, Agent=Agent)

    def tearDown(self):
        self.temp.cleanup()

    def args(self, harness, *extra):
        return run_island.parser().parse_args(["--run-dir", str(self.root / f"run-{harness}"), "--templates-dir", str(self.templates),
                                               "--world-dir", str(self.root / "world"), "--netcheck", "--minutes", "0.05",
                                               "--memory-warning-minutes", "0", "--harness", harness, *extra])

    def run_episode(self, a):
        class Clock:
            value = 0
            def monotonic(self): return self.value
            def sleep(self, seconds): self.value += seconds
        code = run_island.execute(a, self.runtime, clock=Clock(), alive=lambda _: True)
        return code, json.loads((a.run_dir / "receipt.json").read_text())

    def test_pi_and_dsh_run_their_adapter_on_the_chat_wire_with_a_generic_capability(self):
        for harness in ("pi", "dsh"):
            with self.subTest(harness=harness):
                code, receipt = self.run_episode(self.args(harness))
                self.assertEqual(code, 0, receipt)
                self.assertEqual(receipt["harness"], harness)
                self.assertEqual(self.settings["agent"], harness)
                self.assertEqual(self.settings["model"], "agentx-primary")
                self.assertEqual(Path(self.settings["binary"]).name, "netcheck_probe.js")
                self.assertEqual(self.settings["extra_args"], [])
                env = self.envs[-1]
                self.assertNotIn("AGENTX_LLM_CODEX_TOKEN", env)
                port = env["AGENTX_NETCHECK_PORT"]
                self.assertEqual(env["AGENTX_LLM_BASE_URL"], f"http://127.0.0.1:{port}/api/llm/v1")
                self.assertTrue(env["CLAWBLOX_NET_ALLOW"].startswith("127.0.0.1:") and env["CLAWBLOX_NET_ALLOW"].endswith("@" + port))
                self.assertEqual(env["AGENTX_NETCHECK_INFERENCE"], "/api/llm/v1/chat/completions")
                self.assertEqual(env["AGENTX_NETCHECK_OTHER_INFERENCE"], "/api/llm/v1/responses")
                self.assertTrue(env["AGENTX_LLM_TOKEN"])
                self.assertNotIn("AGENTX_LLM_CONTEXT_WINDOW", env)

    def test_codex_keeps_responses_and_its_token_name(self):
        env = run_island.harness_env("codex", SimpleNamespace(port=41000, capability="cap"), 8443, 65536)
        self.assertEqual(env, {"CLAWBLOX_NET_ALLOW": "127.0.0.1:41000@8443", "AGENTX_LLM_CODEX_TOKEN": "cap"})
        env = run_island.harness_env("pi", SimpleNamespace(port=41000, capability="cap"), 8443, 65536, 8192)
        self.assertEqual(env["AGENTX_LLM_CONTEXT_WINDOW"], "65536")
        self.assertEqual(env["AGENTX_LLM_MAX_OUTPUT_TOKENS"], "8192")
        self.assertEqual(run_island.HARNESSES["codex"][0], "responses")

    def test_an_adapter_without_dsh_or_pi_is_refused_before_any_world(self):
        self.runtime.agentx_isolation_version = lambda: 1
        code, receipt = self.run_episode(self.args("pi"))
        self.assertEqual(code, 1)
        self.assertIn("v2 required for pi", receipt["error"])
        self.assertEqual(self.stops, [])

    def test_real_runs_need_the_harness_binary(self):
        token = self.root / "token"
        token.write_text("synthetic")
        base = ["--run-dir", str(self.root / "r"), "--templates-dir", str(self.templates), "--world-dir", str(self.root / "w"),
                "--context-window", "65536", "--token-file", str(token), "--gateway-base-url", "https://core.invalid/api/llm/v1"]
        with redirect_stdout(io.StringIO()), mock.patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit):
            run_island.main([*base, "--harness", "pi", "--codex", "/usr/bin/true"])


class HarnessNetcheck(unittest.TestCase):
    def write(self, workspace, harness, names):
        (workspace / "netcheck.json").write_text(json.dumps({"schema": "agentx.island-netcheck/v1", "harness": harness,
                                                             "checks": [{"name": n, "passed": True} for n in names]}))

    def test_dsh_and_pi_also_need_the_generated_config_check_and_the_right_harness(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp)
            self.write(workspace, "pi", REQUIRED_CHECKS)
            with self.assertRaises(RuntimeError): netcheck_result(workspace, "pi")
            self.write(workspace, "pi", REQUIRED_CHECKS | {"harness-config"})
            self.assertEqual(netcheck_result(workspace, "pi")["harness"], "pi")
            with self.assertRaises(RuntimeError): netcheck_result(workspace, "dsh")
            self.write(workspace, "codex", REQUIRED_CHECKS - {"inference-route-exclusive"})
            with self.assertRaises(RuntimeError): netcheck_result(workspace, "codex")


class RunnerHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "runs").mkdir()
        (self.root / "worlds" / "mesa-island").mkdir(parents=True)
        pi = self.root / "pi" / "node_modules" / ".bin" / "pi"
        pi.parent.mkdir(parents=True)
        pi.write_text("")
        self.config_path = self.root / "runner.json"
        self.config_path.write_text(json.dumps({"runsRoot": str(self.root / "runs"), "worldsRoot": str(self.root / "worlds"),
                                                "harnesses": {"pi": str(pi)}}))

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.object(runner.subprocess, "Popen", return_value=mock.Mock(pid=4242)):
            code = runner.main([*argv, "--config", str(self.config_path)])
        return code, json.loads(out.getvalue())

    def test_start_records_the_harness_and_refuses_an_uninstalled_or_unknown_one(self):
        base = ["start", "--run-id", RUN, "--dispatch-id", DISPATCH, "--minutes", "60", "--context-window", "65536"]
        code, answer = self.call(*base, "--harness", "dsh")
        self.assertEqual((code, answer["code"]), (1, "INVALID"))
        code, answer = self.call(*base, "--harness", "claude")
        self.assertEqual((code, answer["code"]), (1, "INVALID"))
        self.assertFalse((self.root / "runs" / RUN).exists())
        code, answer = self.call(*base, "--harness", "pi")
        self.assertEqual(code, 0, answer)
        self.assertEqual(answer["data"]["harness"], "pi")
        request = json.loads((self.root / "runs" / RUN / "request.json").read_text())
        self.assertEqual(request["harness"], "pi")

    def test_check_names_the_playable_harnesses_from_binary_and_adapter_version(self):
        config = runner.load_config(self.config_path)
        self.assertEqual(runner.harness_problems(config, "pi", 2), [])
        self.assertEqual(runner.harness_problems(config, "pi", 1), ["Clawblox isolation patch v2 required for pi"])
        self.assertEqual(runner.harness_problems(config, "dsh", 2), ["dsh binary missing"])
        self.assertEqual(runner.harness_problems(config, "codex", 2), ["codex missing"])
        fake = SimpleNamespace(agentx_isolation_version=lambda: 2)
        with mock.patch.dict(sys.modules, {"clawblox": fake}):
            code, answer = self.call("check", "--harness", "pi")
        self.assertEqual(answer["data"]["harnesses"], ["pi"])
        self.assertEqual(answer["data"]["harness"], "pi")
        self.assertNotIn("pi binary missing", answer["data"]["problems"])


FAKE_HARNESS = r'''#!/usr/bin/env python3
import json, os, signal, sys
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
kind, log = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
prompt = sys.stdin.read() if kind == "dsh" else args[args.index("--") + 1]
session = args[args.index("--session-id") + 1] if "--session-id" in args else None
with open(log, "a") as out:
    out.write(json.dumps({"prompt": prompt, "session": session, "token": os.environ.get("AGENTX_LLM_TOKEN")}) + "\n")
calls = sum(1 for _ in open(log))
if os.environ.get("FAKE_FAIL_FIRST") and calls == 1:
    sys.exit(3)
say = lambda value: print(json.dumps(value), flush=True)
if kind == "pi":
    say({"type": "session", "version": 3, "id": session})
    say({"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}})
    say({"type": "message_end", "message": {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "plan"}, {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "ls"}}],
        "usage": {"input": 100, "output": 7, "cacheRead": 4}, "stopReason": "toolUse"}})
    say({"type": "tool_execution_end", "toolCallId": "c1", "toolName": "bash", "result": {"content": [{"type": "text", "text": "SOUL.md"}]}})
    say({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "I will build a tower."}],
        "usage": {"input": 120, "output": 9}, "stopReason": "stop"}})
    say({"type": "agent_settled", "aborted": False})
else:
    say({"type": "session", "sessionId": session or "session-fixture-1"})
    say({"type": "tool_call", "callId": "c1", "tool": "bash", "input": {"command": "ls"}})
    say({"type": "tool_result", "callId": "c1", "status": "ok", "result": "SOUL.md"})
    say({"type": "status", "phase": "step_end", "usage": {"inputTokens": 100, "outputTokens": 7}})
    say({"type": "text", "text": "I will build a tower."})
    say({"type": "status", "phase": "turn_end", "turn": 1, "reason": {"kind": "completed"}})
'''


class TurnLoop(unittest.TestCase):
    """The in-sandbox driver: one session, turn after turn, Codex-shaped rollouts, honest errors."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fake = self.root / "fake_harness.py"
        self.fake.write_text(FAKE_HARNESS)
        self.log = self.root / "calls.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def loop(self, kind, *extra, turns=2, env=None):
        argv = [sys.executable, str(KIT / "harness_loop.py"), "--kind", kind, "--state-dir", str(self.root / "state"),
                "--prompt", "Begin.", "--continue-prompt", "Keep going", *extra,
                "--", sys.executable, str(self.fake), kind, str(self.log)]
        child = subprocess.Popen(argv, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                 env={**os.environ, "AGENTX_LLM_TOKEN": "ephemeral", **(env or {})})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and (not self.log.exists() or sum(1 for _ in open(self.log)) < turns):
            if child.poll() is not None:
                break
            time.sleep(0.05)
        child.send_signal(signal.SIGTERM)
        out, err = child.communicate(timeout=15)
        return child.returncode, out, err, [json.loads(line) for line in open(self.log)] if self.log.exists() else []

    def rollout(self, session):
        path = self.root / "state" / "sessions" / f"rollout-{session}.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()]

    def test_pi_keeps_one_new_session_and_continues_it(self):
        code, _, err, calls = self.loop("pi")
        self.assertEqual(code, 0, err)
        session = (self.root / "state" / "session_id").read_text().strip()
        self.assertRegex(session, r"^[0-9a-f-]{36}$")
        self.assertEqual([c["prompt"] for c in calls[:2]], ["Begin.", "Keep going"])
        self.assertEqual({c["session"] for c in calls}, {session})
        self.assertEqual({c["token"] for c in calls}, {"ephemeral"})
        lines = self.rollout(session)
        self.assertEqual(lines[0]["type"], "session_meta")
        payloads = [line["payload"] for line in lines]
        kinds = [p.get("type") for p in payloads]
        for expected in ("reasoning", "function_call", "function_call_output", "token_count", "task_complete"):
            self.assertIn(expected, kinds)
        self.assertIn({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "I will build a tower."}]}, payloads)
        call = next(p for p in payloads if p.get("type") == "function_call")
        self.assertEqual((call["name"], json.loads(call["arguments"])), ("bash", {"command": "ls"}))
        usage = next(p for p in payloads if p.get("type") == "token_count")["info"]["last_token_usage"]
        self.assertEqual((usage["input_tokens"], usage["output_tokens"], usage["cached_input_tokens"]), (100, 7, 4))
        self.assertTrue(all("timestamp" in line for line in lines))
        self.assertNotIn("ephemeral", json.dumps(lines))

    def test_dsh_learns_its_session_reads_the_prompt_on_stdin_and_resumes_it(self):
        code, _, err, calls = self.loop("dsh")
        self.assertEqual(code, 0, err)
        self.assertEqual(calls[0], {"prompt": "Begin.", "session": None, "token": "ephemeral"})
        self.assertEqual(calls[1]["session"], "session-fixture-1")
        self.assertEqual(calls[1]["prompt"], "Keep going")
        self.assertEqual((self.root / "state" / "session_id").read_text().strip(), "session-fixture-1")
        kinds = [line["payload"].get("type") for line in self.rollout("session-fixture-1")]
        self.assertGreaterEqual(kinds.count("task_complete"), 2)
        self.log.unlink()
        code, _, err, calls = self.loop("dsh", "--resume", "--prompt", "Update your memory files now.", turns=1)
        self.assertEqual(code, 0, err)
        self.assertEqual(calls[0]["session"], "session-fixture-1")
        self.assertEqual(calls[0]["prompt"], "Update your memory files now.")

    def test_a_new_start_is_a_new_session(self):
        self.loop("pi", turns=1)
        first = (self.root / "state" / "session_id").read_text().strip()
        self.loop("pi", turns=3)
        self.assertNotEqual((self.root / "state" / "session_id").read_text().strip(), first)

    def test_resume_without_a_session_refuses(self):
        result = subprocess.run([sys.executable, str(KIT / "harness_loop.py"), "--kind", "pi", "--state-dir", str(self.root / "s"),
                                 "--prompt", "x", "--continue-prompt", "y", "--resume", "--", "true"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("no session to resume", result.stderr)

    def test_a_failed_turn_is_recorded_and_retried_after_a_pause(self):
        started = time.monotonic()
        code, _, err, calls = self.loop("pi", env={"FAKE_FAIL_FIRST": "1"})
        self.assertEqual(code, 0, err)
        self.assertGreaterEqual(time.monotonic() - started, harness_loop.BACKOFF_FIRST - 0.5)
        self.assertIn("retrying in", err)
        session = (self.root / "state" / "session_id").read_text().strip()
        payloads = [line["payload"] for line in self.rollout(session)]
        self.assertIn({"type": "error", "message": "pi exited with status 3"}, payloads)
        self.assertEqual([c["prompt"] for c in calls[:2]], ["Begin.", "Keep going"])


class Metrics(unittest.TestCase):
    """The comparison reads the same numbers from Codex rollouts and the turn loop's rollouts."""

    def write_run(self, root, harness, rollout_dir, lines):
        run = root / harness
        sessions = run / "agents" / "eko" / "sandbox-home" / rollout_dir
        sessions.mkdir(parents=True)
        (sessions / "rollout-x.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines))
        (run / "request.json").write_text(json.dumps({"harness": harness, "memory": "fresh", "agent": "Eko", "minutes": 60}))
        (run / "state.json").write_text(json.dumps({"outcome": "completed", "events": [{"event": "resumed", "reason": "idle"}]}))
        return run

    def test_same_metrics_for_both_rollout_layouts(self):
        import run_metrics
        place = '{"type":"Place","data":{}}'
        lines = [
            {"timestamp": "2026-10-29T20:00:00Z", "type": "response_item",
             "payload": {"type": "function_call", "call_id": "a", "name": "bash", "arguments": json.dumps({"command": "curl -X POST /input -d '" + place + "'"})}},
            {"timestamp": "2026-10-29T20:00:01Z", "type": "response_item",
             "payload": {"type": "function_call_output", "call_id": "a", "output": "LastActionResult PlaceSuccess"}},
            {"timestamp": "2026-10-29T20:00:02Z", "type": "response_item",
             "payload": {"type": "function_call", "call_id": "b", "name": "bash", "arguments": "curl /observe"}},
            {"timestamp": "2026-10-29T20:00:03Z", "type": "response_item",
             "payload": {"type": "function_call_output", "call_id": "b", "output": "LastActionResult PlaceSuccess"}},
            {"timestamp": "2026-10-29T20:30:00Z", "type": "event_msg",
             "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": 1000, "output_tokens": 50}}}},
        ]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            rows = [run_metrics.run_metrics(self.write_run(root, "codex", ".codex/sessions/2026", lines)),
                    run_metrics.run_metrics(self.write_run(root, "pi", ".agentx-loop/sessions", lines))]
            for row in rows:
                self.assertEqual((row["toolCalls"], row["worldCommandCalls"], row["modelResponses"]), (2, 1, 1))
                self.assertEqual(row["worldActions"], {"Place": 1})
                self.assertEqual(row["actionResults"], {"PlaceSuccess": 1})  # the later observation is not a second pose
                self.assertEqual(row["placeSuccessRate"], 1.0)
                self.assertEqual(row["tokens"]["input"], 1000)
                self.assertEqual(row["resumes"], {"idle": 1})
            self.assertEqual([row["harness"] for row in rows], ["codex", "pi"])
            summary = run_metrics.summary(rows)
            self.assertEqual(set(summary), {"codex", "pi"})
            self.assertEqual(summary["pi"]["completed"], 1)


class LiveMessages(unittest.TestCase):
    def test_live_messages_follow_the_harness_rollouts(self):
        with tempfile.TemporaryDirectory() as temp:
            run = Path(temp) / RUN
            loop = run / "agents" / "eko" / "sandbox-home" / ".agentx-loop" / "sessions"
            loop.mkdir(parents=True)
            (loop / "rollout-s1.jsonl").write_text(json.dumps({"type": "response_item", "payload": {
                "type": "function_call", "name": "bash", "arguments": json.dumps({"command": "ls /workspace"})}}) + "\n")
            self.assertEqual(runner.agent_messages(run, "Eko"), [])
            messages = runner.agent_messages(run, "Eko", harness="pi")
            self.assertEqual([(m["kind"], m["text"]) for m in messages], [("command", "ls /workspace")])
            self.assertEqual(runner.agent_messages(run, "Eko", harness="claude"), [])


class PatchCopy(unittest.TestCase):
    def test_the_clawblox_patch_embeds_this_exact_turn_loop(self):
        patch = (KIT / "clawblox-isolation.patch").read_text()
        marker = "+++ b/src/agentx_harness_loop.py\n"
        self.assertIn(marker, patch)
        body = patch.split(marker, 1)[1].split("\n", 1)[1]  # skip the @@ header
        lines = []
        for line in body.splitlines():
            if line.startswith("diff --git") or line.startswith("--- "):
                break
            if line.startswith("+"):
                lines.append(line[1:])
        self.assertEqual("\n".join(lines) + "\n", (KIT / "harness_loop.py").read_text())


if __name__ == "__main__":
    unittest.main()
