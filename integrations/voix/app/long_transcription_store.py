"""Private durable native receipts. One owner process; no auto-replay after restart."""
import json
import os
from pathlib import Path
import sqlite3
import shutil
import threading
import time


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lockfile = (self.root / "owner.lock").open("a+b")
        if os.name == "nt":
            import msvcrt
            self.lockfile.write(b"0")
            self.lockfile.flush()
            self.lockfile.seek(0)
            msvcrt.locking(self.lockfile.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / "receipts.sqlite", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        active = self.db.execute("SELECT payload FROM jobs WHERE json_extract(payload, '$.state') NOT IN ('completed','failed','cancelled')").fetchall()
        for payload in active:
            row = json.loads(payload[0])
            if row["state"] not in ("completed", "failed", "cancelled"):
                self.update(row["id"], state="failed", stage="interrupted", finishedAt=time.time(),
                            error="Service redémarré : tentative interrompue. Vous pouvez réessayer.")

        # The process lock proves no previous worker can still own these dirs.
        for directory in self.root.glob('audio-*'):
            if directory.is_dir() and not directory.is_symlink() and directory.resolve().parent == self.root.resolve():
                shutil.rmtree(directory)

    def get(self, identity):
        with self.lock:
            row = self.db.execute("SELECT payload FROM jobs WHERE id = ?", (identity,)).fetchone()
            return json.loads(row[0]) if row else None

    def list(self):
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute("SELECT payload FROM jobs")]

    def create(self, row):
        with self.lock, self.db:
            prior = self.get(row["id"])
            if prior:
                if (prior["url"], prior["language"]) != (row["url"], row["language"]):
                    raise ValueError("Cette identité appartient à une autre tentative.")
                return prior, False
            self.db.execute("INSERT INTO jobs VALUES (?, ?)", (row["id"], json.dumps(row)))
            return row, True

    def update(self, identity, **changes):
        with self.lock, self.db:
            row = self.get(identity)
            if not row:
                raise KeyError(identity)
            row.update(changes, updatedAt=time.time())
            self.db.execute("UPDATE jobs SET payload = ? WHERE id = ?", (json.dumps(row), identity))
            return row

    def close(self):
        self.db.close()
        self.lockfile.close()
