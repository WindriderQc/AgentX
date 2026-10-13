"""Normalization helpers for qualification 681 synthetic ticket-id fixtures.

This module is an isolated draft fixture used by the Coding Team; it is not
part of the product surface and must not be merged or deployed.
"""


def normalize_ticket_ids(values):
    """Return a tuple of normalized ticket id strings.

    Each entry of the iterable must be a string: surrounding whitespace is
    stripped, empty strings are discarded, and duplicates are dropped, with
    the order and spelling of the first occurrence preserved. An empty
    iterable returns ``()``. Non-string entries are rejected with
    ``TypeError``; values are never coerced, parsed as integers, or sorted.
    """
    normalized = []
    seen = set()
    for value in values:
        if not isinstance(value, str):
            raise TypeError(
                f"ticket ids must be strings, got {type(value).__name__}"
            )
        trimmed = value.strip()
        if not trimmed:
            continue
        if trimmed in seen:
            continue
        seen.add(trimmed)
        normalized.append(trimmed)
    return tuple(normalized)
