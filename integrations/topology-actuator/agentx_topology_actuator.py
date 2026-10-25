#!/usr/bin/env python3
"""Runtime topology actuator for one GPU host (AgentX #360, phase 3).

A small privileged program that applies the runtime units of one declared
topology mode, with a closed command set:

    status   [--request-id ID]
    activate <mode> --request-id ID
    confirm  --request-id ID
    rollback --request-id ID [--reason REASON]

Each call prints one JSON receipt (schema agentx.runtime-topology-actuation/v1).
The mode -> units map comes from an instance-owned configuration file; nothing
here names a host, a port or a model.

`activate` arms a systemd safety timer before it stops anything. If Core does
not `confirm` within the configured bound, the timer runs `rollback`, which
restores the last confirmed mode. Unit enablement (what starts at boot) changes
only on `confirm`, so a reboot during a switch also comes back in the last
confirmed mode.

Python standard library only. Linux only (fcntl, systemd, nvidia-smi).
"""

import argparse
import fcntl
import json
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

SCHEMA = "agentx.runtime-topology-actuation/v1"
CONFIG_SCHEMA = 1
STATE_VERSION = 1
DEFAULT_CONFIG_PATH = "/etc/agentx/topology-actuator.json"
COMMANDS = ("status", "activate", "confirm", "rollback")

MODE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
GROUP_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$")
REASON_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
UNIT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9@._-]{0,95}\.service$")
TIMER_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
ENDPOINT_RE = re.compile(r"^https?://[A-Za-z0-9.\-\[\]:]+:[0-9]{1,5}$")

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_UNKNOWN = 3
EXIT_REFUSED = 4

MAX_RECEIPTS = 50
MAX_RECEIPT_FILES = 200

DEFAULT_LIMITS = {
    "unitTimeoutSec": 120,
    "gpuReleaseTimeoutSec": 90,
    "gpuFreeMiB": 1024,
    "readyTimeoutSec": 120,
    "safetyTimeoutSec": 1200,
    "lockTimeoutSec": 15,
    "pollIntervalSec": 1,
}
LIMIT_BOUNDS = {
    "unitTimeoutSec": (5, 900),
    "gpuReleaseTimeoutSec": (5, 900),
    "gpuFreeMiB": (0, 8192),
    "readyTimeoutSec": (5, 900),
    "safetyTimeoutSec": (300, 7200),
    "lockTimeoutSec": (1, 300),
    "pollIntervalSec": (0, 30),
}


class ActuatorError(Exception):
    """A typed failure. `outcome` is the receipt outcome, `code` the reason."""

    def __init__(self, code, message="", outcome="failed", exit_code=EXIT_FAILED):
        super().__init__(message or code)
        self.code = code
        self.outcome = outcome
        self.exit_code = exit_code


def refused(code, message=""):
    return ActuatorError(code, message, outcome="refused", exit_code=EXIT_REFUSED)


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

