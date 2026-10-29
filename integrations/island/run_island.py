#!/usr/bin/env python3
"""Run one explicitly queued island episode. No model is invoked by --netcheck."""
from __future__ import annotations

import argparse
import datetime as dt
import importlib
import math
import re
import signal
import sys
import time
from pathlib import Path

from llm_proxy import LLMProxy, MODEL
from run_state import atomic_json, latest_activity, netcheck_result, pane_alive, seed_workspace

CONTINUE = "Please don't stop. Just continue doing whatever you want to do."
KIT = Path(__file__).resolve().parent


def stamp(): return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def codex_args(port, context):
    return ["-c", 'model_provider="agentx"', "-c", 'model_providers.agentx.name="AgentX"',
            "-c", f'model_providers.agentx.base_url="http://127.0.0.1:{port}/api/llm/v1"',
            "-c", 'model_providers.agentx.wire_api="responses"',
            "-c", 'model_providers.agentx.env_key="AGENTX_LLM_CODEX_TOKEN"',
            "-c", f"model_context_window={context}",
            "-c", f"model_auto_compact_token_limit={int(context * 0.9)}"]


def execute(a, runtime=None, clock=time, alive=pane_alive, activity=latest_activity, prepared_workspace=None, on_event=None):
    run = a.run_dir.resolve()
    run.parent.mkdir(parents=True, exist_ok=True)
    if prepared_workspace is None:
        run.mkdir()  # Direct calls also require a fresh episode identity.
    elif (run / "receipt.json").exists():
        raise FileExistsError("episode already executed; never relaunch")
    receipt = {"kind": "agentx.island-run/v1", "run_dir": str(run), "agent": a.name,
               "model": MODEL, "netcheck": a.netcheck, "minutes": a.minutes,
               "started_at": stamp(), "outcome": "starting", "events": [],
               "memoryFrom": str(a.memory_from.resolve()) if a.memory_from else None}
    atomic_json(run / "receipt.json", receipt)
    world = agent = proxy = None
    stopped = False
    handlers = {}
    local_stopped = False

    def stop(_sig, _frame):
        nonlocal stopped
        stopped = True

    def note(kind, **detail):
        receipt["events"].append({"at": stamp(), "event": kind, **detail})
        atomic_json(run / "receipt.json", receipt)
        if on_event: on_event(kind, detail)

    def resume(prompt, reason):
        agent.stop(grace_seconds=20)
        result = agent.send(prompt=prompt, env=agent_env)
        if not alive(result): raise RuntimeError("agent did not survive resume")
        note("resumed", reason=reason)
        return result

    try:
        runtime = runtime or importlib.import_module("clawblox")
        # Refuse older adapters before they can copy the owner's native login.
        if getattr(runtime, "agentx_isolation_version", lambda: 0)() != 1:
            raise RuntimeError("Clawblox isolation patch v1 required; no runtime started")
        workspace = run / "agents" / a.name.lower() / "workspace"
        if prepared_workspace is None:
            seed_workspace(workspace, a.templates_dir, a.memory_from)
        elif workspace != prepared_workspace:
            raise ValueError("prepared workspace differs from this episode identity")
        token = "" if a.netcheck else a.token_file.read_text().strip()
        proxy = LLMProxy(None if a.netcheck else a.gateway_base_url, token)
        proxy.__enter__()
        agent_env = {"CLAWBLOX_NET_ALLOW": f"127.0.0.1:{proxy.port}@{a.gateway_guest_port}",
                     "AGENTX_LLM_CODEX_TOKEN": proxy.capability}
        if a.netcheck:
            import json
            agent_env.update(AGENTX_NETCHECK_PORT=str(a.gateway_guest_port),
                             AGENTX_NETCHECK_BLOCKED_URLS=json.dumps(a.netcheck_blocked_url))
        # Never pass upstream token/base URL in the sandbox environment or config.
        extra = [] if a.netcheck else codex_args(a.gateway_guest_port, a.context_window)
        binary = KIT / "netcheck_probe.js" if a.netcheck else a.codex.resolve()
        for sig in (signal.SIGINT, signal.SIGTERM):
            handlers[sig] = signal.signal(sig, stop)
        world = runtime.World(dir=str(a.world_dir))
        world.start(port=a.port, record=True, record_dir=run / "recordings", log_file=run / "world.log")
        agent = runtime.Agent(agent="codex", name=a.name, dir=workspace.parent, model=MODEL,
                              binary=binary, sandbox=True, extra_args=extra,
                              auto_continue_prompt=CONTINUE)
        world.connect(agent=agent)
        prompt = (a.templates_dir / "SYSTEM_PROMPT.md").read_text()
        if stopped: raise InterruptedError("episode stopped during startup")
        started = agent.start(initial_prompt="Begin.", system_prompt=prompt
                              .replace("${WORLD_AGENT_NAME}", a.name).replace("${WORKSPACE_DIR}", "/workspace"),
                              env=agent_env)
        sessions = workspace.parent / "sandbox-home" / ".codex" / "sessions"
        began = last_nudge = clock.monotonic()
        deadline, warned, nudges, seen_activity = began + a.minutes * 60, False, 0, False
        receipt["outcome"] = "running"
        note("running")
        while not stopped and clock.monotonic() < deadline:
            current = clock.monotonic()
            if not alive(started): raise RuntimeError("agent exited before episode end")
            observed = activity(sessions)
            seen_activity = seen_activity or bool(observed and observed.get("modelActivity"))
            if not seen_activity and current - began >= a.startup_seconds:
                raise RuntimeError("agent produced no session activity before startup deadline")
            if a.netcheck and (workspace / "netcheck.json").exists():
                receipt["netcheckResult"] = netcheck_result(workspace)
            if not warned and current >= deadline - a.memory_warning_minutes * 60:
                warned = True
                started = resume("This session ends in a few minutes. Update your memory files now.", "memory-reminder")
                last_nudge = clock.monotonic()
            elif observed and current - last_nudge >= a.min_nudge_interval_seconds:
                ended = observed["payload"].get("type") == "task_complete"
                stalled = observed["age"] >= (a.stall_after_turn_seconds if ended else a.stall_idle_seconds)
                if stalled:
                    if nudges >= a.max_nudges: raise RuntimeError("agent exhausted stall recovery budget")
                    started = resume(CONTINUE, "finished-turn" if ended else "idle")
                    last_nudge, nudges = clock.monotonic(), nudges + 1
            clock.sleep(min(1, max(0, deadline - clock.monotonic())))
        if not stopped:
            if not alive(started): raise RuntimeError("agent exited at episode end")
            if not seen_activity: raise RuntimeError("episode ended without observed session activity")
            if not observed or observed["age"] >= a.stall_idle_seconds:
                raise RuntimeError("episode ended without recent session activity")
            if a.netcheck: receipt["netcheckResult"] = netcheck_result(workspace)
        receipt["activityObserved"] = seen_activity
        receipt["outcome"] = "stopped" if stopped else "completed"
    except InterruptedError:
        receipt["outcome"] = "stopped"
    except Exception as error:
        receipt.update(outcome="failed", error=str(error))
    finally:
        errors = []
        for obj, seconds in ((agent, 20), (world, 10)):
            if obj is not None:
                try: obj.stop(grace_seconds=seconds)
                except Exception: errors.append(type(obj).__name__ + " stop failed")
        if proxy:
            try: proxy.__exit__(None, None, None)
            except Exception: errors.append("inference proxy stop failed")
        local_stopped = not errors
        if errors: receipt.update(outcome="failed", cleanupErrors=errors)
        receipt.update(ended_at=stamp(), localStopped=local_stopped)
        atomic_json(run / "receipt.json", receipt)
        for sig, handler in handlers.items(): signal.signal(sig, handler)
    return 0 if receipt["outcome"] == "completed" else 2 if receipt["outcome"] == "stopped" else 1


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run-dir", required=True, type=Path)
    p.add_argument("--templates-dir", required=True, type=Path)
    p.add_argument("--world-dir", required=True, type=Path)
    p.add_argument("--memory-from", type=Path, help="terminated previous episode; copy only its memory files")
    p.add_argument("--name", default="Agent")
    p.add_argument("--minutes", type=float, default=60)
    p.add_argument("--port", type=int, default=18080)
    p.add_argument("--codex", type=Path)
    p.add_argument("--token-file", type=Path, help="dedicated upstream client credential; never sent to agent")
    p.add_argument("--gateway-base-url")
    p.add_argument("--gateway-guest-port", type=int, default=8443)
    p.add_argument("--context-window", type=int)
    p.add_argument("--memory-warning-minutes", type=float, default=5)
    p.add_argument("--startup-seconds", type=float, default=90)
    p.add_argument("--stall-after-turn-seconds", type=float, default=90)
    p.add_argument("--stall-idle-seconds", type=float, default=900)
    p.add_argument("--min-nudge-interval-seconds", type=float, default=120)
    p.add_argument("--max-nudges", type=int, default=30)
    p.add_argument("--netcheck", action="store_true")
    p.add_argument("--netcheck-blocked-url", action="append", default=[])
    return p


def main(argv=None):
    p = parser()
    a = p.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", a.name): p.error("invalid agent name")
    for name in ("minutes", "startup_seconds", "stall_after_turn_seconds", "stall_idle_seconds", "min_nudge_interval_seconds"):
        if not math.isfinite(getattr(a, name)) or getattr(a, name) <= 0: p.error(name + " must be finite and positive")
    if not math.isfinite(a.memory_warning_minutes) or a.memory_warning_minutes < 0: p.error("invalid reminder time")
    if a.max_nudges < 0: p.error("invalid nudge budget")
    if not 0 < a.port < 65536 or not 0 < a.gateway_guest_port < 65536: p.error("invalid port")
    if not a.netcheck and (not a.context_window or a.context_window <= 0 or not a.token_file or not a.gateway_base_url or not a.codex):
        p.error("real runs require context-window, codex, dedicated token-file and gateway-base-url")
    return execute(a)


if __name__ == "__main__": sys.exit(main())
