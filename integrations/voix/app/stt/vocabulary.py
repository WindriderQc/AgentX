"""Conservative transcript normalization for product names.

The rules in this file cover only the product's own names. Names that belong to
one household (people, places, pets) are instance data: they come from a JSON
file named by ``VOIX_STT_CORRECTIONS_PATH``, kept outside this repository.

That file is a list of ``{"pattern": "<regular expression>", "replacement": "<text>"}``
objects. Patterns are matched case-insensitively, after the built-in rules.
"""
from __future__ import annotations

import json
import logging
import re
from functools import lru_cache
from pathlib import Path

from app.config import settings

_LOG = logging.getLogger(__name__)

_CANONICAL = (
    (re.compile(r"\bnestor\b", re.IGNORECASE), "Nestor"),
    (re.compile(r"\bagent[\s-]*x\b", re.IGNORECASE), "AgentX"),
    (re.compile(r"\bopen[\s-]*(?:claw|claude|cloud)\b", re.IGNORECASE), "OpenClaw"),
)

_GREETING_NESTOR = re.compile(
    r"\b(salut|bonjour|all[oô]|hey)([,.]?\s+)(?:(?:le|les|la)\s+|l['’])?stores?\b",
    re.IGNORECASE,
)
_ADDRESS_NESTOR = re.compile(
    r"\b((?:parle|parler|demande|dire)\s+(?:à|a|au)\s+)(?:(?:le|les|la)\s+|l['’])?stores?\b",
    re.IGNORECASE,
)
_SHORT_VOIX = re.compile(r"\bvoi\b", re.IGNORECASE)
_LEADING_PRODUCT_VOIX = re.compile(
    r"^\s*voix(?=\s+(?:doit\s+comprendre|fonctionne|démarre|répond)\b)",
    re.IGNORECASE,
)


def load_corrections(path: str | Path) -> tuple[tuple[re.Pattern, str], ...]:
    """Read instance corrections. A missing or invalid file disables them with a warning."""
    if not str(path or "").strip():
        return ()
    try:
        rows = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(rows, list):
            raise ValueError("expected a JSON list")
        return tuple(
            (re.compile(str(row["pattern"]), re.IGNORECASE), str(row["replacement"]))
            for row in rows
        )
    except (OSError, ValueError, TypeError, KeyError, re.error) as exc:
        # The file content is instance data: name the failure, never the content.
        _LOG.warning("Transcript corrections were not loaded (%s); built-in rules only.",
                     type(exc).__name__)
        return ()


@lru_cache(maxsize=1)
def _instance_corrections() -> tuple[tuple[re.Pattern, str], ...]:
    return load_corrections(settings.stt_corrections_path)


def normalize_transcript(text: str, corrections=None) -> str:
    """Canonicalize known names without rewriting ordinary French vocabulary.

    Ambiguous acoustic forms are corrected only in strong conversational or
    product-list contexts. For example, ``les stores`` remains untouched in
    ``ferme les stores`` but becomes ``Nestor`` after a greeting.
    """
    value = str(text or "").strip()
    if not value:
        return ""
    value = _GREETING_NESTOR.sub(lambda match: f"{match.group(1)}{match.group(2)}Nestor", value)
    value = _ADDRESS_NESTOR.sub(lambda match: f"{match.group(1)}Nestor", value)
    for pattern, replacement in _CANONICAL:
        value = pattern.sub(replacement, value)
    for pattern, replacement in (_instance_corrections() if corrections is None else corrections):
        value = pattern.sub(replacement, value)
    value = _LEADING_PRODUCT_VOIX.sub("VoiX", value)
    if "AgentX" in value or "OpenClaw" in value:
        value = _SHORT_VOIX.sub("VoiX", value)
    return value
