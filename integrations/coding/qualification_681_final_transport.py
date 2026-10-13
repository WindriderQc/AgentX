"""Normalization helper for the qualification 681 final-transport fixture.

This module is an isolated synthetic qualification fixture owned by the
Coding Team; it is not part of the product surface and must not be
merged into, or deployed with, the application.
"""


def normalize_ticket_ids(values):
    """Return a tuple of normalized ticket-id strings.

    Each element of ``values`` must be a string. Surrounding whitespace is
    stripped, empty (or blank) strings are discarded, and duplicates are
    dropped while preserving the first appearance of each normalized value.
    Values are neither parsed nor sorted: ``"1"`` stays ``"1"`` and no
    ordering beyond first appearance is applied. An empty iterable yields
    ``()``.

    Non-string elements are not coerced: passing an integer, ``None`` or any
    other non-string raises ``TypeError``.
    """
    normalized = []
    seen = set()
    for value in values:
        if not isinstance(value, str):
            raise TypeError(
                "ticket ids must be strings, got %r" % (type(value).__name__,)
            )
        stripped = value.strip()
        if not stripped:
            continue
        if stripped in seen:
            continue
        seen.add(stripped)
        normalized.append(stripped)
    return tuple(normalized)
