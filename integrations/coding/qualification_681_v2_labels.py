"""Normalization helpers for qualification 681 v2 synthetic label fixtures.

This module is an isolated draft fixture used by the Coding Team; it is not
part of the product surface and must not be merged or deployed.
"""


def normalize_labels(labels, *, case_sensitive=True):
    """Return a new, normalized list of label strings.

    Each string is trimmed, empty strings are discarded, and duplicates are
    dropped, with the order and spelling of the first occurrence preserved.
    The input list is never mutated.

    With ``case_sensitive=True`` (the default), equality is exact: ``Alpha``
    and ``alpha`` are kept distinct. With ``case_sensitive=False``, equality
    is decided on ``str.casefold()`` of the trimmed label, so case variants
    fold to one entry while the first occurrence's spelling is preserved
    (e.g. ``"Alpha"`` before ``"alpha"`` keeps ``"Alpha"``; ``"Straße"``
    before ``"STRASSE"`` keeps ``"Straße"``).
    """
    normalized = []
    seen = set()
    for label in labels:
        trimmed = label.strip()
        if not trimmed:
            continue
        key = trimmed if case_sensitive else trimmed.casefold()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(trimmed)
    return normalized
