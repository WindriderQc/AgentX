"""Normalization helper for the synthetic qualification 681 correction fixture.

This module is an isolated draft fixture used by the Coding Team; it is not
part of the product surface and must not be merged or deployed.
"""


def normalize_ticket_ids(values):
    """Return a tuple of normalized ticket id strings.

    Each entry must be a string: surrounding whitespace is stripped, empty or
    blank strings are discarded, and duplicates are dropped while preserving
    the order and spelling of the first occurrence. Values are never coerced
    to strings (no integers, no ``None``): a non-string entry raises
    ``TypeError``. An empty iterable returns ``()``. Entries are not parsed
    as integers and the result is never sorted.
    """
    normalized = []
    seen = set()
    for value in values:
        if not isinstance(value, str):
            raise TypeError(
                "ticket ids must be strings, got {!r}".format(type(value).__name__)
            )
        trimmed = value.strip()
        if not trimmed:
            continue
        if trimmed in seen:
            continue
        seen.add(trimmed)
        normalized.append(trimmed)
    return tuple(normalized)
