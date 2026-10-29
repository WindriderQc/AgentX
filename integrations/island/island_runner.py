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
import datetime as dt
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

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
MAX_WORKSPACE_BYTES = 64 * 1024 * 1024
CONTINUE_PROMPT = "Please don't stop. Just continue doing whatever you want to do."
MEMORY_REMINDER = ("This session ends in a few minutes. Update your memory files now "
                   "so the future you remembers what happened and what you learned.")
DEFAULTS = {
    "worldPort": 18080,
    "gatewayGuestPort": 8443,
    "memoryWarningMinutes": 5,
    "stallAfterTurnSeconds": 90,
    "stallIdleSeconds": 900,
    "minNudgeIntervalSeconds": 120,
    "maxNudges": 30,
    "netcheckBlocked": [],
}


class RunnerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def write_json(path: Path, value) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(tmp, path)


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
    base_url = f"https://{gateway_host}:{guest_port}/api/llm/v1"
    return [
        "-c", 'model_provider="agentx"',
        "-c", 'model_providers.agentx.name="AgentX"',
        "-c", f'model_providers.agentx.base_url="{base_url}"',
        "-c", 'model_providers.agentx.wire_api="responses"',
        "-c", 'model_providers.agentx.env_key="AGENTX_LLM_CODEX_TOKEN"',
        "-c", f"model_context_window={context_window}",
        "-c", f"model_auto_compact_token_limit={int(context_window * 0.9)}",
    ]


def stall_reason(sessions: Path, after_turn_seconds: float, idle_seconds: float, now: float | None = None) -> str | None:
    """Why the agent looks stuck, from its newest Codex rollout, or None.

    A finished turn normally triggers Clawblox's Stop hook within seconds. A
    turn that ended in error (an output-token cutoff, for example) does not,
    so the TUI just sits idle. Also catch a session with no activity at all.
    """
    rollouts = sorted(sessions.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime) if sessions.is_dir() else []
    if not rollouts:
        return None
    newest = rollouts[-1]
    age = (now or time.time()) - newest.stat().st_mtime
    last = {}
    with open(newest, "rb") as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - 65536))
        lines = [line for line in f.read().splitlines() if line.strip()]
    if lines:
        try:
            last = json.loads(lines[-1])
        except json.JSONDecodeError:
            last = {}
    payload = last.get("payload") or {}
    if payload.get("type") == "task_complete" and age >= after_turn_seconds:
        error = (payload.get("error") or {}).get("message")
        return f"turn ended without continuing ({error})" if error else "turn ended without continuing"
    if age >= idle_seconds:
        return f"no activity for {int(age)} s"
    return None


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


def workspace_bytes(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file() and not p.is_symlink())


def seed_workspace(workspace: Path, templates: Path, store: Path, memory: str) -> str:
    """Fill a new workspace; returns where the memory came from."""
    workspace.parent.mkdir(parents=True, exist_ok=True)
    source = "template"
    if memory == "continue" and store.is_dir() and any(store.iterdir()):
        shutil.copytree(store, workspace, symlinks=False)
        source = "previous-run"
    workspace.mkdir(parents=True, exist_ok=True)
    for name in TEMPLATE_FILES:
        target = workspace / name
        if name == "SOUL.md" and target.exists():
            target.chmod(0o644)
            target.unlink()  # the soul always comes from the template
        if not target.exists():
            shutil.copy2(templates / name, target)
    (workspace / "EPISODIC_MEMORY.jsonl").touch(exist_ok=True)
    os.chmod(workspace / "SOUL.md", 0o444)
    return source


def save_memory(workspace: Path, store: Path) -> dict:
    """Copy the workspace back to the agent's store, replacing it whole."""
    size = workspace_bytes(workspace)
    if size > MAX_WORKSPACE_BYTES:
        return {"saved": False, "reason": f"workspace is {size} bytes, above {MAX_WORKSPACE_BYTES}"}
    store.parent.mkdir(parents=True, exist_ok=True)
    staging = store.with_name(store.name + ".incoming")
    old = store.with_name(store.name + ".previous")
    shutil.rmtree(staging, ignore_errors=True)
    shutil.copytree(workspace, staging, symlinks=False)
    shutil.rmtree(old, ignore_errors=True)
    if store.exists():
        os.replace(store, old)
    os.replace(staging, store)
    shutil.rmtree(old, ignore_errors=True)
    return {"saved": True, "bytes": size}


