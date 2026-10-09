"""Shared vocabulary and bounded-shape validation for memory review.

Deterministic only: no I/O, no model calls. Core (/api/memory-review)
revalidates everything independently — these bounds exist so a collector
cannot even build an oversized or unclassified payload, and so the synthesis
output contract is checked before anything is submitted.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime

SCHEMA_VERSION = 2

# Host-local collector identities remain specific because they own independent
# watermarks and provenance rules. AgentX's product API intentionally exposes
# only generic external-runtime ownership after the private-adapter extraction.
COLLECTOR_RUNTIMES = ("claude-code", "codex", "openclaw", "hermes", "git")
RUNTIMES = ("agentx", "claude-code", "codex", "external")
AGENTX_RUNTIME_BY_COLLECTOR = {
    "claude-code": "claude-code",
    "codex": "codex",
    "openclaw": "external",
    "hermes": "external",
    # Accepted repository history is AgentX-side verified evidence, not a chat
    # runtime. It fills the `agentx` slot, which no collector had ever reported.
    "git": "agentx",
}


def agentx_runtime(runtime: str) -> str:
    """Translate a host-local collector identity to AgentX's public enum."""
    try:
        return AGENTX_RUNTIME_BY_COLLECTOR[runtime]
    except KeyError as exc:
        raise ValueError(f"unknown collector runtime: {runtime}") from exc

# --- trust model -------------------------------------------------------------
TRUST_ELIGIBLE = (
    "explicit_owner_instruction",
    "explicit_memory_request",
    "authenticated_owner_statement",
    "repeated_owner_preference",
    "verified_runtime_evidence",
    "observed_project_event",
    "verified_git_or_test_outcome",
    "household_member_statement",
)
TRUST_INELIGIBLE = (
    "assistant_claim",
    "tool_output",
    "recalled_context",
    "cron_or_automation",
    "subagent",
    "non_owner_user",
    "pasted_or_attached_content",
    "web_or_email_content",
    "unknown",
    "system",
)
TRUST_CLASSES = TRUST_ELIGIBLE + TRUST_INELIGIBLE

CANDIDATE_TYPES = (
    "preference",
    "durable_fact",
    "decision",
    "correction",
    "procedure",
    "inferred_pattern",
    "project_event",
    "reusable_skill_candidate",
    "session_summary",
    "duplicate",
    "stale_memory",
    "contradiction",
    "task_or_followup",
    "governed_source_change",
    "ephemeral",
    "sensitive_or_secret",
    "unsupported",
)

TARGET_KINDS = (
    "shared_fact",
    "soft_memory",
    "artifact",
    "runtime_local",
    "skill_draft",
    "pipeline_task",
    "git_change",
    "ignore",
)

TARGETS_BY_TYPE = {
    "preference": ("shared_fact", "runtime_local"),
    "durable_fact": ("shared_fact", "runtime_local"),
    "decision": ("shared_fact", "runtime_local"),
    "correction": ("shared_fact", "runtime_local"),
    "inferred_pattern": ("soft_memory",),
    "project_event": ("artifact",),
    "procedure": ("artifact",),
    "reusable_skill_candidate": ("skill_draft",),
    "session_summary": ("artifact",),
    "duplicate": ("ignore",),
    "stale_memory": ("ignore",),
    "contradiction": ("ignore",),
    "task_or_followup": ("pipeline_task",),
    "governed_source_change": ("git_change",),
    "ephemeral": ("ignore",),
    "sensitive_or_secret": ("ignore",),
    "unsupported": ("ignore",),
}

# Aggregate rejection reasons (counts only travel to the server, never content).
REJECTION_REASONS = (
    "assistant_claim",
    "tool_output",
    "system",
    "cron_or_automation",
    "subagent",
    "non_owner_user",
    "harness_context",
    "recalled_context",
    "previous_proposal",
    "pasted_untrusted",
    "injection_suspect",
    "secret_like",
    "invisible_unicode",
    "empty",
    "oversize",
    "malformed",
    "unknown_kind",
    "not_explicit_memory_request",
    "project_not_allowed",
)

# --- bounds: raw transcripts must not travel ---------------------------------
OBSERVATION_TEXT_MAX = 1200
EXCERPT_MAX = 280
STATEMENT_MAX = 500
RATIONALE_MAX = 500
MAX_OBSERVATIONS_PER_COLLECTOR = 120
MAX_OBSERVATIONS_PER_BATCH = 200
MAX_CANDIDATES_PER_RUN = 30
MAX_REVIEW_EXCEPTIONS = 5
MAX_FILES_PER_COLLECTOR = 40
MAX_NEW_BYTES_PER_FILE = 2 * 1024 * 1024
MAX_EVENTS_PER_FILE = 2000
MAX_DEDUP_CONTEXT_LINES = 60
DEFAULT_LOOKBACK_DAYS = 14


