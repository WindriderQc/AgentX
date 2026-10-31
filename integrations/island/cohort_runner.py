#!/usr/bin/env python3
"""Operator cohort on one remote island, using the installed native supervisors.

The operator queues/admission-fences the work and prepares the remote world ONCE.
This controller owns the existing runner active marker; it never selects/resets
the world. Members have separate native run identities, relays and fresh memory.
Core remains responsible for inference admission and final physical release.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import island_runner as native

CONTRACT = "agentx.island-cohort/v1"
NAMES = {"codex": "EkoCodex", "dsh": "EkoDSH", "pi": "EkoPi"}


def roster(run_id, harnesses):
    selected = harnesses.split(",")
    if not 2 <= len(selected) <= 3 or len(set(selected)) != len(selected) or any(h not in NAMES for h in selected):
        raise ValueError("select two or three distinct installed harnesses: codex,dsh,pi")
    return [{"runId": str(uuid.uuid5(uuid.UUID(run_id), h)), "harness": h, "agent": NAMES[h]} for h in selected]


def idle_ports(base, count):
    if not isinstance(base, int) or not 1024 <= base <= 65535 - count + 1:
        raise ValueError("cohort ports must be distinct unprivileged ports")
    sockets = []
    try:
        for port in range(base, base + count):
            sock = socket.socket()
            sockets.append(sock)
            sock.bind(("127.0.0.1", port))
    finally:
        for sock in sockets:
            sock.close()


def preflight(config, args):
    members = roster(args.run_id, args.harnesses)
    if not args.netcheck and (not 5 <= args.minutes <= 60 or not args.context_window or args.context_window <= 0):
        raise ValueError("real cohorts need 5..60 minutes and the principal context window")
    if args.netcheck and args.minutes != 1:
        raise ValueError("cohort netcheck is one minute and has no inference upstream")
    remote = native.remote_world(config, args.world)
    if not remote:
        raise ValueError("cohorts require an already prepared remote world")
    for member in members:
        checked = native.action_check(config, SimpleNamespace(harness=member["harness"], agent=member["agent"], world=args.world))
        if not checked["ready"] or checked["activeRun"]:
            raise ValueError("runner not ready/idle: " + str(checked["problems"] or checked["activeRun"]))
    idle_ports(config["worldPort"], len(members))
    return members, remote


def member_config(config, group, member, index):
    value = {k: v for k, v in config.items() if k != "configPath"}
    value.update(worldPort=config["worldPort"] + index, worldsRoot=str(group / "worlds" / member["harness"]),
                 startupSeconds=max(300, config.get("startupSeconds", 90)))
    return value


def prepare(config, args, members, remote):
    """Called under the native start lock; no process or inference is started here."""
    root = native.runs_root(config)
    paths = [root / args.run_id, *[root / m["runId"] for m in members]]
    if any(p.exists() for p in paths):
        raise ValueError("cohort/member identity already exists; use status, never replay start")
    group = paths[0]
    group.mkdir(mode=0o700)
    request = {"runId": args.run_id, "dispatchId": args.dispatch_id, "agent": "Eko", "harness": "cohort",
               "world": args.world, "worldKind": "remote", "minutes": args.minutes, "memory": "fresh",
               "netcheck": args.netcheck, "contextWindow": args.context_window, "members": members,
               "model": native.PRINCIPAL_ALIAS, "requestedAt": native.now_iso()}
    native.write_json(group / "request.json", request)
    native.write_json(group / "state.json", {"phase": "starting", "localStopped": False, "events": []})
    for index, member in enumerate(members):
        child = root / member["runId"]
        child.mkdir(mode=0o700)
        cfg = member_config(config, group, member, index)
        world = Path(cfg["worldsRoot"]) / args.world
        world.mkdir(parents=True, mode=0o700)
        for name in ("world.toml", "README.md"):
            data, _ = native.read_regular(Path(config["worldsRoot"]) / args.world / name, 256 * 1024)
            (world / name).write_bytes(data)
        native.write_json(group / (member["harness"] + ".json"), cfg)
        native.write_json(child / "request.json", {**request, **member, "parentRunId": args.run_id,
                          "remoteWorld": {"origin": remote["origin"], "world": remote["world"]}})
        native.write_json(child / "state.json", {"phase": "prepared", "localStopped": True, "events": []})
    native.write_json(root / "active.json", {"runId": args.run_id, "since": request["requestedAt"]})
    return group


def start(config, args):
    members, remote = preflight(config, args)
    root = native.runs_root(config)
    with open(root / "runner.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if native.active_run(config):
            raise ValueError("runner became busy before cohort publication")
        group = prepare(config, args, members, remote)
        # The child waits for this lock before any state write, like native start.
        try:
            with open(group / "supervisor.log", "ab") as log:
                child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "supervise",
                    "--run-id", args.run_id, "--config", config["configPath"]], stdin=subprocess.DEVNULL,
                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        except OSError:
            # No child was spawned. Keep the durable identity, but release local ownership.
            native.write_json(group / "state.json", {"phase": "finished", "outcome": "failed", "localStopped": True})
            (root / "active.json").unlink()
            raise
        native.write_json(group / "state.json", {"pid": child.pid, "phase": "starting", "localStopped": False, "events": []})
    return {"runId": args.run_id, "pid": child.pid, "members": members}


def describe(config, run_id):
    group = native.run_dir(config, run_id)
    request = native.read_json(group / "request.json")
    if not request:
        raise ValueError("cohort not found")
    state = native.read_json(group / "state.json", {})
    members = []
    for member in request["members"]:
        cfg = native.load_config(group / (member["harness"] + ".json"))
        members.append(native.describe(cfg, member["runId"]))
    return {"runId": run_id, "request": request, "state": state, "members": members,
            "alive": native.pid_alive(state.get("pid"), run_id)}


def released(members):
    return bool(members) and all(m.get("terminal") is True and m.get("alive") is False
        and m.get("localStopped") is True and m.get("processObservationOk") is True
        and m.get("leftover") == [] for m in members)


def supervise(config, args):
    root = native.runs_root(config)
    group = native.run_dir(config, args.run_id)
    request = native.read_json(group / "request.json")
    processes = []
    stopping, failed = False, False
    stop_at = None
    previous = {}

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    for sig in (signal.SIGTERM, signal.SIGINT):
        previous[sig] = signal.signal(sig, stop)
    with open(root / "runner.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = native.read_json(group / "state.json", {})
        state.update(pid=os.getpid(), phase="running", startedAt=native.now_iso(), localStopped=False)
        native.write_json(group / "state.json", state)
    deadline = time.monotonic() + request["minutes"] * 60 + 420
    error = None
    try:
        with open(root / "runner.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            for member in request["members"]:
                if stopping:
                    break
                child = root / member["runId"]
                native.write_json(child / "state.json", {"phase": "starting", "localStopped": False, "events": []})
                try:
                    with open(child / "supervisor.log", "ab") as log:
                        process = subprocess.Popen([sys.executable, str(Path(native.__file__).resolve()), "supervise",
                            "--run-id", member["runId"], "--config", str(group / (member["harness"] + ".json"))],
                            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                except OSError:
                    native.write_json(child / "state.json", {"phase": "finished", "outcome": "failed", "localStopped": True})
                    raise
                processes.append(process)
                native.write_json(child / "state.json", {"pid": process.pid, "phase": "starting", "localStopped": False, "events": []})
                state.setdefault("memberPids", {})[member["runId"]] = process.pid
                native.write_json(group / "state.json", state)
        while any(p.poll() is None for p in processes):
            observed = describe(config, args.run_id)["members"]
            if any(m.get("outcome") == "failed" or m.get("phase") == "interrupted" for m in observed):
                failed = True
            if time.monotonic() > deadline:
                failed = True
            if (stopping or failed) and stop_at is None:
                stop_at = time.monotonic()
                state["phase"] = "stopping"
                native.write_json(group / "state.json", state)
                for process in processes:
                    if process.poll() is None:
                        process.send_signal(signal.SIGTERM)
            if stop_at is not None and time.monotonic() - stop_at > 90:
                raise RuntimeError("member shutdown remains unproven; retain active marker and reconcile")
            time.sleep(2)
    except Exception as exc:
        error, failed = str(exc), True
        for process in processes:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
        for process in processes:
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                pass
    finally:
        try:
            members = describe(config, args.run_id)["members"]
        except Exception as exc:
            members, failed, error = [], True, str(exc)
        clean = released(members) and all(p.poll() is not None for p in processes)
        outcome = "stopped" if stopping else "failed" if failed or not clean or any(m.get("outcome") != "completed" for m in members) else "completed"
        state.update(phase="finished", outcome=outcome, localStopped=clean, endedAt=native.now_iso(), error=error)
        native.write_json(group / "state.json", state)
        native.write_json(group / "receipt.json", {"contract": CONTRACT, **request, **state, "members": members})
        if clean:
            with open(root / "runner.lock", "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                if (native.read_json(root / "active.json", {}) or {}).get("runId") == args.run_id:
                    (root / "active.json").unlink()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    return {"runId": args.run_id, "outcome": outcome, "localStopped": clean}


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "start", "status", "stop", "supervise"])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--dispatch-id")
    parser.add_argument("--world", default="graphysx-living")
    parser.add_argument("--harnesses", default="codex,dsh,pi")
    parser.add_argument("--minutes", type=int, default=15)
    parser.add_argument("--context-window", type=int)
    parser.add_argument("--netcheck", action="store_true")
    args = parser.parse_args(argv)
    try:
        if not native.RUN_ID.fullmatch(args.run_id) or not native.WORLD.fullmatch(args.world):
            raise ValueError("invalid run/world identity")
        if args.action == "start" and not native.RUN_ID.fullmatch(args.dispatch_id or ""):
            raise ValueError("start requires the Core dispatch UUID")
        config = native.load_config(args.config)
        if args.action == "check":
            members, _ = preflight(config, args)
            data = {"ready": True, "members": members}
        elif args.action == "status":
            data = describe(config, args.run_id)
        elif args.action == "stop":
            data = native.action_stop(config, args)
        else:
            data = (start if args.action == "start" else supervise)(config, args)
        print(json.dumps({"contract": CONTRACT, "ok": True, "data": data}))
        return 0
    except (ValueError, OSError, native.RunnerError) as error:
        print(json.dumps({"contract": CONTRACT, "ok": False, "message": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
