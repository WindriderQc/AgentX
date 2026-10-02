"""OpenClaw side of the guarded ClawdX dispatch: the worker process under an
attribution lease, dispatch and cost preflight, and session cost evidence.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import shlex
import subprocess
import time
from typing import Any, Mapping

try:
    from integrations.coding.coding_dispatch_evidence import (
        PIPELINE_ATTRIBUTION_ALIAS,
        PipelineApiError,
        task_cost_budget,
    )
    from integrations.coding import clawdx_dispatch_api as dispatch_api
    from integrations.coding import clawdx_dispatch_remote as dispatch_remote
except ModuleNotFoundError:  # direct execution from the scripts directory
    from coding_dispatch_evidence import (  # type: ignore
        PIPELINE_ATTRIBUTION_ALIAS,
        PipelineApiError,
        task_cost_budget,
    )
    import clawdx_dispatch_api as dispatch_api  # type: ignore
    import clawdx_dispatch_remote as dispatch_remote  # type: ignore


COST_EVIDENCE_SCHEMA = "agentx.openclaw-session-cost/v1"
COST_EVIDENCE_MODES = {"local-zero"}
OPENCLAW_SESSION_COST_SCRIPT = r'''
import json
import os
import re
import sqlite3
import sys
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$")
SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$")
agent, session_key = sys.argv[1:3]
if not IDENTIFIER.fullmatch(agent) or not IDENTIFIER.fullmatch(session_key):
    raise SystemExit("invalid session identity")
agent_root = os.path.expanduser(f"~/.openclaw/agents/{agent}")
canonical_key = f"agent:{agent}:{session_key}"
calls = 0
cost_calls = 0
session_status = "done"
cost = Decimal("0")
input_tokens = 0
output_tokens = 0
cache_read_tokens = 0
total_tokens = 0
providers = set()
models = set()
origins = set()

def visit(value):
    global calls, cost_calls, cost, input_tokens, output_tokens, cache_read_tokens, total_tokens
    if isinstance(value, dict):
        usage = value.get("usage")
        # Call/model attribution is independent of monetary telemetry.
        if value.get("provider") and value.get("model") and (value.get("role") == "assistant" or isinstance(usage, dict)):
            calls += 1
            providers.add(str(value["provider"]))
            models.add(str(value["model"]))
            usage = usage if isinstance(usage, dict) else {}
            input_tokens += int(usage.get("input") or 0)
            output_tokens += int(usage.get("output") or 0)
            cache_read_tokens += int(usage.get("cacheRead") or 0)
            total_tokens += int(usage.get("totalTokens") or 0)
            money = usage.get("cost") if isinstance(usage.get("cost"), dict) else {}
            raw_total = money.get("total")
            try:
                observed = Decimal(str(raw_total))
            except (InvalidOperation, ValueError):
                observed = None
            if observed is not None and observed.is_finite() and observed >= 0:
                cost_calls += 1
                cost += observed
            if money.get("totalOrigin"):
                origins.add(str(money["totalOrigin"]))
        for child in value.values():
            visit(child)
    elif isinstance(value, list):
        for child in value:
            visit(child)

database_path = os.path.join(agent_root, "agent", "openclaw-agent.sqlite")
if os.path.isfile(database_path):
    connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
    try:
        row = connection.execute(
            "SELECT current_session_id, entry_valid, status FROM session_nodes "
            "WHERE lower(session_key) = lower(?)",
            (canonical_key,),
        ).fetchone()
        if row is None:
            raise SystemExit("session not found")
        session_id = str(row[0] or "")
        if not SESSION_ID.fullmatch(session_id) or row[1] != 1 or row[2] not in {"done", "failed"}:
            raise SystemExit("session is not a valid terminal session")
        session_status = row[2]
        records = connection.execute(
            "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
            (session_id,),
        )
        for (raw,) in records:
            try:
                visit(json.loads(raw))
            except (json.JSONDecodeError, TypeError):
                continue
    finally:
        connection.close()
else:
    root = os.path.join(agent_root, "sessions")
    with open(os.path.join(root, "sessions.json"), encoding="utf-8") as handle:
        sessions = json.load(handle)
    entry = sessions.get(canonical_key)
    if not isinstance(entry, dict):
        raise SystemExit("session not found")
    session_id = str(entry.get("sessionId") or "")
    if not SESSION_ID.fullmatch(session_id):
        raise SystemExit("invalid session id")
    path = os.path.join(root, session_id + ".jsonl")
    with open(path, encoding="utf-8") as handle:
        records = list(handle)
    for raw in records:
        try:
            visit(json.loads(raw))
        except json.JSONDecodeError:
            continue
if calls < 1:
    raise SystemExit("session contains no attributable model call")
nanodollars = int((cost * Decimal("1000000000")).quantize(Decimal("1"), rounding=ROUND_HALF_UP)) if cost_calls else None
print(json.dumps({
    "calls": calls,
    "costNanodollars": nanodollars,
    "costStatus": "unknown" if not cost_calls else "complete" if cost_calls == calls and session_status == "done" else "partial",
    "sessionStatus": session_status,
    "inputTokens": input_tokens,
    "outputTokens": output_tokens,
    "cacheReadTokens": cache_read_tokens,
    "totalTokens": total_tokens,
    "providers": sorted(providers),
    "models": sorted(models),
    "origins": sorted(origins),
}, separators=(",", ":"), sort_keys=True))
'''


def run_openclaw_process(
    args: argparse.Namespace,
    remote_cmd: str,
    *,
    request_id: str,
) -> tuple[subprocess.CompletedProcess, dict[str, Any] | None]:
    lease = dispatch_api.open_attribution_lease(args, request_id=request_id)
    process_error: Exception | None = None
    proc: subprocess.CompletedProcess | None = None
    try:
        proc = dispatch_remote.ssh_run(
            args.host,
            remote_cmd,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=args.timeout + 90,
        )
    except Exception as exc:
        process_error = exc
    close_error: Exception | None = None
    try:
        request_count = dispatch_api.close_attribution_lease(args, lease, request_id=request_id)
        if lease is not None and request_count is not None:
            lease = {**lease, "requestCount": request_count}
    except Exception as exc:
        close_error = exc
    if process_error and close_error:
        raise PipelineApiError(
            f"OpenClaw process failed and Pipeline attribution close failed: "
            f"{type(process_error).__name__}; {type(close_error).__name__}"
        ) from process_error
    if close_error:
        raise PipelineApiError(
            f"Pipeline attribution close failed: {type(close_error).__name__}: {close_error}"
        ) from close_error
    if process_error:
        raise process_error
    if proc is None:
        raise PipelineApiError("OpenClaw process returned no result")
    return proc, lease


def validate_cost_preflight(args: argparse.Namespace, task: Mapping[str, Any]) -> None:
    mode = str(getattr(args, "cost_evidence_mode", "") or "")
    if not mode:
        raise PipelineApiError("--cost-evidence-mode is required for live dispatch")
    if mode not in COST_EVIDENCE_MODES:
        raise PipelineApiError("live paid execution is disabled without a broker SpendGrant")
    budget = task_cost_budget(task)
    if budget != 0:
        raise PipelineApiError("local-zero execution requires maxCostNanodollars=0")
    if args.model != PIPELINE_ATTRIBUTION_ALIAS or not getattr(args, "attest_attribution", False):
        raise PipelineApiError(
            "local-zero execution requires the attested AgentX Pipeline model alias"
        )


def openclaw_cli_json(host: str, parts: list[str], *, label: str) -> dict[str, Any]:
    command = " ".join(shlex.quote(part) for part in ["openclaw", *parts])
    proc = dispatch_remote.ssh_run(
        host,
        command,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    if proc.returncode != 0:
        detail = str(proc.stderr or proc.stdout or "unavailable").strip()[:240]
        raise PipelineApiError(
            f"OpenClaw {label} preflight failed: exit={proc.returncode},actual={detail}"
        )
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise PipelineApiError(
            f"OpenClaw {label} preflight failed: expected=JSON,actual=invalid"
        ) from exc
    if not isinstance(payload, dict):
        raise PipelineApiError(
            f"OpenClaw {label} preflight failed: expected=object,actual={type(payload).__name__}"
        )
    return payload


def validate_openclaw_dispatch_preflight(
    host: str,
    agent: str,
    session_key: str,
    requested_model: str | None,
) -> None:
    """Require a fresh session key and the exact available model before claim."""
    if requested_model != PIPELINE_ATTRIBUTION_ALIAS:
        raise PipelineApiError(
            "OpenClaw model preflight failed: "
            f"expected={PIPELINE_ATTRIBUTION_ALIAS},actual={requested_model or 'missing'}"
        )
    models_payload = openclaw_cli_json(
        host,
        ["models", "list", "--agent", agent, "--json"],
        label="model",
    )
    models = models_payload.get("models")
    model = next(
        (
            candidate
            for candidate in models or []
            if isinstance(candidate, Mapping) and candidate.get("key") == requested_model
        ),
        None,
    )
    if not isinstance(model, Mapping) or model.get("missing") is True or model.get("available") is not True:
        actual = "missing" if not isinstance(model, Mapping) or model.get("missing") is True else "unavailable"
        raise PipelineApiError(
            f"OpenClaw model preflight failed: expected={requested_model},actual={actual}"
        )

    sessions_payload = openclaw_cli_json(
        host,
        ["sessions", "--agent", agent, "--json", "--limit", "all"],
        label="session",
    )
    canonical_key = f"agent:{agent}:{session_key.lower()}"
    sessions = sessions_payload.get("sessions")
    if not isinstance(sessions, list):
        raise PipelineApiError(
            "OpenClaw session preflight failed: expected=sessions list,actual=missing"
        )
    existing = next(
        (
            candidate
            for candidate in sessions
            if isinstance(candidate, Mapping)
            and str(candidate.get("key") or "").lower() == canonical_key
        ),
        None,
    )
    if isinstance(existing, Mapping):
        session_id = str(existing.get("sessionId") or "unknown")[:128]
        raise PipelineApiError(
            "OpenClaw session preflight failed: "
            f"expected=new key={canonical_key},actual=existing sessionId={session_id}"
        )
    print(f"openclaw_model_preflight=pass model={requested_model}")
    print(f"openclaw_session_preflight=pass key={canonical_key}")


def read_openclaw_session_cost(
    host: str,
    agent: str,
    session_key: str,
    *,
    retries: int = 4,
) -> dict[str, Any]:
    # OpenClaw canonicalizes session registry keys to lowercase even when its
    # caller supplies a UTC stamp with the conventional uppercase T/Z. Read
    # and fingerprint that canonical identity so a completed local run cannot
    # lose its cost receipt solely because of storage normalization.
    session_key = session_key.lower()
    encoded = base64.b64encode(OPENCLAW_SESSION_COST_SCRIPT.encode("utf-8")).decode("ascii")
    bootstrap = f'import base64;exec(base64.b64decode("{encoded}"))'
    command = " ".join(
        [
            "python3",
            "-c",
            shlex.quote(bootstrap),
            shlex.quote(agent),
            shlex.quote(session_key),
        ]
    )
    last_detail = "unavailable"
    for attempt in range(max(1, retries)):
        proc = dispatch_remote.ssh_run(
            host,
            command,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
        if proc.returncode == 0:
            try:
                observed = json.loads(proc.stdout)
            except json.JSONDecodeError as exc:
                raise PipelineApiError("OpenClaw cost helper returned invalid JSON") from exc
            required = {
                "calls",
                "costNanodollars",
                "inputTokens",
                "outputTokens",
                "cacheReadTokens",
                "totalTokens",
                "providers",
                "models",
                "origins",
            }
            if not isinstance(observed, dict) or required - set(observed):
                raise PipelineApiError("OpenClaw cost helper returned incomplete evidence")
            canonical = {
                "schema": COST_EVIDENCE_SCHEMA,
                "agent": agent,
                "sessionKey": session_key,
                **{key: observed[key] for key in sorted(required)},
                **{key: observed[key] for key in ("costStatus", "sessionStatus") if key in observed},
            }
            fingerprint = hashlib.sha256(
                json.dumps(canonical, separators=(",", ":"), sort_keys=True).encode("utf-8")
            ).hexdigest()
            return {**observed, "fingerprint": fingerprint}
        last_detail = str(proc.stderr or proc.stdout or "unavailable").strip()[:240]
        if attempt + 1 < retries:
            time.sleep(0.25 * (attempt + 1))
    raise PipelineApiError(f"OpenClaw cost evidence unavailable: {last_detail}")
