"""OpenClaw collector — native gateway history with legacy JSONL import.

Preserves the deployed openclaw_memory_maintenance.py conservatism (direct
user messages only) and adds the structural checks it lacked: per-session
watermarks instead of "latest three files", session-kind exclusion for
cron/heartbeat/automation prompts, tool-result exclusion, and the shared
sanitation pipeline.

Read-only guarantees: native REM/dreaming stays disabled by this code path;
`promote --apply` is never invoked; the memory SQLite index is never opened.
Comparative evidence from `openclaw memory rem-harness` is gathered by the
operator/runbook, not by this collector.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

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

SESSION_EXCLUDE_SUBSTRINGS = (".trajectory", ".deleted", ".reset")
OWNER_ID_PREFIXES = ("telegram:",)

# First-user-message prefixes are a conservative fallback for old session files.
# Current sessions also use the native sessions.json registry classification.
CRON_PROMPT_MARKERS = (
    "Memory maintenance for Nestor",
    "[cron]",
    "Cron job:",
    "Scheduled job:",
    "HEARTBEAT",
    "System heartbeat",
    "Read HEARTBEAT.md",
)


def default_home() -> Path:
    return Path(os.environ.get("OPENCLAW_HOME", str(Path.home() / ".openclaw"))).expanduser()


def _event_text(message: dict) -> str:
    parts: list[str] = []
    content = message.get("content")
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
    return "\n".join(p for p in parts if p).strip()


def _is_cron_prompt(text: str) -> bool:
    stripped = text.strip()
    return any(stripped.startswith(m) or m in stripped[:200] for m in CRON_PROMPT_MARKERS)


def _normalize_owner_id(value: object) -> str:
    text = str(value or "").strip()
    lowered = text.lower()
    for prefix in OWNER_ID_PREFIXES:
        if lowered.startswith(prefix):
            return text[len(prefix):].strip()
    return text


def _configured_owner_ids() -> tuple[str, ...]:
    raw = os.environ.get("AGENTX_MEMORY_REVIEW_OWNER_IDS", "")
    return tuple(
        normalized
        for part in raw.split(",")
        if (normalized := _normalize_owner_id(part))
    )


def _message_owner_id(event: dict, message: dict) -> str:
    for source in (message, event):
        for key in ("senderId", "userId", "ownerId", "from"):
            value = source.get(key)
            if isinstance(value, (str, int)) and str(value).strip():
                return _normalize_owner_id(value)
    return ""


def _session_registry_state(item: dict, allowed_owners: set[str]) -> str:
    origin = item.get("origin") if isinstance(item.get("origin"), dict) else {}
    chat_type = str(
        item.get("chatType")
        or item.get("chat_type")
        or origin.get("chatType")
        or origin.get("chat_type")
        or ""
    ).strip().lower()
    provider = str(
        origin.get("provider")
        or item.get("channel")
        or item.get("lastChannel")
        or ""
    ).strip().lower()
    if item.get("agentHarnessId") or chat_type in {
        "cron", "heartbeat", "subagent", "automation",
    }:
        return "automation"
    if chat_type in {"group", "channel"}:
        return "non_owner"

    owner_ids: set[str] = set()
    for source in (origin, item):
        for key in ("senderId", "userId", "ownerId", "from", "user_id"):
            value = source.get(key)
            if isinstance(value, (str, int)):
                normalized = _normalize_owner_id(value)
                if normalized:
                    owner_ids.add(normalized)

    origin_from = str(origin.get("from") or "").strip().lower()
    is_telegram_direct = chat_type in {"direct", "dm"} and (
        provider == "telegram" or origin_from.startswith("telegram:")
    )
    if not is_telegram_direct:
        return "unknown"
    matched = owner_ids & allowed_owners
    if matched and owner_ids <= allowed_owners:
        return "owner"
    if owner_ids and not matched:
        return "non_owner"
    return "unknown"


def _load_session_registry(
    sessions_dir: Path, allowed_owners: set[str]
) -> tuple[dict[str, str], bool]:
    registry_path = sessions_dir / "sessions.json"
    try:
        payload = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}, False

    if isinstance(payload, dict):
        entries = payload.values()
    elif isinstance(payload, list):
        entries = payload
    else:
        return {}, True

    states: dict[str, str] = {}
    for item in entries:
        if not isinstance(item, dict):
            continue
        filenames: set[str] = set()
        session_file = item.get("sessionFile") or item.get("session_file")
        if isinstance(session_file, str) and session_file.strip():
            filenames.add(Path(session_file).name)
        session_id = item.get("sessionId") or item.get("session_id")
        if isinstance(session_id, str) and session_id.strip():
            filenames.add(f"{session_id.strip()}.jsonl")
        state = _session_registry_state(item, allowed_owners)
        for filename in filenames:
            previous = states.get(filename)
            states[filename] = state if previous in (None, state) else "unknown"
    return states, True


def _native_owner_flag(message: dict) -> bool | None:
    """OpenClaw 2026.7+ stamps channel turns with its resolved owner check.

    Prefer that runtime-native decision over a second copied allowlist. Older
    session schemas fall back to AGENTX_MEMORY_REVIEW_OWNER_IDS below.
    """
    metadata = message.get("__openclaw")
    if not isinstance(metadata, dict) or "senderIsOwner" not in metadata:
        return None
    return metadata.get("senderIsOwner") is True


def collect(
    *,
    home: Path | None = None,
    store: WatermarkStore,
    agents: tuple[str, ...] = ("main",),
    lookback_days: int = schema.DEFAULT_LOOKBACK_DAYS,
    max_files: int = schema.MAX_FILES_PER_COLLECTOR,
    owner_ids: tuple[str, ...] | None = None,
) -> CollectorResult:
    base = Path(home) if home else default_home()
    result = CollectorResult(runtime="openclaw", host=host_name())
    result.watermarkBefore = store.token()
    allowed_owners = {
        normalized
        for value in (owner_ids if owner_ids is not None else _configured_owner_ids())
        if (normalized := _normalize_owner_id(value))
    }
    found_any = False
    per_agent_files = max(1, max_files // max(1, len(agents)))
    for agent in agents:
        native_store = base / "agents" / agent / "agent" / "openclaw-agent.sqlite"
        if native_store.exists():
            from .openclaw_gateway import collect_gateway

            found_any = True
            result.agentOrProfile = agent
            collect_gateway(
                home=base, agent=agent, store=store, result=result,
                lookback_days=lookback_days, max_files=per_agent_files,
                allowed_owners=allowed_owners,
            )
            _load_dedup_context(base, agent, result)
            continue
        sessions_dir = base / "agents" / agent / "sessions"
        if not sessions_dir.exists():
            result.errors.append(f"sessions dir missing: {sessions_dir}")
            continue
        found_any = True
        result.agentOrProfile = agent
        _collect_agent(
            agent, sessions_dir, store, result, lookback_days, per_agent_files, allowed_owners
        )
        _load_dedup_context(base, agent, result)

    if not found_any:
        return result
    result.watermarkAfter = f"staged:{len(result.stagedWatermarks)}"
    return result


def _collect_agent(
    agent: str,
    sessions_dir: Path,
    store: WatermarkStore,
    result: CollectorResult,
    lookback_days: int,
    max_files: int,
    allowed_owners: set[str],
) -> None:
    registry_states, registry_available = _load_session_registry(
        sessions_dir, allowed_owners
    )
    files = discover_files(
        sessions_dir,
        ("*.jsonl",),
        exclude_substrings=SESSION_EXCLUDE_SUBSTRINGS,
        lookback_days=lookback_days,
        max_files=max_files,
    )
    result.sourceFilesSeen += len(files)

    for path in files:
        source_key = f"{agent}/{path.name}"
        registry_state = registry_states.get(
            path.name, "legacy_unregistered" if registry_available else "unknown"
        )
        prior = store.get(source_key) or {}
        prior_meta = prior.get("meta") if isinstance(prior.get("meta"), dict) else {}
        session_is_automation = (
            bool(prior_meta.get("automation")) or registry_state == "automation"
        )
        saw_first_user = bool(prior_meta.get("sawFirstUser"))

        for event in read_new_jsonl(path, store, result, source_key=source_key):
            if event.get("type") != "message":
                # session / model_change / thinking_level_change / custom
                continue
            message = event.get("message")
            if not isinstance(message, dict):
                reject(result, "malformed")
                continue
            role = message.get("role")
            if role == "assistant":
                reject(result, "assistant_claim")
                continue
            if role in ("toolResult", "tool"):
                reject(result, "tool_output")
                continue
            if role != "user":
                reject(result, "system")
                continue

            text = _event_text(message)
            if not saw_first_user:
                saw_first_user = True
                if _is_cron_prompt(text):
                    session_is_automation = True
            if session_is_automation or _is_cron_prompt(text):
                reject(result, "cron_or_automation")
                continue
            native_owner = _native_owner_flag(message)
            if native_owner is False:
                reject(result, "non_owner_user")
                continue
            if native_owner is None:
                owner_id = _message_owner_id(event, message)
                if not allowed_owners:
                    reject(result, "unknown_kind")
                    drift = (
                        "owner-identity-unavailable: OpenClaw owner allowlist is "
                        "not configured for legacy provenance"
                    )
                    if drift not in result.drift:
                        result.drift.append(drift)
                    continue
                if registry_state == "non_owner":
                    reject(result, "non_owner_user")
                    continue
                if registry_state == "owner":
                    if owner_id and owner_id not in allowed_owners:
                        reject(result, "non_owner_user")
                        continue
                elif owner_id:
                    if owner_id not in allowed_owners:
                        reject(result, "non_owner_user")
                        continue
                else:
                    reject(result, "unknown_kind")
                    if registry_state == "legacy_unregistered":
                        drift = (
                            "legacy-session-unregistered: unregistered OpenClaw session "
                            "remains local and ineligible"
                        )
                    else:
                        drift = (
                            "owner-identity-unavailable: registered OpenClaw session lacks "
                            "native or allowlisted owner provenance"
                        )
                    if drift not in result.drift:
                        result.drift.append(drift)
                    continue

            build_observation(
                result,
                text=text,
                trust=classify_memory_intent(text),
                session_id=path.stem,
                event_id=str(event.get("id") or ""),
                observed_at=str(event.get("timestamp") or ""),
                source_ref=source_key,
            )

        staged = result.stagedWatermarks.get(source_key)
        if staged is not None:
            meta = dict(staged.get("meta") or {})
            meta["automation"] = session_is_automation
            meta["sawFirstUser"] = saw_first_user
            staged["meta"] = meta


def _load_dedup_context(base: Path, agent: str, result: CollectorResult) -> None:
    """Indexed workspace memory titles are dedup context — bodies stay local."""
    workspace = base / f"workspace-{agent}"
    index = workspace / "MEMORY.md"
    if index.exists():
        try:
            for line in index.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if (line.startswith("#") or line.startswith("- ")) and len(
                    result.localDedupContext
                ) < schema.MAX_DEDUP_CONTEXT_LINES:
                    result.localDedupContext.append("openclaw-memory: " + sanitizer.redact(line))
        except OSError:
            pass
    topics = workspace / "memory"
    if topics.exists():
        try:
            for path in sorted(topics.glob("*.md"))[:20]:
                if len(result.localDedupContext) < schema.MAX_DEDUP_CONTEXT_LINES:
                    result.localDedupContext.append(f"openclaw-memory-topic: {path.name}")
        except OSError:
            pass
