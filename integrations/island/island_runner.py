#!/usr/bin/env python3
"""Island runner: one Clawblox agent alone on an island, on this host.

The heavy-work queue CLI (integrations/operations/island-executor.cjs) drives
this file locally or over SSH. Every answer is one JSON line with contract
agentx.island-runner/v1. Nothing here talks to Core's queue: the CLI owns the
dispatch fence and the receipt. This file only starts, watches and stops runs.

Actions:
  check                      configuration and busy state, no side effect
  start  --run-id ID ...     create the run directory and start its supervisor
  status --run-id ID         read the run's state (never starts anything)
  stop   --run-id ID         ask the supervisor to stop the run early
  memory --run-id ID         the agent's memory files after (or during) the run
  supervise --run-id ID      internal: the detached process that runs the world

A run directory is created once. Starting an existing run id refuses, so a
lost answer is resolved with `status`, never by starting again.

The agent is the Codex CLI driven by Clawblox. It thinks through Core's
OpenAI-compatible gateway with the principal alias, never a concrete model.
`start --netcheck` replaces Codex by a probe that checks the sandbox; it
invokes no model.
"""
from __future__ import annotations

import argparse
import fcntl
import datetime as dt
import json
import os
import re
import shutil
import signal
import subprocess
import sys
from pathlib import Path

import run_island as episode
from run_state import MEMORY, atomic_json, copy_memory_files

CONTRACT = "agentx.island-runner/v1"
PRINCIPAL_ALIAS = "agentx-primary"
HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = Path.home() / ".config" / "agentx" / "island-runner.json"
RUN_ID = re.compile(r"^[a-f0-9-]{36}$")
NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")
WORLD = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MEMORY_FILES = ("SOUL.md", "EPISODIC_MEMORY.jsonl", "SEMANTIC_MEMORY.md")
TEMPLATE_FILES = ("SOUL.md", "EPISODIC_MEMORY.md", "SEMANTIC_MEMORY.md")
MAX_MEMORY_BYTES = 256 * 1024
AGENT_MESSAGES = 40          # latest entries reported with each status
AGENT_TEXT = 600             # characters kept per entry
AGENT_TAIL_BYTES = 512 * 1024
# Long opaque runs (keys, capabilities, digests) are elided from what leaves the runner.
OPAQUE = re.compile(r"[A-Za-z0-9_\-+/=]{40,}")
DEFAULTS = {
    "worldPort": 18080,
    "gatewayGuestPort": 8443,
    "memoryWarningMinutes": 5,
    "stallAfterTurnSeconds": 90,
    "stallIdleSeconds": 900,
    "minNudgeIntervalSeconds": 120,
    "maxNudges": 30,
    "episodeMinutes": 60,
    "netcheckBlocked": [],
}


# A Unix socket path holds at most 107 bytes (sun_path is 108 with its NUL).
# Clawblox puts the agent's network relays at
# <runsRoot>/<run id>/agents/<agent>/runtime/netrelay/allow-<n>.sock, so a
# long runsRoot makes every run fail at start with "required network relays
# unavailable". Check it before the queue spends a slot.
SOCKET_PATH_MAX = 107


def relay_socket_problem(config: dict, agent: str) -> str | None:
    sample = runs_root(config) / ("0" * 36) / "agents" / agent.lower() / "runtime" / "netrelay" / "allow-99.sock"
    length = len(os.fsencode(str(sample)))
    if length <= SOCKET_PATH_MAX:
        return None
    return (f"runsRoot is too long for the agent's relay sockets: {length} bytes for {agent}, "
            f"limit {SOCKET_PATH_MAX}; shorten runsRoot by {length - SOCKET_PATH_MAX} characters")


class RunnerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def write_json(path: Path, value) -> None:
    atomic_json(path, value)


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


# ── configuration ────────────────────────────────────────────────────────────

def load_config(path: Path | None) -> dict:
    path = Path(path or os.environ.get("AGENTX_ISLAND_RUNNER_CONFIG") or DEFAULT_CONFIG)
    raw = read_json(path)
    if not isinstance(raw, dict):
        raise RunnerError("RUNNER_CONFIG", f"runner configuration missing or unreadable: {path}")
    config = {**DEFAULTS, **raw, "configPath": str(path)}
    for key in ("runsRoot", "worldsRoot"):
        if not config.get(key):
            raise RunnerError("RUNNER_CONFIG", f"runner configuration needs {key}")
    return config


def runs_root(config: dict) -> Path:
    return Path(config["runsRoot"]).expanduser()


