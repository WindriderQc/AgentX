"""Unit tests for the runtime topology actuator, on a fake systemd and nvidia-smi."""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import agentx_topology_actuator as act  # noqa: E402


def make_config(state_dir, **limits):
    raw = {
        "version": 1,
        "group": "dual-gpu",
        "defaultMode": "pooled",
        "modes": {
            "pooled": {"units": ["ollama.service"], "endpoints": ["http://127.0.0.1:11434"],
                       "gpus": [0, 1]},
            "lanes": {"units": ["ollama-lane0.service", "ollama-lane1.service"],
                      "endpoints": ["http://127.0.0.1:11437", "http://127.0.0.1:11438"],
                      "gpus": [0, 1]},
        },
        "limits": dict({"gpuReleaseTimeoutSec": 30, "readyTimeoutSec": 30,
                        "safetyTimeoutSec": 1200, "pollIntervalSec": 1}, **limits),
        "stateDir": state_dir,
        "safetyUnit": "agentx-topology-safety",
        "executable": "/usr/local/sbin/agentx-topology-actuator",
    }
    config = act.validate_config(raw)
    config["configPath"] = os.path.join(state_dir, "config.json")
    return config, raw


class FakeClock:
    def __init__(self):
        self.t = 1_800_000_000.0
        self.m = 1000.0

    def now(self):
        return self.t

    def monotonic(self):
        return self.m

    def sleep(self, seconds):
        self.t += max(seconds, 0.001)
        self.m += max(seconds, 0.001)


class FakeHost:
    """A machine with units holding VRAM on GPUs and endpoints served by units."""

    UNIT_GPU_MIB = {
        "ollama.service": {0: 19600, 1: 22000},
        "ollama-lane0.service": {0: 20500},
        "ollama-lane1.service": {1: 20500},
    }
    ENDPOINT_UNIT = {
        "http://127.0.0.1:11434": "ollama.service",
        "http://127.0.0.1:11437": "ollama-lane0.service",
        "http://127.0.0.1:11438": "ollama-lane1.service",
    }

    def __init__(self, clock, active=("ollama.service",)):
        self.clock = clock
        self.active = {u: (u in active) for u in self.UNIT_GPU_MIB}
        self.release_at = {}          # unit -> clock time when its VRAM is freed
        self.release_delay = 2.0
        self.ready_delay = 3.0
        self.started_at = {}
        self.timer = None             # {"seconds", "argv"} while armed
        self.enabled = {u: (u in active) for u in self.UNIT_GPU_MIB}
        self.calls = []
        self.fail_start = set()
        self.never_ready = set()
        self.exit_after_start = set()
        self.foreign_mib = {0: 300, 1: 300}
        self.gpu_read_fails = False

    # systemd
    def unit_active(self, unit):
        if unit in self.exit_after_start and self.active.get(unit):
            return self.clock.now() - self.started_at.get(unit, 0) < 1
        return bool(self.active.get(unit))

    def start_unit(self, unit):
        self.calls.append(("start", unit))
        if unit in self.fail_start:
            raise act.ActuatorError("unit_start_failed", unit)
        self.active[unit] = True
        self.started_at[unit] = self.clock.now()
        self.release_at.pop(unit, None)

    def stop_unit(self, unit):
        self.calls.append(("stop", unit))
        self.active[unit] = False
        self.release_at[unit] = self.clock.now() + self.release_delay

    def set_enabled(self, unit, enabled):
        self.calls.append(("enable" if enabled else "disable", unit))
        self.enabled[unit] = enabled

    def timer_active(self, name):
        return self.timer is not None

    def arm_timer(self, name, seconds, argv):
        self.calls.append(("arm", name, seconds))
        self.timer = {"seconds": seconds, "argv": list(argv)}

    def disarm_timer(self, name):
        self.calls.append(("disarm", name))
        self.timer = None

    # nvidia-smi
    def _used(self, index):
        used = self.foreign_mib.get(index, 0)
        for unit, per_gpu in self.UNIT_GPU_MIB.items():
            holds = self.active.get(unit) or self.clock.now() < self.release_at.get(unit, 0)
            if holds:
                used += per_gpu.get(index, 0)
        return used

    def gpus(self):
        if self.gpu_read_fails:
            raise act.ActuatorError("gpu_read_failed", "nvidia-smi failed")
        return [{"index": i, "uuid": f"GPU-{i}", "memoryUsedMiB": self._used(i),
                 "memoryTotalMiB": 24576} for i in (0, 1)]

    def compute_apps(self):
        return []

    # HTTP
    def endpoint_version(self, url, timeout=3):
        unit = self.ENDPOINT_UNIT[url]
        if not self.unit_active(unit) or unit in self.never_ready:
            return None
        if self.clock.now() - self.started_at.get(unit, -1e9) < self.ready_delay:
            return None
        return "0.40.6"


class ActuatorTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="topology-actuator-")
        self.config, self.raw = make_config(self.dir)
        self.clock = FakeClock()
        self.host = FakeHost(self.clock)
        self.actuator = act.Actuator(self.config, host=self.host, clock=self.clock,
                                     hostname="gpu-host")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def state(self):
        with open(os.path.join(self.dir, "state.json"), encoding="utf-8") as handle:
            return json.load(handle)

    # ---------------------------------------------------------------- config

    def test_config_rejects_shared_unit_and_unknown_default(self):
        _, raw = make_config(self.dir)
        raw["modes"]["lanes"]["units"].append("ollama.service")
        with self.assertRaises(act.ActuatorError) as ctx:
            act.validate_config(raw)
        self.assertEqual(ctx.exception.code, "config_invalid")
        _, raw = make_config(self.dir)
        raw["defaultMode"] = "nope"
        with self.assertRaises(act.ActuatorError):
            act.validate_config(raw)

    def test_config_rejects_bad_unit_names_and_limits(self):
        _, raw = make_config(self.dir)
        raw["modes"]["lanes"]["units"] = ["ollama;rm -rf /.service"]
        with self.assertRaises(act.ActuatorError):
            act.validate_config(raw)
        _, raw = make_config(self.dir)
        raw["limits"]["safetyTimeoutSec"] = 10
        with self.assertRaises(act.ActuatorError):
            act.validate_config(raw)

    # --------------------------------------------------------------- grammar

    def test_remote_grammar_accepts_only_the_closed_set(self):
        modes = self.config["modes"]
        self.assertEqual(act.parse_remote_command("status", modes), ("status", {}))
        self.assertEqual(act.parse_remote_command("activate lanes --request-id sw-1", modes),
                         ("activate", {"mode": "lanes", "request_id": "sw-1"}))
        self.assertEqual(act.parse_remote_command("rollback --request-id r1 --reason verify_failed", modes),
                         ("rollback", {"request_id": "r1", "reason": "verify_failed"}))
        refused = [
            "", "bash", "status; reboot", "activate other --request-id x",
            "activate lanes", "confirm", "rollback --request-id x --pending y",
            "activate lanes --request-id 'a b'", "status --request-id $(id)",
            "activate lanes --request-id a --request-id b", "confirm --request-id x extra",
            "rollback --request-id x --reason Bad-Reason", "x" * 600,
        ]
        for text in refused:
            with self.subTest(text=text[:40]):
                with self.assertRaises(act.ActuatorError) as ctx:
                    act.parse_remote_command(text, modes)
                self.assertEqual(ctx.exception.exit_code, act.EXIT_USAGE)

    def test_ssh_entry_refuses_without_echoing_input(self):
        config_path = os.path.join(self.dir, "config.json")
        with open(config_path, "w", encoding="utf-8") as handle:
            json.dump(self.raw, handle)
        out = io.StringIO()
        with redirect_stdout(out):
            code = act.main(["--config", config_path, "ssh"],
                            environ={"SSH_ORIGINAL_COMMAND": "cat /etc/shadow"},
                            actuator_factory=lambda c: self.actuator)
        receipt = json.loads(out.getvalue())
        self.assertEqual(code, act.EXIT_USAGE)
        self.assertEqual(receipt["outcome"], "refused")
        self.assertEqual(receipt["schema"], act.SCHEMA)
        self.assertNotIn("shadow", out.getvalue())

    def test_ssh_entry_runs_status(self):
        config_path = os.path.join(self.dir, "config.json")
        with open(config_path, "w", encoding="utf-8") as handle:
            json.dump(self.raw, handle)
        out = io.StringIO()
        with redirect_stdout(out):
            code = act.main(["--config", config_path, "ssh", "status"], environ={},
                            actuator_factory=lambda c: self.actuator)
        receipt = json.loads(out.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual(receipt["observedMode"], "pooled")

    def test_ssh_entry_accepts_wrapper_argument_after_double_dash(self):
        config_path = os.path.join(self.dir, "config.json")
        with open(config_path, "w", encoding="utf-8") as handle:
            json.dump(self.raw, handle)
        out = io.StringIO()
        with redirect_stdout(out):
            code = act.main(["--config", config_path, "ssh", "--", "activate lanes --request-id sw-7"],
                            environ={}, actuator_factory=lambda c: self.actuator)
        receipt = json.loads(out.getvalue())
        self.assertEqual(code, 0, receipt)
        self.assertEqual(receipt["outcome"], "activated")
        self.assertEqual(receipt["requestId"], "sw-7")

    def test_missing_config_is_a_typed_refusal(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = act.main(["--config", os.path.join(self.dir, "absent.json"), "status"], environ={})
        self.assertEqual(code, act.EXIT_USAGE)
        self.assertEqual(json.loads(out.getvalue())["reason"], "config_missing")

    # ---------------------------------------------------------------- status

    def test_status_reports_units_gpus_and_confirmed_mode(self):
        receipt, code = self.actuator.status()
        self.assertEqual(code, 0)
        self.assertEqual(receipt["schema"], act.SCHEMA)
        self.assertEqual(receipt["observedMode"], "pooled")
        self.assertEqual(receipt["confirmedMode"], "pooled")
        self.assertTrue(receipt["modes"]["pooled"]["active"])
        self.assertFalse(receipt["modes"]["lanes"]["active"])
        self.assertEqual([g["memoryUsedMiB"] for g in receipt["gpus"]], [19900, 22300])
        self.assertEqual(receipt["safetyTimer"]["state"], "none")
        self.assertEqual(receipt["endpoints"][0]["version"], "0.40.6")

    def test_status_reports_mixed_and_none(self):
        self.host.active["ollama-lane0.service"] = True
        self.assertEqual(self.actuator.status()[0]["observedMode"], "mixed")
        for unit in self.host.active:
            self.host.active[unit] = False
        self.assertEqual(self.actuator.status()[0]["observedMode"], "none")

    # -------------------------------------------------------------- activate

    def test_activate_then_confirm_switches_exclusively(self):
        receipt, code = self.actuator.activate("lanes", "sw-1")
        self.assertEqual(code, 0, receipt)
        self.assertEqual(receipt["outcome"], "activated")
        self.assertEqual(receipt["modeBefore"], "pooled")
        self.assertEqual(receipt["modeAfter"], "lanes")
        self.assertEqual(receipt["unitsStopped"], ["ollama.service"])
        self.assertEqual(receipt["unitsStarted"], ["ollama-lane0.service", "ollama-lane1.service"])
        self.assertEqual(receipt["safetyTimer"]["state"], "armed")
        self.assertTrue(all(e["ready"] for e in receipt["endpoints"]))
        for key in ("stopMs", "gpuReleaseMs", "startMs", "readyMs", "totalMs"):
            self.assertIn(key, receipt["timings"])
        # The timer was armed before anything stopped.
        names = [c[0] for c in self.host.calls]
        self.assertLess(names.index("arm"), names.index("stop"))
        self.assertEqual(self.host.timer["argv"][-5:],
                         ["safety-sw-1", "--reason", "safety_timer", "--pending", "sw-1"])
        self.assertEqual(self.host.timer["seconds"], 1200)
        # Never both modes at once: the pooled unit was stopped before a lane started.
        self.assertLess(self.host.calls.index(("stop", "ollama.service")),
                        self.host.calls.index(("start", "ollama-lane0.service")))
        # Enablement is unchanged until confirmation.
        self.assertTrue(self.host.enabled["ollama.service"])
        self.assertEqual(self.state()["pending"]["stage"], "awaiting_confirm")

        receipt, code = self.actuator.confirm("sw-1")
        self.assertEqual(code, 0, receipt)
        self.assertEqual(receipt["outcome"], "confirmed")
        self.assertIsNone(self.host.timer)
        self.assertFalse(self.host.enabled["ollama.service"])
        self.assertTrue(self.host.enabled["ollama-lane0.service"])
        self.assertTrue(self.host.enabled["ollama-lane1.service"])
        self.assertEqual(self.state()["confirmedMode"], "lanes")
        self.assertIsNone(self.state()["pending"])

    def test_switch_back_to_pooled(self):
        self.actuator.activate("lanes", "sw-1")
        self.actuator.confirm("sw-1")
        receipt, code = self.actuator.activate("pooled", "sw-2")
        self.assertEqual(code, 0, receipt)
        self.assertEqual(receipt["unitsStopped"], ["ollama-lane0.service", "ollama-lane1.service"])
        self.assertEqual(receipt["unitsStarted"], ["ollama.service"])
        self.assertEqual(receipt["confirmedModeBefore"], "lanes")
        self.actuator.confirm("sw-2")
        self.assertEqual(self.state()["confirmedMode"], "pooled")

    def test_activate_waits_for_gpu_release(self):
        self.host.release_delay = 5.0
        receipt, _ = self.actuator.activate("lanes", "sw-1")
        self.assertEqual(receipt["outcome"], "activated")
        self.assertGreaterEqual(receipt["timings"]["gpuReleaseMs"], 5000)

    def test_activate_already_active_is_a_noop(self):
        receipt, code = self.actuator.activate("pooled", "sw-0")
        self.assertEqual(code, 0)
        self.assertEqual(receipt["outcome"], "already_active")
        self.assertIsNone(self.host.timer)
        self.assertEqual(self.host.calls, [])

    def test_activate_unknown_mode_is_refused(self):
        with self.assertRaises(act.ActuatorError) as ctx:
            self.actuator.activate("everything", "sw-1")
        self.assertEqual(ctx.exception.outcome, "refused")

    def test_activate_is_idempotent_by_request_id(self):
        first, _ = self.actuator.activate("lanes", "sw-1")
        calls = len(self.host.calls)
        again, code = self.actuator.activate("lanes", "sw-1")
        self.assertEqual(code, 0)
        self.assertTrue(again["replay"])
        self.assertEqual(again["outcome"], first["outcome"])
        self.assertEqual(len(self.host.calls), calls)

    def test_second_activation_refused_while_pending(self):
        self.actuator.activate("lanes", "sw-1")
        with self.assertRaises(act.ActuatorError) as ctx:
            self.actuator.activate("pooled", "sw-2")
        self.assertEqual(ctx.exception.code, "activation_pending")

    def test_interrupted_activation_is_reported_not_rerun(self):
        state = {"version": 1, "confirmedMode": "pooled", "confirmedAt": None,
                 "pending": {"requestId": "sw-9", "targetMode": "lanes", "previousMode": "pooled",
                             "armedAt": "x", "deadline": "y", "stage": "armed"},
                 "receipts": {}, "receiptOrder": []}
        self.actuator.store.write(state)
        self.host.timer = {"seconds": 1200, "argv": []}
        receipt, code = self.actuator.activate("lanes", "sw-9")
        self.assertEqual(code, act.EXIT_UNKNOWN)
        self.assertEqual(receipt["outcome"], "interrupted")
        self.assertEqual(self.host.calls, [])

    def test_unit_start_failure_restores_previous_mode(self):
        self.host.fail_start.add("ollama-lane1.service")
        receipt, code = self.actuator.activate("lanes", "sw-1")
        self.assertEqual(code, act.EXIT_FAILED)
        self.assertEqual(receipt["outcome"], "failed")
        self.assertEqual(receipt["reason"], "unit_start_failed")
        self.assertTrue(receipt["restored"])
        self.assertEqual(receipt["modeAfter"], "pooled")
        self.assertIsNone(self.host.timer)
        self.assertIsNone(self.state()["pending"])
        self.assertFalse(self.host.active["ollama-lane0.service"])

    def test_endpoint_never_ready_restores_previous_mode(self):
        self.host.never_ready.add("ollama-lane0.service")
        receipt, code = self.actuator.activate("lanes", "sw-1")
        self.assertEqual(code, act.EXIT_FAILED)
        self.assertEqual(receipt["reason"], "endpoint_not_ready")
        self.assertTrue(receipt["restored"])
        self.assertTrue(self.host.active["ollama.service"])

    def test_unit_that_exits_fails_fast(self):
        self.host.exit_after_start.add("ollama-lane1.service")
        receipt, _ = self.actuator.activate("lanes", "sw-1")
        self.assertEqual(receipt["reason"], "unit_exited")
        self.assertLess(receipt["timings"]["readyMs"], 30000)

    def test_gpu_not_released_restores_and_reports(self):
        self.host.foreign_mib = {0: 300, 1: 9000}   # another program holds GPU 1
        receipt, code = self.actuator.activate("lanes", "sw-1")
        self.assertEqual(code, act.EXIT_FAILED)
        self.assertEqual(receipt["reason"], "gpu_not_released")
        # The previous mode needs the same GPUs, so its restore also fails and
        # the safety timer stays armed to try again.
        self.assertFalse(receipt["restored"])
        self.assertIsNotNone(self.host.timer)
        self.assertEqual(self.state()["pending"]["stage"], "restore_failed")

    def test_gpu_read_failure_blocks_switch(self):
        self.host.gpu_read_fails = True
        receipt, code = self.actuator.activate("lanes", "sw-1")
        self.assertEqual(code, act.EXIT_FAILED)
        self.assertEqual(receipt["reason"], "gpu_read_failed")

    # --------------------------------------------------------------- confirm

    def test_confirm_refuses_wrong_or_missing_activation(self):
        with self.assertRaises(act.ActuatorError) as ctx:
            self.actuator.confirm("sw-1")
        self.assertEqual(ctx.exception.code, "nothing_pending")
        self.actuator.activate("lanes", "sw-1")
        with self.assertRaises(act.ActuatorError) as ctx:
            self.actuator.confirm("sw-2")
        self.assertEqual(ctx.exception.code, "request_mismatch")

    def test_confirm_refuses_when_target_stopped_running(self):
        self.actuator.activate("lanes", "sw-1")
        self.host.active["ollama-lane1.service"] = False
        with self.assertRaises(act.ActuatorError) as ctx:
            self.actuator.confirm("sw-1")
        self.assertEqual(ctx.exception.code, "target_not_active")
        self.assertIsNotNone(self.host.timer)

    def test_confirm_is_idempotent(self):
        self.actuator.activate("lanes", "sw-1")
        self.actuator.confirm("sw-1")
        again, code = self.actuator.confirm("sw-1")
        self.assertEqual(code, 0)
        self.assertTrue(again["replay"])

    # -------------------------------------------------------------- rollback

    def test_rollback_restores_last_confirmed_mode(self):
        self.actuator.activate("lanes", "sw-1")
        receipt, code = self.actuator.rollback("rb-1", "verify_failed")
        self.assertEqual(code, 0, receipt)
        self.assertEqual(receipt["outcome"], "rolled_back")
        self.assertEqual(receipt["targetMode"], "pooled")
        self.assertEqual(receipt["unitsStopped"], ["ollama-lane0.service", "ollama-lane1.service"])
        self.assertEqual(receipt["unitsStarted"], ["ollama.service"])
        self.assertIsNone(self.host.timer)
        self.assertIsNone(self.state()["pending"])
        self.assertEqual(self.state()["confirmedMode"], "pooled")

    def test_safety_timer_rollback_matches_its_activation_only(self):
        self.actuator.activate("lanes", "sw-1")
        self.actuator.confirm("sw-1")
        receipt, code = self.actuator.rollback("safety-sw-1", "safety_timer", pending_ref="sw-1")
        self.assertEqual(code, 0)
        self.assertEqual(receipt["outcome"], "noop")
        self.assertTrue(self.host.active["ollama-lane0.service"])

    def test_safety_timer_rollback_after_lost_core(self):
        self.actuator.activate("lanes", "sw-1")
        receipt, code = self.actuator.rollback("safety-sw-1", "safety_timer", pending_ref="sw-1")
        self.assertEqual(code, 0)
        self.assertEqual(receipt["outcome"], "rolled_back")
        self.assertTrue(self.host.active["ollama.service"])
        # A later confirm of the abandoned activation is refused.
        with self.assertRaises(act.ActuatorError):
            self.actuator.confirm("sw-1")

    def test_rollback_when_already_in_confirmed_mode(self):
        receipt, code = self.actuator.rollback("rb-1")
        self.assertEqual(code, 0)
        self.assertEqual(receipt["outcome"], "already_active")

    def test_status_finds_receipts_by_request_id(self):
        self.actuator.activate("lanes", "sw-1")
        self.actuator.confirm("sw-1")
        receipt, _ = self.actuator.status("sw-1")
        self.assertEqual(set(receipt["receipts"]), {"activate", "confirm"})
        self.assertEqual(receipt["receipts"]["activate"]["outcome"], "activated")

    def test_lost_timer_is_reported(self):
        self.actuator.activate("lanes", "sw-1")
        self.host.timer = None   # reboot: transient timers do not survive
        receipt, _ = self.actuator.status()
        self.assertEqual(receipt["safetyTimer"]["state"], "lost")

    def test_busy_lock_is_refused(self):
        other = act.StateStore(self.dir)
        other.acquire(1, self.clock)
        try:
            with self.assertRaises(act.ActuatorError) as ctx:
                self.actuator.activate("lanes", "sw-1")
            self.assertEqual(ctx.exception.code, "actuator_busy")
        finally:
            other.release()

    def test_receipts_are_archived(self):
        self.actuator.activate("lanes", "sw-1")
        files = os.listdir(os.path.join(self.dir, "receipts"))
        self.assertEqual(len(files), 1)
        self.assertIn("activate-sw-1", files[0])


class ParseTests(unittest.TestCase):
    def test_parse_gpu_csv(self):
        text = "0, GPU-aa, 19604, 24576\n1, GPU-bb, 22019, 24576\nbad line\n"
        self.assertEqual([g["memoryUsedMiB"] for g in act.parse_gpu_csv(text)], [19604, 22019])

    def test_parse_compute_apps(self):
        text = "GPU-aa, 4242, /usr/local/bin/ollama, 19000\n"
        self.assertEqual(act.parse_compute_apps_csv(text)[0]["process"], "ollama")


if __name__ == "__main__":
    unittest.main()
