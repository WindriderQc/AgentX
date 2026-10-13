"""Qualification #681 synthetic fixture: restart publication ticket-id normalization.

Not a product feature. Provides a single pure helper used by the qualification
transport tests; see integrations/coding/tests/test_qualification_681_transport.py.
"""

__all__ = ["normalize_ticket_ids"]


def normalize_ticket_ids(values):
    """Normalize an iterable of ticket-id strings.

    Strips surrounding whitespace from each entry, discards empty (and
    whitespace-only) strings, removes duplicates preserving first appearance,
    and returns the result as a tuple.

    Entries that are not ``str`` raise :class:`TypeError`. An empty iterable
    returns an empty tuple. Values are not parsed or reordered.
    """
    seen = set()
    result = []
    for value in values:
        if not isinstance(value, str):
            raise TypeError(
                "ticket ids must be strings, got %s" % type(value).__name__
            )
        stripped = value.strip()
        if not stripped or stripped in seen:
            continue
        seen.add(stripped)
        result.append(stripped)
    return tuple(result)
