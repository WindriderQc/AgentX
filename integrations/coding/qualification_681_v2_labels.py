"""Normalization helpers for qualification 681 v2 synthetic label fixtures.

This module is an isolated draft fixture used by the Coding Team; it is not
part of the product surface and must not be merged or deployed.
"""


def normalize_labels(labels):
    """Return a new, normalized list of label strings.

    Each string is trimmed, empty strings are discarded, duplicates are
    dropped by exact case-sensitive equality, and the order and spelling of
    the first occurrence are preserved. The input list is never mutated.
    """
    normalized = []
    seen = set()
    for label in labels:
        trimmed = label.strip()
        if not trimmed or trimmed in seen:
            continue
        seen.add(trimmed)
        normalized.append(trimmed)
    return normalized