def run_dir(config: dict, run_id: str) -> Path:
    if not RUN_ID.match(run_id or ""):
        raise RunnerError("RUN_ID", "run id needs the queue request UUID")
    return runs_root(config) / run_id


def templates_dir(config: dict) -> Path:
    return Path(config.get("templatesDir") or HERE / "agent").expanduser()


def memory_store(config: dict, agent: str) -> Path:
    return runs_root(config) / "memory" / agent.lower()


# ── pure helpers (unit tested) ───────────────────────────────────────────────

def render_system_prompt(template: str, agent: str) -> str:
    # Clawblox does not expand placeholders in a custom system prompt.
    return template.replace("${WORLD_AGENT_NAME}", agent).replace("${WORKSPACE_DIR}", "/workspace")


def codex_provider_args(gateway_host: str, guest_port: int, context_window: int) -> list[str]:
    # The hostname is not exposed to the sandbox; it reaches only the local capability.
    return episode.codex_args(guest_port, context_window)


def spectator_path(world_log: Path) -> dict | None:
    """The live spectator link Clawblox prints in its log, as port and path."""
    try:
        text = world_log.read_text(errors="replace")
    except FileNotFoundError:
        return None
    match = re.search(r"Spectator frontend: https?://[^/\s:]+:(\d+)(/\S*)", text)
    if not match:
        return None
    return {"port": int(match.group(1)), "path": match.group(2)}


def seed_workspace(workspace: Path, templates: Path, store: Path, memory: str) -> str:
    source = store if memory == "continue" and store.is_dir() and any(store.iterdir()) else templates
    copy_memory_files(source, workspace, require_all=source == store)
    return "previous-run" if source == store else "template"


def save_memory(workspace: Path, store: Path) -> dict:
    """Persist the four memory files only, never tools, sessions or credentials."""
    store.parent.mkdir(parents=True, exist_ok=True)
    staging = store.with_name(store.name + ".incoming")
    old = store.with_name(store.name + ".previous")
    shutil.rmtree(staging, ignore_errors=True)
    copy_memory_files(workspace, staging)
    size = sum((staging / name).stat().st_size for name in MEMORY)
    shutil.rmtree(old, ignore_errors=True)
    if store.exists(): os.replace(store, old)
    os.replace(staging, store)
    shutil.rmtree(old, ignore_errors=True)
    return {"saved": True, "bytes": size}


def memory_snapshot(workspace: Path) -> dict:
    files = {}
    for name in MEMORY_FILES:
        path = workspace / name
        if path.is_symlink() or not path.is_file():
            files[name] = None
            continue
        data = path.read_bytes()
        files[name] = {"bytes": len(data), "truncated": len(data) > MAX_MEMORY_BYTES,
                       "text": data[-MAX_MEMORY_BYTES:].decode("utf-8", errors="replace")}
    return files


def pid_alive(pid, run_id: str) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
    except OSError:
        return False
    return "supervise" in cmdline and run_id in cmdline


def leftover_processes(run: Path) -> list[int]:
    # Agent, sandbox and world processes carry the run directory in their command line.
    result = subprocess.run(["pgrep", "-f", "--", re.escape(str(run)) + "/"], capture_output=True, text=True, timeout=10)
    if result.returncode not in (0, 1) or (result.returncode == 1 and result.stdout.strip()):
        raise RunnerError("PROCESS_OBSERVATION", "process termination observation failed")
    out = result.stdout.split()
    return sorted(int(pid) for pid in out if pid.isdigit() and int(pid) != os.getpid())


# ── actions ──────────────────────────────────────────────────────────────────

def active_run(config: dict) -> str | None:
    marker = read_json(runs_root(config) / "active.json") or {}
    run_id = marker.get("runId")
    if run_id and RUN_ID.match(run_id):
        state = read_json(runs_root(config) / run_id / "state.json") or {}
        if pid_alive(state.get("pid"), run_id) or state.get("localStopped") is not True:
            return run_id
    return None