def normalize_text(text: str) -> str:
    """NFC-normalize and collapse whitespace so hashing is stable."""
    value = unicodedata.normalize("NFC", str(text or ""))
    return re.sub(r"\s+", " ", value).strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(normalize_text(text).lower().encode("utf-8")).hexdigest()


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 15)].rstrip() + "\n...[truncated]"


@dataclass
class Observation:
    """One sanitized, bounded, trust-classified unit of evidence."""

    runtime: str
    host: str
    text: str
    trust: str
    sessionId: str = ""
    eventId: str = ""
    observedAt: str = ""
    agentOrProfile: str = ""
    project: str = ""
    sourceRef: str = ""
    taints: list = field(default_factory=list)
    contentHash: str = ""

    def __post_init__(self) -> None:
        if self.runtime not in COLLECTOR_RUNTIMES:
            raise ValueError(f"unknown runtime: {self.runtime}")
        if self.trust not in TRUST_CLASSES:
            raise ValueError(f"unknown trust class: {self.trust}")
        self.text = str(self.text).strip()
        if len(self.text) > OBSERVATION_TEXT_MAX:
            raise ValueError("Observation exceeds its text bound; no evidence was shortened")
        if not self.contentHash:
            self.contentHash = content_hash(self.text)

    def to_payload(self) -> dict:
        return {
            "runtime": agentx_runtime(self.runtime),
            "host": self.host,
            "agentOrProfile": self.agentOrProfile or None,
            "project": self.project or None,
            "sessionId": self.sessionId,
            "eventId": self.eventId,
            "observedAt": self.observedAt,
            "trust": self.trust,
            "taints": list(self.taints),
            "text": self.text,
            "sourceRef": self.sourceRef,
            "contentHash": self.contentHash,
        }


class SynthesisOutputError(ValueError):
    """Raised when the model's structured output violates the contract."""


_ALLOWED_CANDIDATE_KEYS = {
    "type", "statement", "rationale", "target", "evidenceRefs", "confidence", "conflicts",
    "scope", "sensitivity", "impact", "stability", "validFrom", "validTo", "memoryKey",
}
_ALLOWED_TARGET_KEYS = {"kind", "runtime", "topic"}
MEMORY_SCOPES = ("project", "ecosystem", "workflow", "owner", "household", "private_domain")
SENSITIVITY_LEVELS = ("normal", "private", "highly_private")
IMPACT_LEVELS = ("context_only", "behavior_changing", "operational")
STABILITY_LEVELS = ("transient", "episodic", "durable")


def _enum(item: dict, key: str, allowed: tuple[str, ...], default: str, where: str) -> str:
    value = item.get(key, default)
    if value not in allowed:
        raise SynthesisOutputError(f"{where}.{key} invalid: {value!r}")
    return value


def _default_impact(ctype: str) -> str:
    if ctype in ("task_or_followup", "governed_source_change", "reusable_skill_candidate"):
        return "behavior_changing"
    return "context_only"


def _default_stability(ctype: str) -> str:
    if ctype == "inferred_pattern":
        return "transient"
    if ctype in ("project_event", "session_summary"):
        return "episodic"
    return "durable"


def _iso(value: object, where: str) -> str | None:
    raw = normalize_text(value)[:40]
    if not raw:
        return None
    try:
        datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SynthesisOutputError(f"{where} must be an ISO date/time") from exc
    return raw


