"""External worlds: a run that joins a world already running elsewhere (remote_world.py).

CPU only, loopback only, no Clawblox world and no model. Covers what the external mode adds
to the runner's guarantees: an unreachable or wrong world refuses before anything starts, a
world that falls during the run fails it (cleanup still proven), and status names the world.
"""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

KIT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import island_runner as runner  # noqa: E402
import run_island  # noqa: E402
from remote_world import RemoteWorldRelay  # noqa: E402
from run_state import MEMORY, REQUIRED_CHECKS  # noqa: E402
from test_remote_world import FakeWorld, TOKEN  # noqa: E402

RUN = "00000000-0000-4000-8000-0000000000ea"
DISPATCH = "00000000-0000-4000-8000-0000000000eb"


class Clock:
    def __init__(self): self.value = 0
    def monotonic(self): return self.value
    def sleep(self, seconds): self.value += seconds


def closed_port():
    down = FakeWorld()
    port = down.server.server_port
    down.server.server_close()
    return port


class EpisodeWatch(unittest.TestCase):
    """run_island.execute with a world probe, as the supervisor wires it for a remote world."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        templates = root / "templates"
        templates.mkdir()
        for name in MEMORY:
            (templates / name).write_text("" if name.endswith(".jsonl") else "synthetic memory")
        (templates / "SYSTEM_PROMPT.md").write_text("Read ${WORKSPACE_DIR}; name ${WORLD_AGENT_NAME}")
        self.a = run_island.parser().parse_args(["--run-dir", str(root / "run"), "--templates-dir", str(templates),
                                                 "--world-dir", str(root / "world"), "--netcheck", "--minutes", "0.2",
                                                 "--memory-warning-minutes", "0", "--world-health-seconds", "1",
                                                 "--world-down-seconds", "3"])
        self.stops = []
        test = self

        class World:
            def __init__(self, **kw): pass
            def start(self, **kw): pass
            def connect(self, **kw): pass
            def stop(self, **kw): test.stops.append("world")

        class Agent:
            def __init__(self, **kw): self.dir = kw["dir"]
            def start(self, **kw):
                home = self.dir / "sandbox-home" / ".codex" / "sessions"
                home.mkdir(parents=True, exist_ok=True)
                (home / "fixture.jsonl").write_text('{"type":"response_item","payload":{"type":"message","role":"assistant"}}\n')
                data = {"schema": "agentx.island-netcheck/v1", "checks": [{"name": n, "passed": True} for n in REQUIRED_CHECKS]}
                (self.dir / "workspace" / "netcheck.json").write_text(json.dumps(data))
                return SimpleNamespace(tmux_pane_id="%1")
            def stop(self, **kw): test.stops.append("agent")

        self.runtime = SimpleNamespace(agentx_isolation_version=lambda: 1, World=World, Agent=Agent)

    def tearDown(self):
        self.temp.cleanup()

    def episode(self, probe):
        clock = Clock()
        code = run_island.execute(self.a, self.runtime, clock=clock, alive=lambda _: True,
                                  world_health=lambda: probe(clock.value))
        return code, json.loads((self.a.run_dir / "receipt.json").read_text())

    def test_world_that_falls_during_the_run_fails_it_and_cleanup_still_runs(self):
        code, receipt = self.episode(lambda now: now < 4)
        self.assertEqual((code, receipt["outcome"]), (1, "failed"))
        self.assertRegex(receipt["error"], r"^world unreachable for [34] s$")
        self.assertEqual(self.stops, ["agent", "world"], "agent and world relay are stopped")
        self.assertTrue(receipt["localStopped"])
        self.assertGreaterEqual(receipt["worldHealth"]["failures"], 3)
        self.assertIn("world-unreachable", [event["event"] for event in receipt["events"]])

    def test_short_blip_is_noted_but_not_fatal(self):
        code, receipt = self.episode(lambda now: not 4 <= now < 6)
        self.assertEqual((code, receipt["outcome"]), (0, "completed"))
        events = [event["event"] for event in receipt["events"]]
        self.assertLess(events.index("world-unreachable"), events.index("world-back"))
        self.assertGreaterEqual(receipt["worldHealth"]["failures"], 1)

    def test_world_gone_at_the_end_is_not_completed(self):
        code, receipt = self.episode(lambda now: now < 11.5)
        self.assertEqual(receipt["outcome"], "failed")
        self.assertEqual(receipt["error"], "world unreachable at the end of the run")
        self.assertTrue(receipt["localStopped"])

    def test_a_probe_that_raises_counts_as_down(self):
        def probe(now):
            if now >= 2: raise OSError("synthetic")
            return True
        code, receipt = self.episode(probe)
        self.assertEqual(receipt["outcome"], "failed")
        self.assertIn("world unreachable", receipt["error"])

    def test_local_worlds_are_unchanged(self):
        code = run_island.execute(self.a, self.runtime, clock=Clock(), alive=lambda _: True)
        receipt = json.loads((self.a.run_dir / "receipt.json").read_text())
        self.assertEqual((code, receipt["outcome"]), (0, "completed"))
        self.assertNotIn("worldHealth", receipt)


class RunnerFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "runs").mkdir()
        (self.root / "worlds" / "mesa-island").mkdir(parents=True)
        (self.root / "worlds" / "mesa-island" / "world.toml").write_text('name = "Mesa"\n[scripts]\nmain = "main.lua"\n')
        self.config_path = self.root / "runner.json"
        self.config_path.write_text(json.dumps({"runsRoot": str(self.root / "runs"), "worldsRoot": str(self.root / "worlds")}))
        self.config = runner.load_config(self.config_path)
        self.token = self.root / "world.token"
        self.token.write_text(TOKEN)
        self.token.chmod(0o600)

    def tearDown(self):
        self.tmp.cleanup()

    def remote(self, name, target, expect="living-island", token=True):
        directory = self.root / "worlds" / name
        directory.mkdir()
        command = [sys.executable, "-I", str(KIT / "remote_world.py"), "--target", target, "--expect-world", expect]
        if token:
            command += ["--access-token-file", str(self.token)]
        (directory / "world.toml").write_text(f'name = "{name}"\n[run]\ncommand = {json.dumps(command)}\n[scripts]\nmain = "README.md"\n')
        return directory

    def call(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = runner.main([*argv, "--config", str(self.config_path)])
        return code, json.loads(out.getvalue())

    def start(self, world):
        # Only the detached supervisor is faked; the remote world probe really runs.
        real = runner.subprocess.Popen
        supervisor = mock.Mock(return_value=mock.Mock(pid=4242))

        def popen(argv, *args, **kwargs):
            return supervisor(argv, *args, **kwargs) if "supervise" in argv else real(argv, *args, **kwargs)

        with mock.patch.object(runner.subprocess, "Popen", side_effect=popen):
            result = self.call("start", "--run-id", RUN, "--dispatch-id", DISPATCH, "--minutes", "60",
                               "--context-window", "32768", "--world", world)
        return result, supervisor


class RemoteWorldDetection(RunnerFixture):
    def test_reads_the_delegated_command(self):
        self.remote("graphysx-living", "https://agentx.example:18794")
        found = runner.remote_world(self.config, "graphysx-living")
        self.assertEqual((found["origin"], found["world"], found["accessHeader"]),
                         ("https://agentx.example:18794", "living-island", True))
        self.assertIsNone(runner.remote_world(self.config, "mesa-island"), "a world that runs here is local")
        broken = self.root / "worlds" / "broken"
        broken.mkdir()
        (broken / "world.toml").write_text("[run\ncommand = 3")
        self.assertIsNone(runner.remote_world(self.config, "broken"))
        other = self.root / "worlds" / "other-run"
        other.mkdir()
        (other / "world.toml").write_text('[run]\ncommand = ["node", "server.mjs"]\n')
        self.assertIsNone(runner.remote_world(self.config, "other-run"), "only remote_world.py is a remote world")


class ExternalStart(RunnerFixture):
    def test_unreachable_world_refuses_before_any_file_or_process(self):
        self.remote("graphysx-living", f"http://127.0.0.1:{closed_port()}")
        (code, answer), popen = self.start("graphysx-living")
        self.assertEqual((code, answer["code"]), (1, "WORLD_UNAVAILABLE"))
        self.assertIn("/healthz answered 502", answer["message"])
        popen.assert_not_called()
        self.assertFalse((self.root / "runs" / RUN).exists(), "nothing started: the queue may lift its mark")

    def test_another_island_or_a_closed_gate_refuses(self):
        with FakeWorld() as world:
            world.world_id, world.access = "mesa-island", TOKEN
            self.remote("graphysx-living", world.url)
            (code, answer), popen = self.start("graphysx-living")
            self.assertEqual(answer["code"], "WORLD_UNAVAILABLE")
            self.assertIn("runs mesa-island, not living-island", answer["message"])
            world.world_id = "living-island"
            self.remote("no-token", world.url, token=False)
            (code, answer), popen = self.start("no-token")
            self.assertEqual(answer["code"], "WORLD_UNAVAILABLE")
            self.assertIn("access gate", answer["message"])
            popen.assert_not_called()
            self.assertFalse(any(call["path"].startswith("/join") for call in world.calls), "a refused start never joins")

    def test_healthy_world_starts_and_status_names_it(self):
        with FakeWorld() as world:
            world.world_id, world.access = "living-island", TOKEN
            self.remote("graphysx-living", world.url)
            (code, answer), popen = self.start("graphysx-living")
            self.assertEqual(code, 0, answer)
            popen.assert_called_once()
        request = (self.root / "runs" / RUN / "request.json").read_text()
        self.assertNotIn(TOKEN, request, "the access token stays in its file")
        self.assertEqual(json.loads(request)["remoteWorld"], {"origin": world.url, "world": "living-island"})
        with mock.patch.object(runner, "leftover_processes", return_value=[]):
            code, answer = self.call("status", "--run-id", RUN)
        data = answer["data"]
        self.assertEqual((data["world"], data["worldKind"]), ("graphysx-living", "remote"))
        self.assertEqual(data["remoteWorld"]["world"], "living-island")
        self.assertIsNone(data["recording"], "the remote world records itself")

    def test_local_world_start_is_unchanged(self):
        (code, answer), popen = self.start("mesa-island")
        self.assertEqual(code, 0, answer)
        self.assertEqual(json.loads((self.root / "runs" / RUN / "request.json").read_text())["worldKind"], "local")


class ExternalCheck(RunnerFixture):
    def test_check_probes_a_named_remote_world_only(self):
        self.remote("graphysx-living", f"http://127.0.0.1:{closed_port()}")
        with mock.patch.object(runner, "harness_problems", return_value=[]):
            code, answer = self.call("check", "--world", "graphysx-living")
            self.assertEqual(answer["data"]["worldKind"], "remote")
            self.assertTrue(any("remote world graphysx-living unavailable" in p for p in answer["data"]["problems"]))
            code, answer = self.call("check")
            self.assertNotIn("world", answer["data"], "check without --world keeps its old answer")
            self.assertFalse(any("remote world" in p for p in answer["data"]["problems"]))
            code, answer = self.call("check", "--world", "absent")
            self.assertIn("world absent is not installed on this runner", answer["data"]["problems"])


class SupervisorWiring(RunnerFixture):
    def test_bad_watch_configuration_keeps_proof_that_execution_never_started(self):
        self.start("mesa-island")
        self.config["worldHealthSeconds"] = "not-a-number"
        args = runner.parse(["supervise", "--run-id", RUN])
        with mock.patch.object(runner.episode, "execute") as execute:
            runner.action_supervise(self.config, args)
        execute.assert_not_called()
        state = json.loads((self.root / "runs" / RUN / "state.json").read_text())
        self.assertEqual((state["phase"], state["outcome"], state["localStopped"]),
                         ("finished", "failed", True))

    def supervise(self, world):
        with FakeWorld() as fake:
            fake.world_id, fake.access = "living-island", TOKEN
            if world != "mesa-island":
                self.remote(world, fake.url)
            self.start(world)
        seen = {}

        def execute(a, prepared_workspace=None, on_event=None, world_health=None):
            seen["health"] = world_health
            Path(a.run_dir / "receipt.json").write_text(json.dumps(
                {"outcome": "failed", "error": "world unreachable for 120 s", "localStopped": True,
                 "worldHealth": {"checks": 9, "failures": 5, "longestDownSeconds": 120}}))
            return 1

        args = runner.parse(["supervise", "--run-id", RUN])
        with mock.patch.object(runner.episode, "execute", side_effect=execute):
            runner.action_supervise(self.config, args)
        state = json.loads((self.root / "runs" / RUN / "state.json").read_text())
        return seen["health"], state

    def test_remote_runs_are_watched_and_report_world_health(self):
        health, state = self.supervise("graphysx-living")
        self.assertTrue(callable(health))
        self.assertEqual((state["phase"], state["outcome"]), ("finished", "failed"))
        self.assertEqual(state["worldHealth"]["longestDownSeconds"], 120)
        self.assertEqual(state["events"][-1], {**state["events"][-1], "event": "failed", "error": "world unreachable for 120 s"})

    def test_local_runs_are_not_probed(self):
        health, _state = self.supervise("mesa-island")
        self.assertIsNone(health)


class HealthThroughTheRelay(unittest.TestCase):
    def test_world_healthy_follows_the_remote_world_through_its_relay(self):
        world = FakeWorld().__enter__()
        world.world_id, world.access = "living-island", TOKEN
        relay = RemoteWorldRelay(world.url, log=lambda _: None, access_token=TOKEN, expect_world="living-island").__enter__()
        try:
            self.assertTrue(runner.world_healthy(relay.port))
            world.world_id = "mesa-island"
            self.assertFalse(runner.world_healthy(relay.port), "a switched island is not this run's world")
            world.world_id = "living-island"
            self.assertTrue(runner.world_healthy(relay.port))
            world.__exit__(None, None, None)
            self.assertFalse(runner.world_healthy(relay.port), "a fallen world is unhealthy")
        finally:
            relay.__exit__(None, None, None)
        self.assertFalse(runner.world_healthy(closed_port()), "a stopped relay is unhealthy")


if __name__ == "__main__":
    unittest.main()