def action_check(config: dict, _args) -> dict:
    problems = []
    if not runs_root(config).is_dir():
        problems.append(f"runsRoot does not exist: {runs_root(config)}")
    if not Path(config["worldsRoot"]).expanduser().is_dir():
        problems.append("worldsRoot does not exist")
    for name in (*TEMPLATE_FILES, "SYSTEM_PROMPT.md"):
        if not (templates_dir(config) / name).is_file():
            problems.append(f"agent template missing: {name}")
    for key in ("codex", "tokenFile"):
        if not config.get(key) or not Path(config[key]).expanduser().is_file():
            problems.append(f"{key} missing")
    if not config.get("gatewayHost") and not config.get("gatewayBaseUrl"):
        problems.append("gatewayHost missing")
    socket_problem = relay_socket_problem(config, getattr(_args, "agent", None) or "Eko")
    if socket_problem:
        problems.append(socket_problem)
    try:
        import clawblox
        if getattr(clawblox, "agentx_isolation_version", lambda: 0)() != 1:
            problems.append("Clawblox isolation patch v1 required")
    except ImportError:
        problems.append("the clawblox Python module is not importable by this interpreter")
    return {"ready": not problems, "problems": problems, "activeRun": active_run(config),
            "worldPort": config["worldPort"], "model": PRINCIPAL_ALIAS}


def action_start(config: dict, args) -> dict:
    runs_root(config).mkdir(parents=True, exist_ok=True)
    with open(runs_root(config) / "runner.lock", "a") as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise RunnerError("RUNNER_BUSY", "runner start is already being coordinated")
        return start_locked(config, args)


def start_locked(config: dict, args) -> dict:
    if not NAME.match(args.agent or ""):
        raise RunnerError("INVALID", "agent needs a short name")
    if not WORLD.match(args.world or ""):
        raise RunnerError("INVALID", "world needs a world directory name")
    if args.memory not in ("continue", "fresh"):
        raise RunnerError("INVALID", "memory needs continue or fresh")
    if not (5 <= args.minutes <= 720) and not args.netcheck:
        raise RunnerError("INVALID", "minutes needs 5 to 720")
    if not args.netcheck and not (args.context_window and args.context_window > 0):
        raise RunnerError("INVALID", "a real run needs the principal context window")
    if not (Path(config["worldsRoot"]).expanduser() / args.world).is_dir():
        raise RunnerError("INVALID", f"world {args.world} is not installed on this runner")
    socket_problem = relay_socket_problem(config, args.agent)
    if socket_problem:
        raise RunnerError("RUNS_ROOT_TOO_LONG", socket_problem)
    run = run_dir(config, args.run_id)
    busy = active_run(config)
    if busy:
        raise RunnerError("RUNNER_BUSY", f"run {busy} is still active on this runner")
    runs_root(config).mkdir(parents=True, exist_ok=True)
    try:
        run.mkdir()
    except FileExistsError:
        raise RunnerError("RUN_EXISTS", "this run id already exists; read its status, never start it again")
    request = {"runId": args.run_id, "dispatchId": args.dispatch_id, "agent": args.agent,
               "minutes": args.minutes, "memory": args.memory, "world": args.world,
               "contextWindow": args.context_window, "netcheck": bool(args.netcheck), "requestedAt": now_iso()}
    write_json(run / "request.json", request)
    state = {"runId": args.run_id, "dispatchId": args.dispatch_id, "phase": "starting", "events": [],
             "requestedAt": request["requestedAt"], "timeZone": config.get("timeZone")}
    write_json(run / "state.json", state)
    with open(run / "supervisor.log", "ab") as log:
        child = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "supervise", "--run-id", args.run_id,
             "--config", config["configPath"]],
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    state["pid"] = child.pid
    write_json(run / "state.json", state)
    write_json(runs_root(config) / "active.json", {"runId": args.run_id, "since": request["requestedAt"]})
    return {"runId": args.run_id, "dispatchId": args.dispatch_id, "phase": "starting", "pid": child.pid}


def agent_messages(run: Path, agent: str | None, limit: int = AGENT_MESSAGES) -> list[dict]:
    """The agent's latest thoughts, words and commands from its newest Codex session.

    Read-only and bounded (the file's tail, `limit` entries, `AGENT_TEXT` characters each).
    The text is the agent's own output: untrusted, shown escaped, never acted upon.
    """
    if not agent or not NAME.match(agent):
        return []
    sessions = run / "agents" / agent.lower() / "sandbox-home" / ".codex" / "sessions"
    try:
        files = [p for p in sessions.rglob("*.jsonl") if p.is_file() and not p.is_symlink()] if sessions.is_dir() else []
        if not files:
            return []
        newest = max(files, key=lambda p: p.stat().st_mtime)
        with open(newest, "rb") as stream:
            stream.seek(0, os.SEEK_END)
            stream.seek(max(0, stream.tell() - AGENT_TAIL_BYTES))
            lines = stream.read().splitlines()
    except OSError:
        return []
    found = []
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue  # the first line of a tail is usually cut
        if not isinstance(record, dict) or record.get("type") != "response_item":
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        kind, text = None, ""
        if payload.get("type") == "reasoning":
            kind = "thought"
            text = " ".join(part.get("text", "") for part in payload.get("summary") or [] if isinstance(part, dict))
        elif payload.get("type") == "message" and payload.get("role") == "assistant":
            kind = "say"
            text = " ".join(part.get("text", "") for part in payload.get("content") or [] if isinstance(part, dict))
        elif payload.get("type") == "function_call":
            kind = "command"
            try:
                args = json.loads(payload.get("arguments") or "{}")
            except (TypeError, ValueError):
                args = {}
            command = args.get("cmd") or args.get("command") if isinstance(args, dict) else None
            text = " ".join(map(str, command)) if isinstance(command, list) else str(command or payload.get("name") or "")
        if not kind:
            continue
        text = OPAQUE.sub("…", " ".join(str(text).split()))[:AGENT_TEXT]
        if text:
            found.append({"at": str(record.get("timestamp") or "")[:40], "kind": kind, "text": text})
    return found[-limit:]