def validate_candidates(payload: object, known_observation_ids: set[str]) -> list[dict]:
    """Strictly validate the synthesis JSON output. Returns cleaned candidates.

    The model cannot: invent evidence ids, exceed counts/lengths, use unknown
    types/targets/keys, or smuggle extra fields. Anything off-contract raises
    SynthesisOutputError (the caller gets one bounded repair retry).
    """
    if not isinstance(payload, dict):
        raise SynthesisOutputError("output is not a JSON object")
    extra = set(payload.keys()) - {"candidates"}
    if extra:
        raise SynthesisOutputError(f"unknown top-level keys: {sorted(extra)}")
    raw = payload.get("candidates")
    if not isinstance(raw, list):
        raise SynthesisOutputError("'candidates' must be a list")
    if len(raw) > MAX_CANDIDATES_PER_RUN:
        raise SynthesisOutputError(
            f"too many candidates ({len(raw)} > {MAX_CANDIDATES_PER_RUN})"
        )

    cleaned: list[dict] = []
    seen_statements: set[str] = set()
    for index, item in enumerate(raw):
        where = f"candidates[{index}]"
        if not isinstance(item, dict):
            raise SynthesisOutputError(f"{where} is not an object")
        extra = set(item.keys()) - _ALLOWED_CANDIDATE_KEYS
        if extra:
            raise SynthesisOutputError(f"{where} has unknown keys: {sorted(extra)}")
        ctype = item.get("type")
        if ctype not in CANDIDATE_TYPES:
            raise SynthesisOutputError(f"{where}.type invalid: {ctype!r}")
        statement = normalize_text(item.get("statement"))
        if not statement:
            raise SynthesisOutputError(f"{where}.statement is empty")
        if len(statement) > STATEMENT_MAX:
            raise SynthesisOutputError(f"{where}.statement exceeds {STATEMENT_MAX} chars")
        key = statement.lower()
        if key in seen_statements:
            raise SynthesisOutputError(f"{where}.statement duplicates an earlier candidate")
        seen_statements.add(key)
        rationale = normalize_text(item.get("rationale"))
        if len(rationale) > RATIONALE_MAX:
            raise SynthesisOutputError(f"{where}.rationale exceeds {RATIONALE_MAX} chars")
        target = item.get("target")
        if not isinstance(target, dict):
            raise SynthesisOutputError(f"{where}.target missing")
        if set(target.keys()) - _ALLOWED_TARGET_KEYS:
            raise SynthesisOutputError(f"{where}.target has unknown keys")
        if target.get("kind") not in TARGET_KINDS:
            raise SynthesisOutputError(f"{where}.target.kind invalid: {target.get('kind')!r}")
        if target.get("runtime") is not None and target.get("runtime") not in RUNTIMES:
            raise SynthesisOutputError(f"{where}.target.runtime invalid")
        allowed_targets = TARGETS_BY_TYPE.get(ctype, ())
        if target.get("kind") not in allowed_targets:
            raise SynthesisOutputError(
                f"{where}.target.kind {target.get('kind')!r} is not allowed for {ctype!r}"
            )
        if target.get("kind") == "runtime_local" and target.get("runtime") not in RUNTIMES:
            raise SynthesisOutputError(f"{where}.target.runtime is required for runtime_local")
        if target.get("kind") != "runtime_local" and target.get("runtime") is not None:
            raise SynthesisOutputError(
                f"{where}.target.runtime is only valid for runtime_local"
            )
        refs = item.get("evidenceRefs")
        if not isinstance(refs, list) or not refs:
            raise SynthesisOutputError(f"{where}.evidenceRefs must be a non-empty list")
        for ref in refs:
            if ref not in known_observation_ids:
                raise SynthesisOutputError(f"{where} cites unknown evidence ref {ref!r}")
        confidence = item.get("confidence", 0)
        if not isinstance(confidence, (int, float)) or not 0 <= float(confidence) <= 1:
            raise SynthesisOutputError(f"{where}.confidence must be within [0,1]")
        conflicts = item.get("conflicts", [])
        if conflicts and not isinstance(conflicts, list):
            raise SynthesisOutputError(f"{where}.conflicts must be a list")
        scope = _enum(item, "scope", MEMORY_SCOPES, "project", where)
        sensitivity_default = "private" if scope in ("owner", "household", "private_domain") else "normal"
        cleaned.append({
            "type": ctype,
            "statement": statement,
            "rationale": rationale,
            "target": {
                "kind": target["kind"],
                "runtime": target.get("runtime"),
                "topic": normalize_text(target.get("topic"))[:64] or None,
            },
            "evidenceRefs": [str(r) for r in refs][:20],
            "confidence": round(float(confidence), 3),
            "scope": scope,
            "sensitivity": _enum(item, "sensitivity", SENSITIVITY_LEVELS, sensitivity_default, where),
            "impact": _enum(item, "impact", IMPACT_LEVELS, _default_impact(ctype), where),
            "stability": _enum(item, "stability", STABILITY_LEVELS, _default_stability(ctype), where),
            "validFrom": _iso(item.get("validFrom"), f"{where}.validFrom"),
            "validTo": _iso(item.get("validTo"), f"{where}.validTo"),
            "memoryKey": re.sub(r"[^a-z0-9_.:-]+", "-", normalize_text(item.get("memoryKey")).lower()).strip("-")[:80] or None,
            "conflicts": [
                {"summary": normalize_text((c or {}).get("summary"))[:300]}
                for c in (conflicts or [])
                if isinstance(c, dict)
            ][:5],
        })
    return cleaned
