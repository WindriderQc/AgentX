"""Hermes collector — uses Hermes' read-only session export on its host.

Preferred source: ``hermes sessions export --only user-prompts --redact``.
Older/test installations fall back to <hermes_home>/sessions/*.jsonl.
`request_dump_*.json` files are raw model-request dumps (full prompt context,
cron traffic in the filename) — structurally excluded, never parsed.

MEMORY.md / USER.md are Hermes-local memory: they are deduplication context
(bounded, redacted lines), never new evidence, and are never modified.
Skill names from the Curator-managed skills directory serve only to dedup
reusable_skill_candidate proposals; no Curator command is ever invoked.
"""

from __future__ import annotations

import os
import json
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from .. import schema, sanitizer
from ..watermarks import WatermarkStore
from . import (
    CollectorResult,
    build_observation,
    classify_memory_intent,
    discover_files,
    host_name,
    read_new_jsonl,
    reject,
)

SESSION_EXCLUDE_SUBSTRINGS = ("request_dump", "cron", "heartbeat", "subagent")


def _configured_owner_ids() -> tuple[str, ...]:
    raw = os.environ.get("AGENTX_MEMORY_REVIEW_OWNER_IDS", "")
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _line_owner_id(line: dict) -> str:
    for key in ("senderId", "userId", "ownerId", "from"):
        value = line.get(key)
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value).strip()
    return ""


def default_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()


def _native_cli(base: Path) -> Path | None:
    choices = [
        base / "hermes-agent" / ".venv" / "bin" / "hermes",
    ]
    found = shutil.which("hermes")
    if found:
        choices.append(Path(found))
    return next((path for path in choices if path and path.exists()), None)


def _run_native(
    command: list[str],
    runner: Callable[..., subprocess.CompletedProcess] | None,
) -> subprocess.CompletedProcess:
    execute = runner or subprocess.run
    return execute(command, capture_output=True, text=True, timeout=60, check=False)


def _parse_time(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _native_sessions(
    base: Path,
    allowed_owners: set[str],
    lookback_days: int,
    max_files: int,
) -> list[dict]:
    """Select trusted direct sessions from Hermes' local metadata index.

    Export filters are incomplete on Hermes 0.18.x, so select by structural
    platform/chat/user metadata here, then ask the public CLI to export each
    stable session id. No prompt text is read from this index.
    """
    index = base / "sessions" / "sessions.json"
    try:
        data = json.loads(index.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, dict):
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, lookback_days))
    selected = []
    for item in data.values():
        if not isinstance(item, dict):
            continue
        origin = item.get("origin") if isinstance(item.get("origin"), dict) else {}
        platform = str(item.get("platform") or origin.get("platform") or "").lower()
        chat_type = str(item.get("chat_type") or origin.get("chat_type") or "").lower()
        owner = str(origin.get("user_id") or "")
        session_id = str(item.get("session_id") or "")
        changed = str(item.get("updated_at") or item.get("created_at") or "")
        changed_at = _parse_time(changed)
        if (
            platform == "telegram"
            and chat_type == "dm"
            and owner in allowed_owners
            and session_id
            and changed_at
            and changed_at >= cutoff
        ):
            selected.append({"sessionId": session_id, "updatedAt": changed})
    selected.sort(key=lambda item: item["updatedAt"], reverse=True)
    return selected[:max_files]


def _line_text(line: dict) -> str:
    if isinstance(line.get("text"), str):
        return line["text"].strip()
    content = line.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(p for p in parts if p).strip()
    return ""


def collect(
    *,
    home: Path | None = None,
    store: WatermarkStore,
    lookback_days: int = schema.DEFAULT_LOOKBACK_DAYS,
    max_files: int = schema.MAX_FILES_PER_COLLECTOR,
    owner_ids: tuple[str, ...] | None = None,
    native_cli: Path | None = None,
    native_runner: Callable[..., subprocess.CompletedProcess] | None = None,
) -> CollectorResult:
    base = Path(home) if home else default_home()
    result = CollectorResult(runtime="hermes", host=host_name())
    result.watermarkBefore = store.token()
    allowed_owners = set(owner_ids if owner_ids is not None else _configured_owner_ids())
    sessions_dir = base / "sessions"
    if not sessions_dir.exists():
        result.errors.append(f"sessions dir missing: {sessions_dir}")
        return result

    cli = native_cli or _native_cli(base)
    if cli and allowed_owners:
        sessions = _native_sessions(base, allowed_owners, lookback_days, max_files)
        if sessions:
            _collect_native(cli, sessions, store, result, native_runner)
            _load_dedup_context(base, result)
            result.watermarkAfter = f"staged:{len(result.stagedWatermarks)}"
            return result
        result.drift.append(
            "owner-session-unavailable: no recent Hermes direct session matched the owner allowlist"
        )
    elif cli:
        result.drift.append(
            "owner-identity-unconfigured: Hermes native export remains local and ineligible"
        )

    if not allowed_owners:
        result.drift.append(
            "owner-identity-unconfigured: Hermes JSONL fallback remains local and ineligible"
        )

    files = discover_files(
        sessions_dir,
        ("*.jsonl",),
        exclude_substrings=SESSION_EXCLUDE_SUBSTRINGS,
        lookback_days=lookback_days,
        max_files=max_files,
    )
    result.sourceFilesSeen = len(files)

    for path in files:
        source_key = path.name
        for line in read_new_jsonl(path, store, result, source_key=source_key):
            role = line.get("role")
            if role in ("session_meta", "system", "developer"):
                reject(result, "system")
                continue
            if role == "assistant":
                reject(result, "assistant_claim")
                continue
            if role in ("tool", "toolResult", "tool_result"):
                reject(result, "tool_output")
                continue
            if role != "user":
                reject(result, "unknown_kind")
                continue
            kind_markers = " ".join(
                str(line.get(key) or "") for key in ("source", "sessionType", "channel")
            ).lower()
            if any(marker in kind_markers for marker in ("cron", "heartbeat", "subagent", "automation")):
                reject(result, "cron_or_automation")
                continue
            owner_id = _line_owner_id(line)
            if not allowed_owners or not owner_id:
                reject(result, "unknown_kind")
                continue
            if owner_id not in allowed_owners:
                reject(result, "non_owner_user")
                continue
            text = _line_text(line)
            build_observation(
                result,
                text=text,
                trust=classify_memory_intent(text),
                session_id=path.stem,
                event_id="",
                observed_at=str(line.get("timestamp") or ""),
                source_ref=source_key,
            )

    _load_dedup_context(base, result)
    result.watermarkAfter = f"staged:{len(result.stagedWatermarks)}"
    return result


