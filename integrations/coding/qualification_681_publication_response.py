"""Normalization helpers for qualification 681 publication response fixtures.

This module is an isolated draft fixture used by the Coding Team; it is not
part of the product surface and must not be merged or deployed.
"""


def normalize_ticket_ids(values):
    """Return a tuple of normalized ticket id strings.

    Each string is stripped of surrounding whitespace, empty strings are
    discarded, and duplicates are dropped, preserving the order and spelling
    of the first occurrence. Non-string entries are rejected with
    ``TypeError``; integers are never coerced, and the order is never sorted.
    An empty iterable returns ``()``.
    """
    normalized = []
    seen = set()
    for value in values:
        if not isinstance(value, str):
            raise TypeError(
                f"ticket id must be a string, got {type(value).__name__}"
            )
        trimmed = value.strip()
        if not trimmed:
            continue
        if trimmed in seen:
            continue
        seen.add(trimmed)
        normalized.append(trimmed)
    return tuple(normalized)
