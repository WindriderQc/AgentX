"""Durable per-runtime watermarks for incremental, crash-safe collection.

One JSON file per runtime under the state dir (never in git, never containing
message content):

    <state_dir>/watermarks-<runtime>.json
    { "schemaVersion": 1, "runtime": "...", "entries": { "<source_key>": {
        "size": int, "mtimeNs": int, "offset": int, "sig": "sha256[:16]",
        "sessionId": "...", "meta": {...}, "updatedAt": "iso" } } }

Contract:
- collectors STAGE new positions; nothing is persisted until `commit()` is
  called, and the CLI only commits after AgentX Core accepted the observation
  batch. A failed submission therefore never advances a watermark.
- `sig` is a hash of the file head; a sig mismatch or a shrink means the file
  was rotated/reset, so reading restarts from offset 0 (idempotent server-side
  via content hashes).
- dry-run never calls commit().
- `reset()` is the explicit manual recovery path.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
_SIG_BYTES = 4096


def default_state_dir() -> Path:
    override = os.environ.get("AGENTX_MEMORY_REVIEW_STATE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".agentx" / "memory-review"


def head_signature(path: Path, length: int | None = None) -> str:
    """Hash a fixed-length head prefix. Rotation detection must recompute at
    the RECORDED length — hashing 'the current head' would make any append to
    a file shorter than the window look like a rotation."""
    want = _SIG_BYTES if length is None else max(0, int(length))
    if want == 0:
        return ""
    try:
        with path.open("rb") as handle:
            head = handle.read(want)
    except OSError:
        return ""
    if length is not None and len(head) < want:
        return ""  # file shrank below the recorded head: signal mismatch
    return hashlib.sha256(head).hexdigest()[:16]


def head_window(size: int) -> int:
    return min(_SIG_BYTES, max(0, int(size)))


class WatermarkStore:
    def __init__(self, runtime: str, state_dir: Path | None = None):
        self.runtime = runtime
        self.state_dir = Path(state_dir) if state_dir else default_state_dir()
        self.path = self.state_dir / f"watermarks-{runtime}.json"
        self.entries: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # A corrupt store must not crash collection; treat as first run.
            self.entries = {}
            return
        if data.get("schemaVersion") != SCHEMA_VERSION:
            self.entries = {}
            return
        entries = data.get("entries")
        self.entries = entries if isinstance(entries, dict) else {}

    def get(self, source_key: str) -> dict | None:
        entry = self.entries.get(source_key)
        return dict(entry) if isinstance(entry, dict) else None

    def token(self) -> str:
        """Opaque digest of the current store — safe to record on a run."""
        blob = json.dumps(self.entries, sort_keys=True).encode("utf-8")
        return f"{self.runtime}:{SCHEMA_VERSION}:{hashlib.sha256(blob).hexdigest()[:16]}"

    def commit(self, staged: dict[str, dict]) -> None:
        """Merge staged entries and persist atomically. Call ONLY after the
        server accepted the batch built from those positions."""
        now = datetime.now(timezone.utc).isoformat()
        for key, entry in staged.items():
            record = dict(entry)
            record["updatedAt"] = now
            self.entries[key] = record
        self._write()

    def reset(self, source_key: str | None = None) -> int:
        if source_key is None:
            removed = len(self.entries)
            self.entries = {}
        else:
            removed = 1 if self.entries.pop(source_key, None) is not None else 0
        self._write()
        return removed

    def _write(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "runtime": self.runtime,
            "entries": self.entries,
        }
        fd, tmp = tempfile.mkstemp(
            dir=str(self.state_dir), prefix=f".{self.path.name}.", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=1, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self.path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
