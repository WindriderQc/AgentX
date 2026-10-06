"""Clause chunker — splits reply text into speakable clauses.

Text is accumulated and a clause is flushed as soon as a boundary is reached
(. ! ? ; :, or a long comma) past a minimum length, so a streamed reply starts
speaking after its first sentence instead of after its last.

Pure stdlib so it's unit-testable without any models.
"""
from __future__ import annotations

from typing import Iterable

# strong boundaries always flush; comma flushes only past min_chars
_STRONG = ".!?;:\n"
_SOFT = ","


class ClauseChunker:
    def __init__(self, min_chars: int = 40, *, sentence_only: bool = False) -> None:
        self.min_chars = min_chars
        self._strong = ".!?\n" if sentence_only else _STRONG
        self._soft = "" if sentence_only else _SOFT
        self._buf: list[str] = []
        self._len = 0

    def feed(self, text: str) -> list[str]:
        """Add a token/delta; return any clauses that are now ready to speak."""
        ready: list[str] = []
        for ch in text:
            self._buf.append(ch)
            self._len += 1
            if ch in self._strong or (ch in self._soft and self._len >= self.min_chars):
                clause = "".join(self._buf).strip()
                if len(clause) >= max(1, self.min_chars // 4) or ch in self._strong:
                    if clause:
                        ready.append(clause)
                    self._buf.clear()
                    self._len = 0
        return ready

    def flush(self) -> str | None:
        """Return whatever's left at end-of-stream (the final partial clause)."""
        clause = "".join(self._buf).strip()
        self._buf.clear()
        self._len = 0
        return clause or None


def chunk_all(tokens: Iterable[str], *, min_chars: int = 40) -> list[str]:
    """Sync helper for tests."""
    chunker = ClauseChunker(min_chars=min_chars)
    out: list[str] = []
    for tok in tokens:
        out.extend(chunker.feed(tok))
    tail = chunker.flush()
    if tail:
        out.append(tail)
    return out
