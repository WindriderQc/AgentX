"""Read current OpenClaw sessions through its gateway, never its SQLite schema."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .. import schema
from . import build_observation, classify_memory_intent, reject

RPC_TIMEOUT = 35
MAX_RPC_BYTES = 8 * 1024 * 1024


def gateway_call(home: Path, method: str, params: dict) -> dict:
    """Keep credentials in OpenClaw's resolver and private output off logs."""
    env = dict(os.environ, OPENCLAW_STATE_DIR=str(home))
    with tempfile.TemporaryFile() as output:
        try:
            completed = subprocess.run(
                ["openclaw", "gateway", "call", method, "--params",
                 json.dumps(params), "--json", "--timeout", "30000"],
                stdout=output, stderr=subprocess.DEVNULL, env=env,
                timeout=RPC_TIMEOUT, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(f"OpenClaw {method} unavailable") from exc
        if completed.returncode or output.tell() > MAX_RPC_BYTES:
            raise RuntimeError(f"OpenClaw {method} failed or exceeded output limit")
        output.seek(0)
        try:
            payload = json.load(output)
        except (ValueError, UnicodeError) as exc:
            raise RuntimeError(f"OpenClaw {method} returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"OpenClaw {method} returned invalid shape")
    return payload


def _timestamp(value) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value / 1000
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0


def collect_gateway(*, home, agent, store, result, lookback_days, max_files,
                    allowed_owners, rpc=gateway_call):
    # Import lazily: the legacy collector selects this reader only for a native
    # store, so existing offline JSONL imports keep their established behavior.
    from .openclaw import (
        _event_text, _is_cron_prompt, _native_owner_flag, _message_owner_id,
        _session_registry_state,
    )

    horizon = datetime.now(timezone.utc).timestamp() - lookback_days * 86400
    try:
        rows = []
        offset = 0
        for _ in range(10):
            page = rpc(home, "sessions.list", {
                "agentId": agent, "activeMinutes": lookback_days * 1440,
                "limit": 100, "offset": offset,
            })
            if not isinstance(page.get("sessions"), list):
                raise RuntimeError("OpenClaw session inventory has invalid shape")
            rows.extend(page["sessions"])
            if not page.get("hasMore"):
                break
            next_offset = page.get("nextOffset")
            if not isinstance(next_offset, int) or next_offset <= offset:
                raise RuntimeError("OpenClaw session inventory cannot advance")
            offset = next_offset
        else:
            raise RuntimeError("OpenClaw session inventory exceeded bounded pages")
    except RuntimeError as exc:
        result.errors.append(str(exc))
        return

    picked = 0
    for row in rows:
        if not isinstance(row, dict):
            result.errors.append("OpenClaw session inventory contains invalid row")
            continue
        key = str(row.get("key") or "")
        if not key.startswith(f"agent:{agent}:") or _timestamp(row.get("updatedAt")) < horizon:
            continue
        # A native owner flag inside group, agent or scheduled content never
        # turns that entire conversation into the owner's private memory.
        if any(marker in key for marker in (":cron:", ":subagent:", ":heartbeat:")):
            reject(result, "cron_or_automation")
            continue
        state = _session_registry_state(row, allowed_owners)
        if state != "owner":
            reject(result, "non_owner_user" if state == "non_owner" else "unknown_kind")
            continue
        if picked >= max_files:
            result.errors.append("OpenClaw owner sessions exceeded collection limit")
            break
        picked += 1
        result.sourceFilesSeen += 1
        session_id = str(row.get("sessionId") or "")
        if not session_id:
            result.errors.append("OpenClaw owner session has no stable identity")
            continue
        source_key = f"{agent}/native/{hashlib.sha256(key.encode()).hexdigest()[:20]}"
        prior = store.get(source_key) or {}
        same_session = prior.get("sessionId") == session_id
        if same_session and prior.get("updatedAtMs") == row.get("updatedAt"):
            result.stagedWatermarks[source_key] = prior
            continue
        try:
            history = rpc(home, "sessions.get", {
                "key": key, "agentId": agent, "limit": schema.MAX_EVENTS_PER_FILE,
            })
            messages = history.get("messages")
            if not isinstance(messages, list):
                raise RuntimeError("OpenClaw session history has invalid shape")
            # Do not advance past an unseen tail or quietly lose old messages.
            if len(messages) >= schema.MAX_EVENTS_PER_FILE:
                raise RuntimeError("OpenClaw history reached limit; collection incomplete")
        except RuntimeError as exc:
            result.errors.append(str(exc))
            continue
        old_ids = set(prior.get("eventIds", [])) if same_session else set()
        new_ids = []
        start_observations = len(result.observations)
        invalid = False
        for message in messages:
            if not isinstance(message, dict):
                result.errors.append("OpenClaw history contains invalid message")
                invalid = True
                break
            meta = message.get("__openclaw") or {}
            if not isinstance(meta, dict):
                meta = {}
            event_id = str(meta.get("id") or "")
            if not event_id:
                result.errors.append("OpenClaw history lacks stable event identity")
                invalid = True
                break
            new_ids.append(event_id)
            if event_id in old_ids:
                continue
            result.sourceEventsSeen += 1
            role = message.get("role")
            if role != "user":
                reject(result, "assistant_claim" if role == "assistant" else
                       "tool_output" if role in ("tool", "toolResult") else "system")
                continue
            provenance = message.get("provenance")
            if provenance:
                # Inter-session announcements and injected messages are data
                # from an agent even when displayed inside the owner's DM.
                reject(result, "cron_or_automation")
                continue
            native_owner = _native_owner_flag(message)
            if native_owner is False:
                reject(result, "non_owner_user")
                continue
            owner_id = _message_owner_id({}, message)
            if owner_id and owner_id not in allowed_owners:
                reject(result, "non_owner_user")
                continue
            text = _event_text(message)
            if _is_cron_prompt(text):
                reject(result, "cron_or_automation")
                continue
            observed = _timestamp(message.get("timestamp") or meta.get("recordTimestampMs"))
            if not observed:
                reject(result, "malformed")
                continue
            if observed < horizon:
                continue
            if len(result.observations) >= schema.MAX_OBSERVATIONS_PER_COLLECTOR:
                result.errors.append("OpenClaw observations exceeded collection limit")
                invalid = True
                break
            build_observation(
                result, text=text, trust=classify_memory_intent(text),
                session_id=session_id, event_id=event_id,
                observed_at=datetime.fromtimestamp(observed, timezone.utc).isoformat(),
                source_ref=source_key,
            )
        if invalid:
            del result.observations[start_observations:]
            continue
        # Empty history with an existing nonempty watermark is not evidence
        # that all old events have been read; surface a reset for investigation.
        if same_session and old_ids and not old_ids.intersection(new_ids):
            result.errors.append("OpenClaw history identity changed; watermark retained")
            del result.observations[start_observations:]
            continue
        result.stagedWatermarks[source_key] = {
            "sessionId": session_id, "updatedAtMs": row.get("updatedAt"),
            "eventIds": new_ids,
        }