def describe(config: dict, run_id: str) -> dict:
    run = run_dir(config, run_id)
    if not run.is_dir():
        raise RunnerError("RUN_NOT_FOUND", "no run with this id on this runner")
    state = read_json(run / "state.json", {}) or {}
    request = read_json(run / "request.json", {}) or {}
    alive = pid_alive(state.get("pid"), run_id)
    phase = state.get("phase") or "starting"
    if phase != "finished" and not alive:
        phase = "interrupted"  # the supervisor died; nothing restarts it
    recordings = sorted((run / "recordings").glob("*.clawrec")) if (run / "recordings").is_dir() else []
    events = state.get("events") or []
    process_ok, leftover = True, []
    if phase in ("finished", "interrupted"):
        try: leftover = leftover_processes(run)
        except RunnerError: process_ok, leftover = False, None
    return {
        "runId": run_id, "dispatchId": request.get("dispatchId"), "agent": request.get("agent"),
        "minutes": request.get("minutes"), "memory": request.get("memory"), "world": request.get("world"),
        "netcheck": request.get("netcheck", False), "model": "netcheck" if request.get("netcheck") else PRINCIPAL_ALIAS,
        "phase": phase, "terminal": phase in ("finished", "interrupted"), "alive": alive,
        "outcome": state.get("outcome"), "requestedAt": request.get("requestedAt"),
        "startedAt": state.get("startedAt"), "endedAt": state.get("endedAt"), "timeZone": state.get("timeZone"),
        "events": events[-200:], "resumeCount": sum(1 for e in events if e.get("event") == "resumed"),
        "memorySource": state.get("memorySource"), "memorySaved": state.get("memorySaved"),
        "liveView": state.get("liveView") if phase == "running" else None,
        "recording": str(recordings[-1].relative_to(runs_root(config))) if recordings else None,
        "leftover": leftover, "processObservationOk": process_ok, "localStopped": state.get("localStopped") is True,
        "agentMessages": agent_messages(run, request.get("agent")),
    }


def action_status(config: dict, args) -> dict:
    return describe(config, args.run_id)


def action_stop(config: dict, args) -> dict:
    run = run_dir(config, args.run_id)
    state = read_json(run / "state.json", {}) or {}
    if not pid_alive(state.get("pid"), args.run_id):
        return {"runId": args.run_id, "signalled": False, "reason": "supervisor is not running"}
    os.kill(state["pid"], signal.SIGTERM)
    return {"runId": args.run_id, "signalled": True}


def action_memory(config: dict, args) -> dict:
    run = run_dir(config, args.run_id)
    request = read_json(run / "request.json")
    if not request:
        raise RunnerError("RUN_NOT_FOUND", "no run with this id on this runner")
    after = run / "memory-after"
    workspace = after if after.is_dir() else run / "agents" / request["agent"].lower() / "workspace"
    return {"runId": args.run_id, "agent": request["agent"], "final": after.is_dir(), "files": memory_snapshot(workspace)}


# ── the detached supervisor (port of work/island/run_eko.py) ─────────────────

