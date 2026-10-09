"""Private JSON files of the Secretary evidence archive (owner-only, atomic writes)."""
from __future__ import annotations

import json
import os
import time


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load(file, default=None):
    return json.loads(file.read_text(encoding="utf-8")) if file.exists() else default


def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # One temporary file per writer: the triage turn and the catch-up job write the
    # same status files at once, and a shared name let one rename the other's file.
    temp = file.with_name(f"{file.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.chmod(0o600)
    temp.replace(file)
