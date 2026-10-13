"""Normalization helper for the synthetic qualification 681 correction fixture.

This module is an isolated draft fixture used by the Coding Team; it is not
part of the product surface and must not be merged or deployed.
"""


def normalize_ticket_ids(values, *, case_insensitive=False):
    """Return a tuple of normalized ticket id strings.

    Each entry must be a string: surrounding whitespace is stripped, empty or
    blank strings are discarded, and duplicates are dropped while preserving
    the order and spelling of the first occurrence. Values are never coerced
    to strings (no integers, no ``None``): a non-string entry raises
    ``TypeError``. An empty iterable returns ``()``. Entries are not parsed
    as integers and the result is never sorted.

    ``case_insensitive`` is a keyword-only flag. With the default ``False``,
    ids are compared exactly after trimming. When ``True``, duplicates are
    detected using Unicode case folding (``str.casefold``) while the result
    keeps the trimmed spelling and position of the first occurrence. The flag
    must be a bool: any other type raises ``TypeError``.
    """
    if not isinstance(case_insensitive, bool):
        raise TypeError(
            "case_insensitive must be a bool, got {!r}".format(type(case_insensitive).__name__)
        )
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
        key = trimmed.casefold() if case_insensitive else trimmed
        if key in seen:
            continue
        seen.add(key)
        normalized.append(trimmed)
    return tuple(normalized)