def action_supervise(config: dict, args) -> dict:
    run = run_dir(config, args.run_id)
    request = read_json(run / "request.json")
    state = read_json(run / "state.json", {}) or {}
    state.update(pid=os.getpid(), phase="starting")
    events = state.setdefault("events", [])
    workspace = run / "agents" / request["agent"].lower() / "workspace"
    store = memory_store(config, request["agent"])
    templates = templates_dir(config)

    def save(): write_json(run / "state.json", state)

    def event(kind, detail):
        events.append({"at": now_iso(), "event": kind, **detail})
        if kind == "running":
            state.update(phase="running", startedAt=now_iso(), liveView=spectator_path(run / "world.log"))
        save()

    receipt = {"outcome": "failed", "localStopped": False}
    try:
        state["memorySource"] = seed_workspace(workspace, templates, store, request["memory"])
        save()
        if config.get("clawbloxBin"):
            os.environ["PATH"] = str(Path(config["clawbloxBin"]).expanduser()) + os.pathsep + os.environ.get("PATH", "")
        a = episode.parser().parse_args(["--run-dir", str(run), "--templates-dir", str(templates),
                                        "--world-dir", str(Path(config["worldsRoot"]).expanduser() / request["world"])])
        a.name, a.minutes, a.netcheck = request["agent"], float(request["minutes"]), request["netcheck"]
        a.port, a.gateway_guest_port = int(config["worldPort"]), int(config["gatewayGuestPort"])
        a.gateway_base_url = config.get("gatewayBaseUrl") or "https://" + config.get("gatewayHost", "") + "/api/llm/v1"
        a.token_file = Path(config["tokenFile"]).expanduser() if config.get("tokenFile") else None
        a.codex = Path(config["codex"]).expanduser() if config.get("codex") else None
        a.context_window = request.get("contextWindow")
        for field, key in [("memory_warning_minutes", "memoryWarningMinutes"), ("startup_seconds", "startupSeconds"),
                           ("stall_after_turn_seconds", "stallAfterTurnSeconds"), ("stall_idle_seconds", "stallIdleSeconds"),
                           ("min_nudge_interval_seconds", "minNudgeIntervalSeconds"), ("max_nudges", "maxNudges")]:
            setattr(a, field, config.get(key, getattr(a, field)))
        a.netcheck_blocked_url = config.get("netcheckBlocked") or []
        a.episode_minutes = float(config["episodeMinutes"])
        episode.execute(a, prepared_workspace=workspace, on_event=event)
        receipt = read_json(run / "receipt.json") or receipt
    except Exception as error:
        receipt.update(outcome="failed", error=str(error))
    if receipt.get("error"): event("failed", {"error": receipt["error"]})
    if receipt.get("localStopped") is True and workspace.is_dir():
        try:
            copy_memory_files(workspace, run / "memory-after")
            if request["memory"] == "continue" and not request["netcheck"]:
                state["memorySaved"] = save_memory(workspace, store)
        except Exception as error:
            receipt["outcome"] = "failed"
            event("memory-save-failed", {"error": str(error)})
    state.update(phase="finished", outcome=receipt["outcome"], endedAt=now_iso(), liveView=None,
                 localStopped=receipt.get("localStopped") is True, activityObserved=receipt.get("activityObserved") is True)
    save()
    marker = read_json(runs_root(config) / "active.json") or {}
    if marker.get("runId") == args.run_id and state["localStopped"]:
        (runs_root(config) / "active.json").unlink(missing_ok=True)
    return {"runId": args.run_id, "outcome": state["outcome"]}


ACTIONS = {"check": action_check, "start": action_start, "status": action_status, "stop": action_stop,
           "memory": action_memory, "supervise": action_supervise}


def parse(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("action", choices=sorted(ACTIONS))
    p.add_argument("--config", type=Path)
    p.add_argument("--run-id")
    p.add_argument("--dispatch-id")
    p.add_argument("--agent", default="Eko")
    p.add_argument("--minutes", type=int, default=60)
    p.add_argument("--memory", default="continue")
    p.add_argument("--world", default="mesa-island")
    p.add_argument("--context-window", type=int)
    p.add_argument("--netcheck", action="store_true", help="replace Codex by the sandbox probe; no inference")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse(sys.argv[1:] if argv is None else argv)
    try:
        config = load_config(args.config)
        if args.action not in ("check",) and not RUN_ID.match(args.run_id or ""):
            raise RunnerError("RUN_ID", "run id needs the queue request UUID")
        if args.action == "start" and not args.netcheck and not RUN_ID.match(args.dispatch_id or ""):
            raise RunnerError("INVALID", "a real run needs the queue dispatch id")
        data = ACTIONS[args.action](config, args)
        if args.action != "supervise":
            print(json.dumps({"contract": CONTRACT, "ok": True, "data": data}))
        return 0
    except RunnerError as err:
        print(json.dumps({"contract": CONTRACT, "ok": False, "code": err.code, "message": str(err)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
