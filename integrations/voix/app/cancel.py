"""One-shot cancellation flag shared by a speech request and its synthesis."""
from __future__ import annotations

import threading


class CancelToken:
    """Thread-safe flag: set once the caller left, read by the engine between frames."""

    def __init__(self) -> None:
        self._event = threading.Event()

    def set(self) -> None:
        self._event.set()

    def is_set(self) -> bool:
        return self._event.is_set()
