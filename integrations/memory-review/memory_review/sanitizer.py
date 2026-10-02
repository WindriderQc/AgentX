"""Defense-in-depth content sanitation for memory-review collectors.

Layer 1 of the guard stack (collector-side). AgentX Core re-runs an equivalent
authoritative guard server-side
(core/src/services/memoryReview/contentGuard.js,
a superset of the nestor-memory secret guard), and again before any apply.
Patterns here deliberately mirror the server set — if you extend one, extend
both and the tests that pin them.

Policy:
- secret-like content is REJECTED before model synthesis (not merely redacted);
  redaction here exists so logs/diagnostics never carry the original value.
- prompt-injection-shaped and encoded content is rejected (tainted) — user
  messages are data, never instructions to the synthesis model.
- recalled memory blocks and previous review proposals are stripped so memory
  cannot reinforce itself.
"""

from __future__ import annotations

import re
import unicodedata

# --- secret patterns ---------------------------------------------------------
# Base five mirror core/src/services/nestorMemoryService.js
# SECRET_PATTERNS;
# the rest extend coverage per the memory-review policy.
SECRET_PATTERNS: tuple[re.Pattern, ...] = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----", re.IGNORECASE),
    re.compile(r"\b(sk-[A-Za-z0-9_-]{20,})\b"),
    re.compile(r"\b(gh[pousr]_[A-Za-z0-9_]{20,})\b"),
    re.compile(r"\b(xox[baprs]-[A-Za-z0-9-]{20,})\b"),
    re.compile(
        r"\b(api[_-]?key|secret|token|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)"
        r"\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{8,}",
        re.IGNORECASE,
    ),
    re.compile(r"\bbearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE),
    re.compile(r"\bauthorization\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9-]*\s+)?\S{8,}", re.IGNORECASE),
    re.compile(r"\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqps?|https?)://[^/\s:@]+:[^@\s]+@", re.IGNORECASE),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b"),
)

# Conservative prompt-injection indicators: role/instruction override,
# credential requests, exfiltration or tool-use directives.
INJECTION_PATTERNS: tuple[re.Pattern, ...] = (
    re.compile(r"ignore\s+(?:all\s+|any\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|context|prompts)", re.IGNORECASE),
    re.compile(r"disregard\s+(?:the\s+)?(?:system|previous|prior)\s+(?:prompt|instructions|rules)", re.IGNORECASE),
    re.compile(r"\bnew\s+system\s+prompt\b", re.IGNORECASE),
    re.compile(r"\byou\s+are\s+now\s+(?:the\s+)?(?:system|admin|root|developer|dan)\b", re.IGNORECASE),
    re.compile(r"\breveal\s+(?:your\s+)?(?:system\s+prompt|instructions|secrets?|api\s+keys?|credentials)", re.IGNORECASE),
    re.compile(r"\bsend\s+(?:me\s+|us\s+)?(?:your\s+|the\s+)?(?:api\s+key|password|token|credentials)", re.IGNORECASE),
    re.compile(r"</?\s*system\s*>", re.IGNORECASE),
    re.compile(r"\bcurl\b[^\n]{0,120}\|\s*(?:ba)?sh\b", re.IGNORECASE),
    re.compile(r"\b(?:exfiltrate|post\s+this\s+to\s+https?://)", re.IGNORECASE),
)

# Encoded blobs are opaque; opaque content is not admissible evidence.
_BASE64_BLOB = re.compile(r"[A-Za-z0-9+/=]{200,}")

# Invisible / bidi-control characters (Hermes/AgentX policies detect these too).
# Explicit escapes only - literal invisibles in source would be unauditable.
_INVISIBLE = re.compile(
    "[\u200b-\u200f"  # zero-width space/joiners + LRM/RLM
    "\u202a-\u202e"    # bidi embedding/override
    "\u2060-\u2064"    # word-joiner + invisible operators
    "\u2066-\u2069"    # bidi isolates
    "\ufeff]"             # BOM / ZWNBSP
)

# --- recalled-context / self-reinforcement markers ---------------------------
RECALLED_CONTEXT_BLOCK = re.compile(
    r"##\s*Recalled context \(RAG memory\).*?(?=\n##\s|\Z)", re.DOTALL
)
SYSTEM_REMINDER_BLOCK = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)

# If one of these survives stripping, the message IS a prior proposal/report —
# re-learning it would let memory reinforce itself.
PREVIOUS_PROPOSAL_MARKERS = (
    "Memory maintenance for Nestor",
    "# Nestor Memory Review Proposal",
    "## Candidate Preferences",
    "[memory-review:evidence]",
    "Ecosystem Memory Review run report",
)

# Harness-injected wrappers (never operator prose). Tag content is dropped.
_HARNESS_TAGS = (
    "system-reminder",
    "command-name", "command-message", "command-args", "command-contents",
    "local-command-stdout", "local-command-stderr",
    "environment_context", "user_instructions", "turn_context", "permissions",
    "environment_details", "ide_context", "repo_context", "system_context",
    "task-notification", "session-context",
)
_HARNESS_BLOCK = re.compile(
    r"<(" + "|".join(_HARNESS_TAGS) + r")\b[^>]*>.*?</\1>",
    re.DOTALL | re.IGNORECASE,
)
_HARNESS_OPEN_TAIL = re.compile(
    r"<(" + "|".join(_HARNESS_TAGS) + r")\b[^>]*>.*\Z",
    re.DOTALL | re.IGNORECASE,
)

# Pasted-content heuristics: bulk quoted/fenced/oversized content must not
# inherit owner trust automatically.
_FENCE_BLOCK = re.compile(r"```.*?```", re.DOTALL)
_QUOTE_RUN = re.compile(r"(?:^>\s?.*\n){8,}", re.MULTILINE)
PASTED_LENGTH_THRESHOLD = 2500


def contains_secret(text: str) -> bool:
    return any(p.search(text) for p in SECRET_PATTERNS)


def redact(text: str) -> str:
    """Replace secret-like spans. For logs/diagnostics only — secret-bearing
    observations are rejected outright, never submitted redacted."""
    value = text
    for pattern in SECRET_PATTERNS:
        value = pattern.sub("[REDACTED]", value)
    return value


def find_injection(text: str) -> str | None:
    for pattern in INJECTION_PATTERNS:
        match = pattern.search(text)
        if match:
            return match.group(0)[:60]
    if _BASE64_BLOB.search(text):
        return "base64-blob"
    return None


def strip_invisible(text: str) -> tuple[str, bool]:
    found = bool(_INVISIBLE.search(text))
    if not found:
        return text, False
    return _INVISIBLE.sub("", text), True


def strip_harness_context(text: str) -> str:
    value = SYSTEM_REMINDER_BLOCK.sub("", text)
    value = _HARNESS_BLOCK.sub("", value)
    # An opening harness tag whose close was truncated away swallows the rest.
    value = _HARNESS_OPEN_TAIL.sub("", value)
    value = RECALLED_CONTEXT_BLOCK.sub("", value)
    return value.strip()


def is_previous_proposal(text: str) -> bool:
    return any(marker in text for marker in PREVIOUS_PROPOSAL_MARKERS)


def looks_pasted(text: str) -> bool:
    if len(text) > PASTED_LENGTH_THRESHOLD:
        return True
    for match in _FENCE_BLOCK.finditer(text):
        if len(match.group(0)) > 400:
            return True
    return bool(_QUOTE_RUN.search(text))


def has_control_chars(text: str) -> bool:
    return any(
        unicodedata.category(ch) in ("Cc", "Cf") and ch not in "\n\r\t"
        for ch in text
    )