def _int_in(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < low or value > high:
        raise ActuatorError("config_invalid", f"{name} must be an integer in [{low}, {high}]",
                            outcome="refused", exit_code=EXIT_USAGE)
    return value


def validate_config(raw):
    """Validate the instance configuration. Errors never echo its content."""
    def bad(message):
        return ActuatorError("config_invalid", message, outcome="refused", exit_code=EXIT_USAGE)

    if not isinstance(raw, dict):
        raise bad("configuration must be an object")
    if raw.get("version") != CONFIG_SCHEMA:
        raise bad("unsupported configuration version")
    group = raw.get("group")
    if not isinstance(group, str) or not GROUP_RE.match(group):
        raise bad("group must be a lowercase identifier")
    modes_raw = raw.get("modes")
    if not isinstance(modes_raw, dict) or not (1 <= len(modes_raw) <= 6):
        raise bad("modes must be an object with 1 to 6 modes")

    modes = {}
    seen_units = {}
    for name, spec in modes_raw.items():
        if not isinstance(name, str) or not MODE_RE.match(name):
            raise bad("mode names must be lowercase identifiers")
        if not isinstance(spec, dict):
            raise bad(f"mode {name} must be an object")
        units = spec.get("units")
        if not isinstance(units, list) or not (1 <= len(units) <= 8):
            raise bad(f"mode {name} needs 1 to 8 units")
        for unit in units:
            if not isinstance(unit, str) or not UNIT_RE.match(unit):
                raise bad(f"mode {name} has an invalid unit name")
            if unit in seen_units:
                raise bad("a unit belongs to one mode only")
            seen_units[unit] = name
        endpoints = spec.get("endpoints", [])
        if not isinstance(endpoints, list) or len(endpoints) > 8:
            raise bad(f"mode {name} endpoints must be a list of at most 8")
        for endpoint in endpoints:
            if not isinstance(endpoint, str) or not ENDPOINT_RE.match(endpoint):
                raise bad(f"mode {name} has an invalid endpoint")
        gpus = spec.get("gpus", [])
        if not isinstance(gpus, list) or len(gpus) > 16:
            raise bad(f"mode {name} gpus must be a list")
        for gpu in gpus:
            _int_in(gpu, 0, 63, f"mode {name} gpu index")
        modes[name] = {
            "units": list(units),
            "endpoints": [e.rstrip("/") for e in endpoints],
            "gpus": sorted(set(gpus)),
        }

    default_mode = raw.get("defaultMode")
    if default_mode not in modes:
        raise bad("defaultMode must name a declared mode")

    limits = dict(DEFAULT_LIMITS)
    limits_raw = raw.get("limits", {})
    if not isinstance(limits_raw, dict):
        raise bad("limits must be an object")
    for key, value in limits_raw.items():
        if key not in LIMIT_BOUNDS:
            raise bad("unknown limit")
        low, high = LIMIT_BOUNDS[key]
        limits[key] = _int_in(value, low, high, key)

    state_dir = raw.get("stateDir", "/var/lib/agentx-topology-actuator")
    if not isinstance(state_dir, str) or not state_dir.startswith("/"):
        raise bad("stateDir must be an absolute path")
    safety_unit = raw.get("safetyUnit", "agentx-topology-safety")
    if not isinstance(safety_unit, str) or not TIMER_NAME_RE.match(safety_unit):
        raise bad("safetyUnit must be a simple unit name")
    executable = raw.get("executable", "/usr/local/sbin/agentx-topology-actuator")
    if not isinstance(executable, str) or not executable.startswith("/"):
        raise bad("executable must be an absolute path")

    return {
        "group": group,
        "defaultMode": default_mode,
        "modes": modes,
        "limits": limits,
        "stateDir": state_dir,
        "safetyUnit": safety_unit,
        "executable": executable,
    }


def load_config(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        raise ActuatorError("config_missing", "configuration file not found",
                            outcome="refused", exit_code=EXIT_USAGE)
    except (OSError, ValueError):
        raise ActuatorError("config_unreadable", "configuration file is not readable JSON",
                            outcome="refused", exit_code=EXIT_USAGE)
    config = validate_config(raw)
    config["configPath"] = path
    return config


# --------------------------------------------------------------------------
# Host adapters (replaced by fakes in tests)
# --------------------------------------------------------------------------

class SystemHost:
    """systemd, nvidia-smi and HTTP on the real machine."""

    def __init__(self, unit_timeout=120):
        self.unit_timeout = unit_timeout

    def _run(self, argv, timeout=None):
        try:
            proc = subprocess.run(argv, capture_output=True, text=True,
                                  timeout=timeout or self.unit_timeout, check=False)
            return proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired:
            return 124, "", "timeout"
        except OSError as error:
            return 127, "", str(error)

    def unit_active(self, unit):
        code, out, _ = self._run(["systemctl", "is-active", unit], timeout=15)
        return code == 0 and out.strip() == "active"

    def start_unit(self, unit):
        code, _, err = self._run(["systemctl", "start", unit])
        if code != 0:
            raise ActuatorError("unit_start_failed", f"{unit}: {err.strip()[:200]}")

    def stop_unit(self, unit):
        code, _, err = self._run(["systemctl", "stop", unit])
        if code != 0:
            raise ActuatorError("unit_stop_failed", f"{unit}: {err.strip()[:200]}")

    def set_enabled(self, unit, enabled):
        code, _, err = self._run(["systemctl", "enable" if enabled else "disable", unit], timeout=30)
        if code != 0:
            raise ActuatorError("unit_enablement_failed", f"{unit}: {err.strip()[:200]}")

    def timer_active(self, name):
        code, out, _ = self._run(["systemctl", "is-active", f"{name}.timer"], timeout=15)
        return code == 0 and out.strip() == "active"

    def arm_timer(self, name, seconds, argv):
        self._run(["systemctl", "stop", f"{name}.timer"], timeout=15)
        self._run(["systemctl", "reset-failed", f"{name}.timer", f"{name}.service"], timeout=15)
        command = ["systemd-run", f"--unit={name}", f"--on-active={int(seconds)}s",
                   "--timer-property=AccuracySec=1s",
                   "--timer-property=RemainAfterElapse=no",
                   "--description=AgentX topology safety rollback", "--"] + list(argv)
        code, _, err = self._run(command, timeout=30)
        if code != 0:
            raise ActuatorError("safety_timer_arm_failed", err.strip()[:200])

    def disarm_timer(self, name):
        code, _, err = self._run(["systemctl", "stop", f"{name}.timer"], timeout=15)
        if code != 0 and self.timer_active(name):
            raise ActuatorError("safety_timer_disarm_failed", err.strip()[:200])

    def gpus(self):
        code, out, err = self._run([
            "nvidia-smi", "--query-gpu=index,uuid,memory.used,memory.total",
            "--format=csv,noheader,nounits"], timeout=20)
        if code != 0:
            raise ActuatorError("gpu_read_failed", err.strip()[:200] or "nvidia-smi failed")
        return parse_gpu_csv(out)

    def compute_apps(self):
        code, out, _ = self._run([
            "nvidia-smi", "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
            "--format=csv,noheader,nounits"], timeout=20)
        if code != 0:
            return None
        return parse_compute_apps_csv(out)

    def endpoint_version(self, url, timeout=3):
        try:
            with urllib.request.urlopen(f"{url}/api/version", timeout=timeout) as response:
                if response.status != 200:
                    return None
                body = json.loads(response.read(4096).decode("utf-8", "replace") or "{}")
                version = body.get("version")
                return version if isinstance(version, str) else ""
        except (urllib.error.URLError, OSError, ValueError):
            return None


class SystemClock:
    def now(self):
        return time.time()

    def monotonic(self):
        return time.monotonic()

    def sleep(self, seconds):
        if seconds > 0:
            time.sleep(seconds)


def parse_gpu_csv(text):
    gpus = []
    for line in (text or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        try:
            gpus.append({
                "index": int(parts[0]),
                "uuid": parts[1][:64],
                "memoryUsedMiB": int(float(parts[2])),
                "memoryTotalMiB": int(float(parts[3])),
            })
        except ValueError:
            continue
    return gpus


def parse_compute_apps_csv(text):
    apps = []
    for line in (text or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        try:
            apps.append({
                "gpuUuid": parts[0][:64],
                "pid": int(parts[1]),
                "process": os.path.basename(parts[2])[:64],
                "usedMiB": int(float(parts[3])) if parts[3].replace(".", "", 1).isdigit() else None,
            })
        except ValueError:
            continue
    return apps


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------

class StateStore:
    def __init__(self, state_dir):
        self.state_dir = state_dir
        self.path = os.path.join(state_dir, "state.json")
        self.lock_path = os.path.join(state_dir, "lock")
        self.receipts_dir = os.path.join(state_dir, "receipts")
        self._lock_handle = None

    def ensure(self):
        os.makedirs(self.receipts_dir, mode=0o750, exist_ok=True)

    def read(self):
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                state = json.load(handle)
            if isinstance(state, dict) and state.get("version") == STATE_VERSION:
                state.setdefault("receipts", {})
                state.setdefault("receiptOrder", [])
                return state
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            raise ActuatorError("state_unreadable", "actuator state is unreadable",
                                outcome="unknown", exit_code=EXIT_UNKNOWN)
        return {"version": STATE_VERSION, "confirmedMode": None, "confirmedAt": None,
                "pending": None, "receipts": {}, "receiptOrder": []}

    def write(self, state):
        self.ensure()
        tmp = f"{self.path}.tmp-{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, self.path)
        try:
            fd = os.open(self.state_dir, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError:
            pass

    def acquire(self, timeout, clock):
        self.ensure()
        handle = open(self.lock_path, "a+")
        deadline = clock.monotonic() + timeout
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._lock_handle = handle
                return
            except BlockingIOError:
                if clock.monotonic() >= deadline:
                    handle.close()
                    raise refused("actuator_busy", "another actuator command is running")
                clock.sleep(0.2)

    def release(self):
        if self._lock_handle is not None:
            try:
                fcntl.flock(self._lock_handle.fileno(), fcntl.LOCK_UN)
            finally:
                self._lock_handle.close()
                self._lock_handle = None

    def archive_receipt(self, receipt):
        try:
            self.ensure()
            stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
            rid = receipt.get("requestId") or "none"
            name = f"{stamp}-{receipt.get('command')}-{rid}.json"
            with open(os.path.join(self.receipts_dir, name), "w", encoding="utf-8") as handle:
                json.dump(receipt, handle, indent=2, sort_keys=True)
            files = sorted(os.listdir(self.receipts_dir))
            for old in files[:-MAX_RECEIPT_FILES]:
                os.unlink(os.path.join(self.receipts_dir, old))
        except OSError:
            pass


def remember_receipt(state, key, receipt):
    state["receipts"][key] = receipt
    order = [k for k in state["receiptOrder"] if k != key] + [key]
    for old in order[:-MAX_RECEIPTS]:
        state["receipts"].pop(old, None)
    state["receiptOrder"] = order[-MAX_RECEIPTS:]


# --------------------------------------------------------------------------
# Actuator
# --------------------------------------------------------------------------

def iso(ts):
    if ts is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


class Actuator:
    def __init__(self, config, host=None, clock=None, store=None, hostname=None):
        self.config = config
        self.limits = config["limits"]
        self.host = host or SystemHost(self.limits["unitTimeoutSec"])
        self.clock = clock or SystemClock()
        self.store = store or StateStore(config["stateDir"])
        self.hostname = hostname or socket.gethostname()

    # ---- observation -----------------------------------------------------

    def all_units(self):
        units = []
        for spec in self.config["modes"].values():
            units.extend(spec["units"])
        return units

    def observe_units(self):
        result = {}
        for mode, spec in self.config["modes"].items():
            result[mode] = {unit: self.host.unit_active(unit) for unit in spec["units"]}
        return result

    def observed_mode(self, units_by_mode):
        full = [m for m, units in units_by_mode.items() if units and all(units.values())]
        partial = [m for m, units in units_by_mode.items() if any(units.values())]
        if len(full) == 1 and partial == full:
            return full[0]
        if not partial:
            return "none"
        return "mixed"

    def read_gpus(self, required=False):
        try:
            return self.host.gpus(), None
        except ActuatorError as error:
            if required:
                raise
            return [], error.code

    def endpoint_states(self, mode):
        states = []
        for url in self.config["modes"][mode]["endpoints"]:
            version = self.host.endpoint_version(url)
            states.append({"url": url, "ready": version is not None, "version": version})
        return states

    def safety_state(self, state):
        name = self.config["safetyUnit"]
        armed = self.host.timer_active(name)
        pending = state.get("pending")
        return {
            "unit": f"{name}.timer",
            "state": "armed" if armed else ("lost" if pending else "none"),
            "deadline": (pending or {}).get("deadline"),
        }

    def confirmed_mode(self, state, units_by_mode=None):
        if state.get("confirmedMode") in self.config["modes"]:
            return state["confirmedMode"]
        if units_by_mode is not None:
            observed = self.observed_mode(units_by_mode)
            if observed in self.config["modes"]:
                return observed
        return self.config["defaultMode"]

    # ---- receipts --------------------------------------------------------

    def base_receipt(self, command, request_id):
        return {
            "schema": SCHEMA,
            "command": command,
            "requestId": request_id,
            "group": self.config["group"],
            "host": self.hostname,
            "startedAt": iso(self.clock.now()),
            "unitsStopped": [],
            "unitsStarted": [],
            "timings": {},
        }

    def finish(self, receipt, started):
        receipt["finishedAt"] = iso(self.clock.now())
        receipt["timings"]["totalMs"] = int((self.clock.monotonic() - started) * 1000)
        return receipt

    # ---- primitives ------------------------------------------------------

    def _timed(self, receipt, key, fn):
        t0 = self.clock.monotonic()
        try:
            return fn()
        finally:
            receipt["timings"][key] = int((self.clock.monotonic() - t0) * 1000)

    def stop_units(self, units, receipt):
        for unit in units:
            if self.host.unit_active(unit):
                self.host.stop_unit(unit)
                receipt["unitsStopped"].append(unit)
        still = [u for u in units if self.host.unit_active(u)]
        if still:
            raise ActuatorError("unit_still_active", ", ".join(still))

    def start_units(self, units, receipt):
        for unit in units:
            if not self.host.unit_active(unit):
                self.host.start_unit(unit)
                receipt["unitsStarted"].append(unit)

    def wait_gpus_free(self, gpu_indexes):
        if not gpu_indexes:
            return []
        threshold = self.limits["gpuFreeMiB"]
        deadline = self.clock.monotonic() + self.limits["gpuReleaseTimeoutSec"]
        while True:
            gpus = self.host.gpus()
            by_index = {g["index"]: g for g in gpus}
            missing = [i for i in gpu_indexes if i not in by_index]
            if missing:
                raise ActuatorError("gpu_missing", f"GPU {missing} not reported")
            busy = [i for i in gpu_indexes if by_index[i]["memoryUsedMiB"] > threshold]
            if not busy:
                return gpus
            if self.clock.monotonic() >= deadline:
                raise ActuatorError("gpu_not_released",
                                    f"GPU {busy} still above {threshold} MiB")
            self.clock.sleep(self.limits["pollIntervalSec"])

    def wait_ready(self, mode):
        endpoints = self.config["modes"][mode]["endpoints"]
        deadline = self.clock.monotonic() + self.limits["readyTimeoutSec"]
        while True:
            states = self.endpoint_states(mode)
            units = self.config["modes"][mode]["units"]
            dead = [u for u in units if not self.host.unit_active(u)]
            if dead:
                raise ActuatorError("unit_exited", ", ".join(dead))
            if all(s["ready"] for s in states):
                return states
            if self.clock.monotonic() >= deadline:
                late = [s["url"] for s in states if not s["ready"]]
                raise ActuatorError("endpoint_not_ready", ", ".join(late) if endpoints else "")
            self.clock.sleep(self.limits["pollIntervalSec"])

    def other_units(self, mode):
        return [u for m, spec in self.config["modes"].items() if m != mode for u in spec["units"]]

    def bring_up(self, mode, receipt, prefix=""):
        """Stop every other mode's units, wait for the GPUs, start `mode`.

        When the target is already fully running it is kept as is. A target
        that runs only in part is stopped too, so it starts on free GPUs.
        """
        target_units = self.config["modes"][mode]["units"]
        target_running = all(self.host.unit_active(u) for u in target_units)
        to_stop = self.other_units(mode) + ([] if target_running else target_units)
        self._timed(receipt, f"{prefix}stopMs", lambda: self.stop_units(to_stop, receipt))
        if not target_running:
            gpus = self._timed(receipt, f"{prefix}gpuReleaseMs",
                               lambda: self.wait_gpus_free(self.config["modes"][mode]["gpus"]))
            if gpus:
                receipt["gpusReleased"] = gpus
        self._timed(receipt, f"{prefix}startMs",
                    lambda: self.start_units(self.config["modes"][mode]["units"], receipt))
        receipt["endpoints"] = self._timed(receipt, f"{prefix}readyMs", lambda: self.wait_ready(mode))

    # ---- commands --------------------------------------------------------

    def status(self, request_id=None):
        started = self.clock.monotonic()
        state = self.store.read()
        receipt = self.base_receipt("status", request_id)
        units = self.observe_units()
        observed = self.observed_mode(units)
        gpus, gpu_error = self.read_gpus()
        receipt.update({
            "outcome": "observed",
            "observedMode": observed,
            "confirmedMode": self.confirmed_mode(state, units),
            "confirmedAt": state.get("confirmedAt"),
            "modes": {m: {"units": u, "active": bool(u) and all(u.values())} for m, u in units.items()},
            "pending": state.get("pending"),
            "safetyTimer": self.safety_state(state),
            "gpus": gpus,
            "computeApps": self.host.compute_apps(),
        })
        if gpu_error:
            receipt["gpuError"] = gpu_error
        if observed in self.config["modes"]:
            receipt["endpoints"] = self.endpoint_states(observed)
        if request_id:
            found = {k.split(":", 1)[0]: v for k, v in state["receipts"].items()
                     if k.split(":", 1)[1] == request_id}
            receipt["receipts"] = found
        return self.finish(receipt, started), EXIT_OK

    def _locked(self, fn, timeout=None):
        self.store.acquire(timeout or self.limits["lockTimeoutSec"], self.clock)
        try:
            return fn()
        finally:
            self.store.release()

    def activate(self, mode, request_id):
        if mode not in self.config["modes"]:
            raise refused("unknown_mode", "mode is not declared")
        return self._locked(lambda: self._activate(mode, request_id))

    def _activate(self, mode, request_id):
        started = self.clock.monotonic()
        state = self.store.read()
        key = f"activate:{request_id}"
        if key in state["receipts"]:
            replay = dict(state["receipts"][key])
            replay["replay"] = True
            return replay, exit_for(replay)

        receipt = self.base_receipt("activate", request_id)
        receipt["targetMode"] = mode
        pending = state.get("pending")
        if pending:
            if pending.get("requestId") == request_id:
                receipt.update({"outcome": "interrupted", "reason": "activation_interrupted",
                                "pending": pending, "safetyTimer": self.safety_state(state)})
                return self.finish(receipt, started), EXIT_UNKNOWN
            raise refused("activation_pending", "another activation awaits confirmation or rollback")

        units = self.observe_units()
        before = self.observed_mode(units)
        confirmed = self.confirmed_mode(state, units)
        receipt.update({"modeBefore": before, "confirmedModeBefore": confirmed})
        gpus_before, _ = self.read_gpus()
        receipt["gpusBefore"] = gpus_before

        if before == mode and confirmed == mode:
            receipt.update({"outcome": "already_active", "modeAfter": mode,
                            "confirmedModeAfter": mode,
                            "safetyTimer": {"unit": f"{self.config['safetyUnit']}.timer", "state": "none"},
                            "endpoints": self.endpoint_states(mode)})
            self.finish(receipt, started)
            self._save_receipt(state, key, receipt)
            return receipt, EXIT_OK

        # Arm the safety timer before anything stops.
        deadline_ts = self.clock.now() + self.limits["safetyTimeoutSec"]
        timer_argv = [self.config["executable"], "--config", self.config["configPath"],
                      "rollback", "--request-id", f"safety-{request_id}"[:120],
                      "--reason", "safety_timer", "--pending", request_id]
        self.host.arm_timer(self.config["safetyUnit"], self.limits["safetyTimeoutSec"], timer_argv)
        state["confirmedMode"] = confirmed
        state["pending"] = {"requestId": request_id, "targetMode": mode, "previousMode": confirmed,
                            "armedAt": iso(self.clock.now()), "deadline": iso(deadline_ts),
                            "stage": "armed"}
        self.store.write(state)

        try:
            self.bring_up(mode, receipt)
        except ActuatorError as error:
            receipt["error"] = {"code": error.code, "message": str(error)[:300]}
            restored = self._restore(confirmed, receipt)
            receipt["restored"] = restored
            state = self.store.read()
            if restored:
                self._disarm_quietly(receipt)
                state["pending"] = None
            else:
                state["pending"]["stage"] = "restore_failed"
            units_after = self.observe_units()
            receipt.update({
                "outcome": "failed", "reason": error.code,
                "modeAfter": self.observed_mode(units_after),
                "confirmedModeAfter": confirmed,
                "safetyTimer": self.safety_state(state),
            })
            gpus_after, _ = self.read_gpus()
            receipt["gpus"] = gpus_after
            self.finish(receipt, started)
            self._save_receipt(state, key, receipt)
            return receipt, EXIT_FAILED

        state = self.store.read()
        state["pending"]["stage"] = "awaiting_confirm"
        gpus_after, _ = self.read_gpus()
        receipt.update({
            "outcome": "activated",
            "modeAfter": self.observed_mode(self.observe_units()),
            "confirmedModeAfter": confirmed,
            "gpus": gpus_after,
            "safetyTimer": self.safety_state(state),
        })
        self.finish(receipt, started)
        self._save_receipt(state, key, receipt)
        return receipt, EXIT_OK

    def _restore(self, mode, receipt):
        restore = {"mode": mode, "unitsStopped": [], "unitsStarted": [], "timings": {}}
        try:
            self.bring_up(mode, restore, prefix="restore_")
            ok = True
        except ActuatorError as error:
            restore["error"] = {"code": error.code, "message": str(error)[:300]}
            ok = False
        receipt["restore"] = restore
        return ok

    def _disarm_quietly(self, receipt):
        try:
            self.host.disarm_timer(self.config["safetyUnit"])
        except ActuatorError as error:
            receipt.setdefault("warnings", []).append(error.code)

    def _save_receipt(self, state, key, receipt):
        remember_receipt(state, key, receipt)
        self.store.write(state)
        self.store.archive_receipt(receipt)

    def confirm(self, request_id):
        return self._locked(lambda: self._confirm(request_id))

    def _confirm(self, request_id):
        started = self.clock.monotonic()
        state = self.store.read()
        key = f"confirm:{request_id}"
        if key in state["receipts"]:
            replay = dict(state["receipts"][key])
            replay["replay"] = True
            return replay, exit_for(replay)
        pending = state.get("pending")
        if not pending:
            raise refused("nothing_pending", "no activation awaits confirmation")
        if pending.get("requestId") != request_id:
            raise refused("request_mismatch", "the pending activation has another request id")
        if pending.get("stage") != "awaiting_confirm":
            raise refused("activation_not_ready", "the pending activation has not completed")

        mode = pending["targetMode"]
        receipt = self.base_receipt("confirm", request_id)
        units = self.observe_units()
        observed = self.observed_mode(units)
        endpoints = self.endpoint_states(mode)
        receipt.update({"targetMode": mode, "modeBefore": observed,
                        "confirmedModeBefore": pending.get("previousMode"), "endpoints": endpoints})
        if observed != mode or not all(e["ready"] for e in endpoints):
            raise refused("target_not_active", "the target mode is not fully running")

        self.host.disarm_timer(self.config["safetyUnit"])
        enablement = {"enabled": [], "disabled": [], "errors": []}
        for unit in self.config["modes"][mode]["units"]:
            try:
                self.host.set_enabled(unit, True)
                enablement["enabled"].append(unit)
            except ActuatorError as error:
                enablement["errors"].append({"unit": unit, "code": error.code})
        for unit in self.other_units(mode):
            try:
                self.host.set_enabled(unit, False)
                enablement["disabled"].append(unit)
            except ActuatorError as error:
                enablement["errors"].append({"unit": unit, "code": error.code})

        state["confirmedMode"] = mode
        state["confirmedAt"] = iso(self.clock.now())
        state["pending"] = None
        gpus, _ = self.read_gpus()
        receipt.update({
            "outcome": "confirmed", "modeAfter": mode, "confirmedModeAfter": mode,
            "enablement": enablement, "gpus": gpus,
            "safetyTimer": {"unit": f"{self.config['safetyUnit']}.timer", "state": "disarmed"},
        })
        if enablement["errors"]:
            receipt.setdefault("warnings", []).append("unit_enablement_failed")
        self.finish(receipt, started)
        self._save_receipt(state, key, receipt)
        return receipt, EXIT_OK

    def rollback(self, request_id, reason="operator", pending_ref=None):
        # The safety timer must not give up because an activation still holds
        # the lock: it waits for that activation to end, however it ends.
        timeout = None if pending_ref is None else max(self.limits["lockTimeoutSec"], 900)
        return self._locked(lambda: self._rollback(request_id, reason, pending_ref), timeout)

    def _rollback(self, request_id, reason, pending_ref):
        started = self.clock.monotonic()
        state = self.store.read()
        key = f"rollback:{request_id}"
        if key in state["receipts"]:
            replay = dict(state["receipts"][key])
            replay["replay"] = True
            return replay, exit_for(replay)

        receipt = self.base_receipt("rollback", request_id)
        receipt["reason"] = reason
        pending = state.get("pending")
        if pending_ref is not None and (not pending or pending.get("requestId") != pending_ref):
            # A safety timer from an activation that was already confirmed or
            # rolled back: nothing to restore.
            receipt.update({"outcome": "noop", "detail": "stale_safety_timer"})
            self.finish(receipt, started)
            self._save_receipt(state, key, receipt)
            return receipt, EXIT_OK

        units = self.observe_units()
        before = self.observed_mode(units)
        if pending and pending.get("previousMode") in self.config["modes"]:
            target = pending["previousMode"]
        else:
            target = self.confirmed_mode(state, units)
        receipt.update({"modeBefore": before, "targetMode": target,
                        "confirmedModeBefore": target, "pendingBefore": pending})
        gpus_before, _ = self.read_gpus()
        receipt["gpusBefore"] = gpus_before

        if not pending and before == target:
            self._disarm_quietly(receipt)
            receipt.update({"outcome": "already_active", "modeAfter": target,
                            "confirmedModeAfter": target,
                            "safetyTimer": self.safety_state(state),
                            "endpoints": self.endpoint_states(target)})
            self.finish(receipt, started)
            self._save_receipt(state, key, receipt)
            return receipt, EXIT_OK

        try:
            self.bring_up(target, receipt)
        except ActuatorError as error:
            receipt["error"] = {"code": error.code, "message": str(error)[:300]}
            state = self.store.read()
            if state.get("pending"):
                state["pending"]["stage"] = "rollback_failed"
            receipt.update({"outcome": "failed", "modeAfter": self.observed_mode(self.observe_units()),
                            "confirmedModeAfter": target, "safetyTimer": self.safety_state(state)})
            self.finish(receipt, started)
            self._save_receipt(state, key, receipt)
            return receipt, EXIT_FAILED

        self._disarm_quietly(receipt)
        state = self.store.read()
        state["pending"] = None
        state["confirmedMode"] = target
        if not state.get("confirmedAt"):
            state["confirmedAt"] = iso(self.clock.now())
        gpus, _ = self.read_gpus()
        receipt.update({"outcome": "rolled_back", "modeAfter": target, "confirmedModeAfter": target,
                        "gpus": gpus, "safetyTimer": self.safety_state(state)})
        self.finish(receipt, started)
        self._save_receipt(state, key, receipt)
        return receipt, EXIT_OK


def exit_for(receipt):
    outcome = receipt.get("outcome")
    if outcome in ("activated", "already_active", "confirmed", "rolled_back", "noop", "observed"):
        return EXIT_OK
    if outcome == "refused":
        return EXIT_REFUSED
    if outcome in ("interrupted", "unknown"):
        return EXIT_UNKNOWN
    return EXIT_FAILED


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------

def parse_remote_command(text, modes):
    """Parse an SSH_ORIGINAL_COMMAND against the closed grammar.

    Returns (command, kwargs). Raises ActuatorError(usage) on anything else.
    The original text is never echoed back.
    """
    def usage(code="invalid_command"):
        return ActuatorError(code, "command refused by the actuator grammar",
                             outcome="refused", exit_code=EXIT_USAGE)

    if not isinstance(text, str) or len(text) > 512:
        raise usage()
    try:
        tokens = shlex.split(text)
    except ValueError:
        raise usage()
    if not tokens or tokens[0] not in COMMANDS:
        raise usage()
    command, rest = tokens[0], tokens[1:]
    kwargs = {}
    if command == "activate":
        if not rest or rest[0] not in modes:
            raise usage("unknown_mode")
        kwargs["mode"] = rest[0]
        rest = rest[1:]
    allowed = {"status": {"--request-id"}, "activate": {"--request-id"},
               "confirm": {"--request-id"}, "rollback": {"--request-id", "--reason"}}[command]
    while rest:
        if len(rest) < 2 or rest[0] not in allowed:
            raise usage()
        flag, value = rest[0], rest[1]
        rest = rest[2:]
        name = flag[2:].replace("-", "_")
        if name in kwargs:
            raise usage()
        if flag == "--request-id" and not REQUEST_ID_RE.match(value):
            raise usage("invalid_request_id")
        if flag == "--reason" and not REASON_RE.match(value):
            raise usage("invalid_reason")
        kwargs[name] = value
    if command != "status" and "request_id" not in kwargs:
        raise usage("request_id_required")
    return command, kwargs


def run_command(actuator, command, kwargs):
    if command == "status":
        return actuator.status(kwargs.get("request_id"))
    if command == "activate":
        return actuator.activate(kwargs["mode"], kwargs["request_id"])
    if command == "confirm":
        return actuator.confirm(kwargs["request_id"])
    if command == "rollback":
        return actuator.rollback(kwargs["request_id"], kwargs.get("reason") or "operator",
                                 kwargs.get("pending"))
    raise ActuatorError("invalid_command", outcome="refused", exit_code=EXIT_USAGE)


def error_receipt(error, command=None, request_id=None, group=None):
    return {
        "schema": SCHEMA,
        "command": command,
        "requestId": request_id,
        "group": group,
        "outcome": error.outcome,
        "reason": error.code,
        "message": str(error)[:300],
        "finishedAt": iso(time.time()),
    }


def build_parser():
    parser = argparse.ArgumentParser(prog="agentx-topology-actuator")
    parser.add_argument("--config", default=DEFAULT_CONFIG_PATH)
    sub = parser.add_subparsers(dest="command", required=True)
    status = sub.add_parser("status")
    status.add_argument("--request-id")
    activate = sub.add_parser("activate")
    activate.add_argument("mode")
    activate.add_argument("--request-id", required=True)
    confirm = sub.add_parser("confirm")
    confirm.add_argument("--request-id", required=True)
    rollback = sub.add_parser("rollback")
    rollback.add_argument("--request-id", required=True)
    rollback.add_argument("--reason", default="operator")
    rollback.add_argument("--pending", help=argparse.SUPPRESS)
    ssh = sub.add_parser("ssh", help="forced-command entry; reads SSH_ORIGINAL_COMMAND")
    ssh.add_argument("original", nargs="?", help="the original command, when a wrapper passes it")
    return parser


def emit(receipt):
    try:
        sys.stdout.write(json.dumps(receipt, sort_keys=True) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        pass


def main(argv=None, environ=None, actuator_factory=None):
    environ = os.environ if environ is None else environ
    args = build_parser().parse_args(argv)
    command = args.command
    kwargs = {}
    group = None
    try:
        config = load_config(args.config)
        group = config["group"]
        if command == "ssh":
            # A dropped connection must not kill a switch half-way: the result
            # is persisted and can be read back with `status --request-id`.
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
            signal.signal(signal.SIGPIPE, signal.SIG_IGN)
            original = args.original if args.original is not None else environ.get("SSH_ORIGINAL_COMMAND", "")
            command, kwargs = parse_remote_command(original, config["modes"])
        else:
            for name in ("mode", "request_id", "reason", "pending"):
                value = getattr(args, name, None)
                if value is not None:
                    kwargs[name] = value
            if "request_id" in kwargs and not REQUEST_ID_RE.match(kwargs["request_id"]):
                raise ActuatorError("invalid_request_id", outcome="refused", exit_code=EXIT_USAGE)
            if "pending" in kwargs and not REQUEST_ID_RE.match(kwargs["pending"]):
                raise ActuatorError("invalid_request_id", outcome="refused", exit_code=EXIT_USAGE)
            if "reason" in kwargs and not REASON_RE.match(kwargs["reason"]):
                raise ActuatorError("invalid_reason", outcome="refused", exit_code=EXIT_USAGE)
        actuator = (actuator_factory or Actuator)(config)
        receipt, code = run_command(actuator, command, kwargs)
    except ActuatorError as error:
        receipt = error_receipt(error, command if command != "ssh" else None,
                                kwargs.get("request_id"), group)
        code = error.exit_code
    emit(receipt)
    return code


if __name__ == "__main__":
    sys.exit(main())