def _collect_native(
    cli: Path,
    sessions: list[dict],
    store: WatermarkStore,
    result: CollectorResult,
    runner: Callable[..., subprocess.CompletedProcess] | None,
) -> None:
    """Collect bounded, redacted owner prompts through Hermes' public CLI."""
    result.sourceFilesSeen = len(sessions)
    for session in sessions:
        session_id = session["sessionId"]
        source_updated_at = session["updatedAt"]
        source_key = "native-cli/session/" + schema.content_hash(session_id)[:16]
        prior = store.get(source_key) or {}
        prior_meta = prior.get("meta") if isinstance(prior.get("meta"), dict) else {}
        if prior and prior_meta.get("sourceUpdatedAt") == source_updated_at:
            result.stagedWatermarks[source_key] = prior
            continue
        after = str(prior_meta.get("after") or "")
        seen_at_after = set(prior_meta.get("seenAtAfter") or [])
        command = [
            str(cli), "sessions", "export", "--format", "jsonl",
            "--only", "user-prompts", "--redact", "--yes",
            "--session-id", session_id, "-",
        ]
        try:
            response = _run_native(command, runner)
        except (OSError, subprocess.SubprocessError):
            result.errors.append(f"{source_key}: Hermes session export failed")
            continue
        if response.returncode != 0:
            result.errors.append(f"{source_key}: Hermes session export exited {response.returncode}")
            continue

        encoded = response.stdout.encode("utf-8", errors="replace")
        if len(encoded) > schema.MAX_NEW_BYTES_PER_FILE:
            encoded = encoded[: schema.MAX_NEW_BYTES_PER_FILE]
            encoded = encoded[: encoded.rfind(b"\n") + 1]
            reject(result, "oversize")

        newest = after
        newest_ids = set(seen_at_after)
        for raw in encoded.decode("utf-8", errors="replace").splitlines()[: schema.MAX_EVENTS_PER_FILE]:
            if not raw.strip():
                continue
            result.sourceEventsSeen += 1
            try:
                line = json.loads(raw)
            except ValueError:
                reject(result, "malformed")
                continue
            if not isinstance(line, dict) or line.get("role") != "user":
                reject(result, "unknown_kind")
                continue
            text = _line_text(line)
            observed_at = str(line.get("created_at") or line.get("timestamp") or "")
            identity = "|".join(
                str(line.get(key) or "") for key in ("session_id", "message_id", "index")
            ) + "|" + observed_at + "|" + schema.content_hash(text)
            event_hash = schema.content_hash(identity)[:24]
            if after and (observed_at < after or (observed_at == after and event_hash in seen_at_after)):
                continue
            build_observation(
                result,
                text=text,
                trust=classify_memory_intent(text),
                session_id="sha256:" + schema.content_hash(str(line.get("session_id") or ""))[:24],
                event_id="sha256:" + event_hash,
                observed_at=observed_at,
                source_ref=source_key,
            )
            if observed_at > newest:
                newest, newest_ids = observed_at, {event_hash}
            elif observed_at == newest:
                newest_ids.add(event_hash)

        result.stagedWatermarks[source_key] = {
            "size": 0,
            "mtimeNs": 0,
            "offset": 0,
            "sig": "",
            "sigLen": 0,
            "sessionId": source_key,
            "meta": {
                "after": newest,
                "seenAtAfter": sorted(newest_ids)[:200],
                "sourceUpdatedAt": source_updated_at,
            },
        }


def _load_dedup_context(base: Path, result: CollectorResult) -> None:
    for name in ("MEMORY.md", "USER.md"):
        path = base / "memories" / name
        if not path.exists():
            continue
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if line and not line.startswith("<!--") and len(
                    result.localDedupContext
                ) < schema.MAX_DEDUP_CONTEXT_LINES:
                    result.localDedupContext.append(f"hermes-{name}: " + sanitizer.redact(line)[:200])
        except OSError:
            continue

    skills = base / "skills"
    if skills.exists():
        try:
            for child in sorted(skills.iterdir())[:40]:
                if child.is_dir() and len(result.localDedupContext) < schema.MAX_DEDUP_CONTEXT_LINES:
                    result.localDedupContext.append(f"hermes-skill: {child.name}")
        except OSError:
            pass
