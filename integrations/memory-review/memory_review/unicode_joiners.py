"""Contextual join-control policy mirrored by Core's unicodeJoiners.js.

Use pinned Unicode 17 data so Python's bundled Unicode version cannot split
text which Node 24 accepts. Node/Python parity is checked on synthetic data.
"""
from bisect import bisect_right
from .unicode_data import _PICTOGRAPHIC, _MARKS, _SCRIPT_LETTERS

_PICTOGRAPHIC_STARTS = tuple(lo for lo, _ in _PICTOGRAPHIC)
_MARK_STARTS = tuple(lo for lo, _ in _MARKS)
_LETTER_STARTS = tuple(lo for lo, _ in _SCRIPT_LETTERS)
_SCRIPT_BLOCKS = (
    ((0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF)),
    *(((0x0900 + i * 0x80, 0x097F + i * 0x80),) for i in range(10)),
)


def _contains(point, ranges, starts):
    index = bisect_right(starts, point) - 1
    return index >= 0 and point <= ranges[index][1]


def _script_group(char: str) -> int:
    if not char or not _contains(ord(char), _SCRIPT_LETTERS, _LETTER_STARTS):
        return -1
    point = ord(char)
    return next((i for i, blocks in enumerate(_SCRIPT_BLOCKS)
                 if any(lo <= point <= hi for lo, hi in blocks)), -1)


def _pictographic(char: str) -> bool:
    return _contains(ord(char), _PICTOGRAPHIC, _PICTOGRAPHIC_STARTS)


def _is_mark(char: str) -> bool:
    return _contains(ord(char), _MARKS, _MARK_STARTS)


def is_allowed_joiner(text: str, index: int) -> bool:
    joiner = text[index]
    if joiner not in ('\u200c', '\u200d'):
        return False
    if joiner == '\u200d':
        left = index - 1
        while left >= 0 and (text[left] == '\ufe0f' or 0x1F3FB <= ord(text[left]) <= 0x1F3FF):
            left -= 1
        if left >= 0 and index + 1 < len(text) and _pictographic(text[left]) and _pictographic(text[index + 1]):
            return True
    left = index - 1
    while left >= 0 and _is_mark(text[left]):
        left -= 1
    group = _script_group(text[left]) if left >= 0 else -1
    return group >= 0 and index + 1 < len(text) and group == _script_group(text[index + 1])
