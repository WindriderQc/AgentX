#!/usr/bin/env python3
"""Prepare a configured GraphysX world for the native Island queue executor.

AGENTX_ISLAND_WORLD_PROFILES names an operator-only JSON map keyed by runner
terrain id. Each profile has url, world, tokenFile, dataHost and mode (reuse or
fresh). Reuse is read-only: an existing world and its identity are preserved.
Fresh explicitly creates an experiment. Unknown terrains remain unmanaged.
Connection choices, tokens and result receipts stay outside the repository.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

from pathlib import Path
from urllib.parse import urlsplit

REQUEST = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
WORLD_URL = ""
ENV_FILE = ""
DATA_HOST = ""
TIMEOUT = 20


def profile_for(world):
    path = os.environ.get("AGENTX_ISLAND_WORLD_PROFILES")
    if not path:
        raise RuntimeError("AGENTX_ISLAND_WORLD_PROFILES needs the native profile file")
    try:
        profiles = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        raise RuntimeError("world profiles are unreadable") from None
    if not isinstance(profiles, dict):
        raise RuntimeError("world profiles need an object")
    profile = profiles.get(world)
    if profile is None:
        return None
    if not isinstance(profile, dict):
        raise RuntimeError("invalid world profile")
    url = urlsplit(profile.get("url", ""))
    if (url.scheme not in ("http", "https") or not url.hostname or url.username or url.password
            or url.path not in ("", "/") or url.query or url.fragment
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", profile.get("world", ""))
            or profile.get("mode") not in ("reuse", "fresh")
            or not all(isinstance(profile.get(k), str) and profile[k].startswith("/") for k in ("tokenFile", "dataHost"))):
        raise RuntimeError("invalid world profile")
    return profile


def answer(ok: bool, managed: bool = True, world: str | None = None, record_dir: str | None = None, message: str | None = None, identity: dict | None = None) -> int:
    print(json.dumps({"ok": ok, "managed": managed, "world": world, "recordDir": record_dir, "message": message, **(identity or {})}), flush=True)
    return 0 if ok else 1


def operator_token() -> str:
    try:
        with open(ENV_FILE, encoding="utf-8") as stream:
            for line in stream:
                key, _, value = line.strip().partition("=")
                if key == "WORLD_OPERATOR_TOKEN" and len(value.strip()) >= 32:
                    return value.strip()
    except OSError:
        pass
    raise RuntimeError("the world service operator token is unreadable on this host")


def call(method: str, path: str, body: dict | None = None, token: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(WORLD_URL + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", **({"X-Operator-Token": token} if token else {})})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read() or b"null")
        except ValueError:
            detail = None
        return error.code, detail
    except (OSError, ValueError) as error:
        raise RuntimeError(f"the world service does not answer ({type(error).__name__})") from None


def current_health() -> dict:
    """The running island; None for a world service from before the selector (Mesa only)."""
    status, health = call("GET", "/healthz")
    if status != 200 or not isinstance(health, dict) or health.get("ok") is not True:
        raise RuntimeError(f"the world service is not healthy (/healthz {status})")
    return health


def current_world() -> str | None:
    world = current_health().get("world")
    return world if isinstance(world, str) else None


def host_path(record_dir) -> str | None:
    if not isinstance(record_dir, str) or not re.fullmatch(r"/data/[\w./-]{1,240}", record_dir) or ".." in record_dir:
        return None
    return DATA_HOST.rstrip("/") + record_dir[len("/data"):]


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3) or argv[0] not in ("check", "prepare") or (argv[0] == "prepare") != (len(argv) == 3):
        return answer(False, message="usage: check <world> | prepare <world> <request id>")
    action, runner_world = argv[0], argv[1]
    if action == "prepare" and not REQUEST.match(argv[2]):
        return answer(False, message="prepare needs the queue request id")
    global WORLD_URL, ENV_FILE, DATA_HOST
    try:
        profile = profile_for(runner_world)
        if profile is None:
            return answer(True, managed=False, world=runner_world, message="not a managed world; nothing to prepare")
        WORLD_URL, ENV_FILE, DATA_HOST = profile["url"].rstrip("/"), profile["tokenFile"], profile["dataHost"]
        wanted = profile["world"]
        token = operator_token()
        running = current_world()
        if running is None and wanted != "mesa-island":
            return answer(False, world=wanted, message="this world service has no world selector (GraphysX-Web#94); update it first")
        if profile["mode"] == "reuse":
            health = current_health()
            identity = {key: health.get(key) for key in ("instanceId", "recordingId")}
            if health.get("world") != wanted or not all(isinstance(v, str) and REQUEST.fullmatch(v) for v in identity.values()):
                return answer(False, world=wanted, message="persistent world identity is unavailable or differs; nothing changed")
            record_dir = host_path(f"/data/recordings/instances/{identity['recordingId']}")
            return answer(True, world=wanted, record_dir=record_dir, identity=identity,
                          message=f"reuse {wanted}; world and checkpoint preserved")
        if action == "check":
            return answer(True, world=wanted, message=f"running {running or 'mesa-island (no selector)'}")
        if running is None:
            # Before the selector the service only ran Mesa and cannot start it fresh.
            return answer(True, world=wanted, message="world service without selector: Mesa kept as it is, no fresh island")
        status, switched = call("POST", "/world", {"world": wanted, "force": True, "runId": argv[2]}, token)
        if status != 200 or not isinstance(switched, dict) or switched.get("world") != wanted:
            detail = switched.get("error") if isinstance(switched, dict) else None
            return answer(False, world=wanted, message=f"the world selector refused ({status}): {str(detail or '')[:160]}")
        verified = current_health()
        if verified.get("world") != wanted:
            return answer(False, world=wanted, message="the island did not switch")
        if switched.get("instanceId") and verified.get("instanceId") != switched["instanceId"]:
            return answer(False, world=wanted, message="the island instance changed during preparation")
        return answer(True, world=wanted, record_dir=host_path(switched.get("recordDir")),
                      message=f"fresh {wanted} (was {switched.get('previous')})",
                      identity={key: switched[key] for key in ("instanceId", "recordingId")
                                if isinstance(switched.get(key), str) and REQUEST.fullmatch(switched[key])})
    except RuntimeError as error:
        return answer(False, message=str(error))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