def memory_snapshot(workspace: Path) -> dict:
    files = {}
    for name in MEMORY_FILES:
        path = workspace / name
        if not path.is_file():
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
    out = subprocess.run(["pgrep", "-f", str(run) + "/"], capture_output=True, text=True).stdout.split()
    return sorted(int(pid) for pid in out if pid.isdigit() and int(pid) != os.getpid())


# ── actions ──────────────────────────────────────────────────────────────────

def active_run(config: dict) -> str | None:
    marker = read_json(runs_root(config) / "active.json") or {}
    run_id = marker.get("runId")
    if run_id and RUN_ID.match(run_id):
        state = read_json(runs_root(config) / run_id / "state.json") or {}
        if pid_alive(state.get("pid"), run_id):
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
    if not config.get("gatewayHost"):
        problems.append("gatewayHost missing")
    try:
        import clawblox  # noqa: F401
    except ImportError:
        problems.append("the clawblox Python module is not importable by this interpreter")
    return {"ready": not problems, "problems": problems, "activeRun": active_run(config),
            "worldPort": config["worldPort"], "model": PRINCIPAL_ALIAS}


def action_start(config: dict, args) -> dict:
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
    log = open(run / "supervisor.log", "ab")
    child = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "supervise", "--run-id", args.run_id,
         "--config", config["configPath"]],
        stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    state["pid"] = child.pid
    write_json(run / "state.json", state)
    write_json(runs_root(config) / "active.json", {"runId": args.run_id, "since": request["requestedAt"]})
    return {"runId": args.run_id, "dispatchId": args.dispatch_id, "phase": "starting", "pid": child.pid}


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
        "leftover": leftover_processes(run) if phase in ("finished", "interrupted") else [],
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

    def save():
        write_json(run / "state.json", state)

    def note(kind: str, **detail):
        events.append({"at": now_iso(), "event": kind, **detail})
        save()
        print(f"{now_iso()} {kind} {detail}", flush=True)

    stopping = False

    def request_stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    agent_name = request["agent"]
    agent_dir = run / "agents" / agent_name.lower()
    workspace = agent_dir / "workspace"
    store = memory_store(config, agent_name)
    templates = templates_dir(config)
    state["memorySource"] = seed_workspace(workspace, templates, store, request["memory"])
    save()

    # Clawblox copies ~/.codex/auth.json into the agent home. Give it an empty
    # HOME so the owner's OpenAI login never enters the sandbox.
    runner_home = str(Path.home())
    host_home = run / "host-home"
    host_home.mkdir(exist_ok=True)
    os.environ["HOME"] = str(host_home)
    os.environ.pop("CODEX_HOME", None)
    if config.get("clawbloxBin"):
        os.environ["PATH"] = str(Path(config["clawbloxBin"]).expanduser()) + os.pathsep + os.environ.get("PATH", "")

    from clawblox import Agent, World  # imported after HOME is set

    gateway_host = config.get("gatewayHost", "")
    guest_port = int(config["gatewayGuestPort"])
    agent_env = {"CLAWBLOX_NET_ALLOW": f"{gateway_host}:443@{guest_port}"}
    if request["netcheck"]:
        binary = HERE / "netcheck_probe.js"
        model = "netcheck"
        extra_args: list[str] = []
        agent_env.update(AGENTX_LLM_CODEX_TOKEN="netcheck-no-token",
                         NETCHECK_GATEWAY=f"https://{gateway_host}:{guest_port}/api/llm/v1/models",
                         NETCHECK_GATEWAY_DIRECT=f"https://{gateway_host}/api/llm/v1/models",
                         NETCHECK_BLOCKED=" ".join(config.get("netcheckBlocked") or []),
                         NETCHECK_HOST_HOME=runner_home)
    else:
        binary = Path(config["codex"]).expanduser().resolve()
        model = PRINCIPAL_ALIAS
        extra_args = codex_provider_args(gateway_host, guest_port, int(request["contextWindow"]))
        agent_env["AGENTX_LLM_CODEX_TOKEN"] = Path(config["tokenFile"]).expanduser().read_text().strip()

    world = World(dir=str(Path(config["worldsRoot"]).expanduser() / request["world"]))
    agent = Agent(agent="codex", name=agent_name, dir=agent_dir, model=model, binary=binary,
                  sandbox=True, extra_args=extra_args, auto_continue_prompt=CONTINUE_PROMPT)

    def resume_with(prompt: str, reason: str) -> bool:
        # Clawblox's send resumes the saved Codex session in a new process. It
        # needs the agent stopped first: stopping also records the session id.
        try:
            agent.stop(grace_seconds=20)
            agent.send(prompt=prompt, env=agent_env)
            note("resumed", reason=reason)
            return True
        except Exception as err:  # noted, the run goes on
            note("resume-failed", reason=reason, error=str(err)[:500])
            return False

    outcome = "completed"
    try:
        world.start(port=int(config["worldPort"]), record=True, record_dir=run / "recordings", log_file=run / "world.log")
        world.connect(agent=agent)
        agent.start(initial_prompt="Begin.",
                    system_prompt=render_system_prompt((templates / "SYSTEM_PROMPT.md").read_text(), agent_name),
                    env=agent_env)
        state.update(phase="running", startedAt=now_iso(), liveView=spectator_path(run / "world.log"))
        note("started", model=model)
        sessions = agent_dir / "sandbox-home" / ".codex" / "sessions"
        deadline = time.monotonic() + float(request["minutes"]) * 60
        warn_at = deadline - float(config["memoryWarningMinutes"]) * 60
        warned = False
        last_nudge = time.monotonic()
        nudges = 0
        while not stopping and time.monotonic() < deadline:
            if not state.get("liveView"):
                state["liveView"] = spectator_path(run / "world.log")
            if not warned and time.monotonic() >= warn_at:
                warned = True
                resume_with(MEMORY_REMINDER, "memory-reminder")
                last_nudge = time.monotonic()
            elif (time.monotonic() - last_nudge >= float(config["minNudgeIntervalSeconds"])
                  and nudges < int(config["maxNudges"])):
                reason = stall_reason(sessions, float(config["stallAfterTurnSeconds"]), float(config["stallIdleSeconds"]))
                if reason:
                    nudges += 1
                    last_nudge = time.monotonic()
                    resume_with(CONTINUE_PROMPT, reason)
            time.sleep(5)
        if stopping:
            outcome = "stopped"
    except Exception as err:  # keep the state honest
        outcome = f"failed: {str(err)[:500]}"
    finally:
        state["phase"] = "stopping"
        save()
        try:
            agent.stop(grace_seconds=20)
        except Exception as err:
            note("agent-stop-failed", error=str(err)[:500])
        try:
            world.stop(grace_seconds=10)
        except Exception as err:
            note("world-stop-failed", error=str(err)[:500])
        try:
            if workspace.is_dir():
                after = run / "memory-after"
                shutil.rmtree(after, ignore_errors=True)
                after.mkdir()
                for name in MEMORY_FILES:
                    if (workspace / name).is_file():
                        shutil.copy2(workspace / name, after / name)
                # A fresh agent leaves the played agent's memory untouched.
                if request["memory"] == "continue" and not request["netcheck"]:
                    state["memorySaved"] = save_memory(workspace, store)
        except Exception as err:
            note("memory-save-failed", error=str(err)[:500])
        state.update(phase="finished", outcome=outcome, endedAt=now_iso(), liveView=None)
        save()
        marker = read_json(runs_root(config) / "active.json") or {}
        if marker.get("runId") == args.run_id:
            (runs_root(config) / "active.json").unlink(missing_ok=True)
    return {"runId": args.run_id, "outcome": outcome}


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
