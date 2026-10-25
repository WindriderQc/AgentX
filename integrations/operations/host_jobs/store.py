"""One native authority for configuration, run identities and execution receipts."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import uuid

JOB_ID = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
KINDS = {"codex-usage", "memory-review-submit", "offhost-backup", "archive-mirror", "bundle-delivery", "session-archive"}
TERMINAL = {"completed", "failed", "cancelled"}


class JobError(Exception):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code, self.status = code, status


def now():
    return datetime.now(timezone.utc).isoformat()


def exact_id(value):
    if not isinstance(value, str) or not JOB_ID.fullmatch(value):
        raise JobError("INVALID_JOB", "The job identifier is invalid.", 400)
    return value


def exact_request(value):
    try:
        parsed = uuid.UUID(value)
        if str(parsed) != value or parsed.version != 4:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise JobError("INVALID_REQUEST", "An exact request identity is required.", 400)
    return value


def load(path, default=None):
    return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else default


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + str(uuid.uuid4()) + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


@contextmanager
def lock(path, blocking=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0, 2)
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
            except OSError:
                raise JobError("JOB_BUSY", "An execution already owns this job.")
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            except BlockingIOError:
                raise JobError("JOB_BUSY", "An execution already owns this job.")
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)


class Store:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.config_path = self.root / "config.json"
        self.state_path = self.root / "state.json"
        self.runs = self.root / "runs"
        self.runs.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            self.root.chmod(0o700)

    def config(self):
        config = load(self.config_path)
        if not config or config.get("version") != 1 or not isinstance(config.get("jobs"), list):
            raise JobError("NOT_CONFIGURED", "The operations supervisor is not configured.", 503)
        ids = set()
        for job in config["jobs"]:
            identifier = exact_id(job.get("id"))
            if identifier in ids or job.get("kind") not in KINDS:
                raise JobError("INVALID_CONFIGURATION", "A job configuration is invalid.", 503)
            ids.add(identifier)
        return config

    def state(self):
        return load(self.state_path, {"version": 1, "jobs": {}, "lastTickAt": None, "inventory": None})

    def record(self, request_id):
        return load(self.runs / (exact_request(request_id) + ".json"))

    def write_record(self, record):
        save(self.runs / (exact_request(record["requestId"]) + ".json"), record)

    def job(self, config, identifier):
        identifier = exact_id(identifier)
        for job in config["jobs"]:
            if job["id"] == identifier:
                return job
        raise JobError("JOB_NOT_FOUND", "This job is not configured.", 404)

    def history(self, limit=50, offset=0):
        records = [load(path) for path in self.runs.glob("*.json")]
        records.sort(key=lambda row: row.get("createdAt", ""), reverse=True)
        return records[offset:offset + limit], len(records)

    @contextmanager
    def locked(self):
        with lock(self.root / "authority.lock"):
            yield
