import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("archive_mirror", Path(__file__).resolve().parents[1] / "archive_mirror.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class LocalRemote(module.Remote):
    """A synthetic source host backed by a local directory."""

    def __init__(self, root):
        super().__init__("source.invalid", "/archive")
        self.local = Path(root)
        self.corrupt = set()

    def resolve_root(self, latest_snapshot):
        return "/archive"

    def listing(self, root):
        rows = {}
        for file in self.local.rglob("*"):
            if file.is_file():
                stat = file.stat()
                rows[file.relative_to(self.local).as_posix()] = {"bytes": stat.st_size, "mtime": f"{stat.st_mtime_ns}"}
        return rows

    def hashes(self, root, paths):
        return {p: hashlib.sha256((self.local / p).read_bytes()).hexdigest() for p in paths}

    def stream(self, root, paths):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for path in paths:
                data = b"tampered" if path in self.corrupt else (self.local / path).read_bytes()
                info = tarfile.TarInfo(path)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        buffer.seek(0)

        class Process:
            stdout = buffer
            returncode = 0

            def wait(self):
                return 0
        return Process()


class ArchiveMirrorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "source"
        self.destination = Path(self.temp.name) / "mirror"
        self.write("threads/thread01/original.json", b'{"synthetic": 1}')
        self.write("files/" + "a" * 64 + ".pdf", b"%PDF synthetic")
        self.remote = LocalRemote(self.source)

    def write(self, path, data):
        file = self.source / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        return file

    def run_mirror(self):
        return module.mirror(self.remote, self.destination)

    def test_first_run_copies_and_verifies_every_file(self):
        report = self.run_mirror()
        self.assertEqual((report["status"], report["copied"], report["sourceFiles"]), ("verified", 2, 2))
        copied = self.destination / "current" / "threads/thread01/original.json"
        self.assertEqual(copied.read_bytes(), b'{"synthetic": 1}')
        state = json.loads((self.destination / module.STATE_NAME).read_text())
        self.assertEqual(state["files"]["threads/thread01/original.json"]["sha256"],
                         hashlib.sha256(b'{"synthetic": 1}').hexdigest())

    def test_second_run_copies_only_new_files(self):
        self.run_mirror()
        self.write("threads/thread02/original.json", b"{}")
        report = self.run_mirror()
        self.assertEqual((report["copied"], report["unchanged"]), (1, 2))

    def test_changed_file_keeps_its_previous_version(self):
        self.run_mirror()
        file = self.write("threads/thread01/original.json", b'{"synthetic": 2, "reply": true}')
        os.utime(file, ns=(1, 2_000_000_000_000_000_000))
        report = self.run_mirror()
        self.assertEqual((report["copied"], report["versioned"]), (1, 1))
        kept = list((self.destination / "versions").rglob("original.json"))
        self.assertEqual([k.read_bytes() for k in kept], [b'{"synthetic": 1}'])
        self.assertIn(b"reply", (self.destination / "current" / "threads/thread01/original.json").read_bytes())

    def test_file_removed_at_source_is_never_removed_from_the_mirror(self):
        self.run_mirror()
        (self.source / "threads/thread01/original.json").unlink()
        report = self.run_mirror()
        self.assertEqual(report["missingAtSource"], 1)
        self.assertTrue((self.destination / "current" / "threads/thread01/original.json").exists())

    def test_hash_mismatch_is_not_accepted_and_is_retried_next_run(self):
        self.remote.corrupt.add("threads/thread01/original.json")
        report = self.run_mirror()
        self.assertEqual((report["status"], report["mismatched"], report["copied"]), ("partial", 1, 1))
        self.assertFalse((self.destination / "current" / "threads/thread01/original.json").exists())
        self.remote.corrupt.clear()
        report = self.run_mirror()
        self.assertEqual((report["status"], report["copied"]), ("verified", 1))

    def test_transient_and_unsafe_paths_are_skipped(self):
        self.write("downloads/message01-0.pdf", b"partial download")
        self.write("inventory-mailbox.json.tmp", b"{}")
        self.write("backfill.lock", b"{}")
        self.write("threads/odd name/original.json", b"{}")
        report = self.run_mirror()
        self.assertEqual((report["sourceFiles"], report["unsafePaths"]), (2, 1))
        self.assertFalse((self.destination / "current" / "downloads").exists())

    def test_receipt_and_run_history_hold_counts_only(self):
        self.run_mirror()
        latest = (self.destination / module.RUN_NAME).read_text()
        self.assertNotIn("synthetic", latest)
        self.assertEqual(len(list((self.destination / "runs").glob("*.json"))), 1)

    def test_source_target_and_root_are_validated(self):
        with self.assertRaises(ValueError):
            module.Remote("-oProxyCommand=x", "/archive")
        with self.assertRaises(ValueError):
            module.Remote("host", "relative/root")
        with self.assertRaises(ValueError):
            module.Remote("host", "/archive/../etc")


if __name__ == "__main__":
    unittest.main()
