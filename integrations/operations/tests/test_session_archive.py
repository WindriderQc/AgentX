import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "session_archive.py"
SPEC = importlib.util.spec_from_file_location("session_archive", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class LocalArchive:
    """The archive host's receiving side, run in-process on a local directory."""

    def __init__(self, root, corrupt=None):
        self.root = Path(root)
        self.corrupt = corrupt
        self.calls = 0

    def call(self, verb, host, run_id, write_input):
        self.calls += 1
        buffer = io.BytesIO()
        write_input(buffer)
        data = buffer.getvalue()
        if self.corrupt:
            data = data.replace(*self.corrupt)
        if verb == "receive":
            return {"contract": module.CONTRACT, "results": module.receive(io.BytesIO(data), self.root, host, run_id)}
        module.record(self.root, host, run_id, json.loads(data.decode("utf-8")))
        return {"contract": module.CONTRACT, "recorded": True}


class SessionArchiveTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.claude = self.base / "home" / ".claude" / "projects"
        self.codex = self.base / "home" / ".codex"
        self.write(self.claude / "proj-a" / "s1.jsonl", b'{"turn": 1}\n')
        self.write(self.claude / "proj-a" / "s1" / "subagents" / "agent-1.jsonl", b'{"sub": 1}\n')
        self.write(self.claude / ".credentials.json", b'{"token": "never"}')
        self.write(self.claude / "proj-a" / "write.lock", b"")
        self.write(self.codex / "sessions" / "2026" / "10" / "25" / "rollout-a.jsonl", b'{"codex": 1}\n')
        self.write(self.codex / "auth.json", b'{"key": "never"}')
        self.write(self.codex / "history.jsonl", b'{"h": 1}\n')
        self.sources = [("claude-projects", self.claude), ("codex-sessions", self.codex / "sessions"),
                        ("codex-history", self.codex / "history.jsonl"), ("codex-auth", self.codex / "auth.json"),
                        ("codex-archived", self.codex / "archived_sessions")]
        self.root = self.base / "archive"
        self.root.mkdir()
        self.live = self.root / "live" / "devx"
        self.state = self.base / "state"
        self.host = LocalArchive(self.root)

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        stamp = getattr(self, "_stamp", 1_700_000_000_000_000_000) + 1_000_000_000
        self._stamp = stamp
        os.utime(path, ns=(stamp, stamp))

    def run_archive(self, host=None, **options):
        return module.archive(self.sources, host or self.host, "devx", self.state, **options)

    def test_first_run_copies_every_source_and_never_reads_credentials(self):
        report = self.run_archive()
        self.assertEqual(report["status"], "verified")
        self.assertEqual(report["new"], 4)
        self.assertEqual((self.live / "claude-projects" / "proj-a" / "s1.jsonl").read_bytes(), b'{"turn": 1}\n')
        self.assertTrue((self.live / "claude-projects" / "proj-a" / "s1" / "subagents" / "agent-1.jsonl").is_file())
        self.assertTrue((self.live / "codex-sessions" / "2026" / "10" / "25" / "rollout-a.jsonl").is_file())
        self.assertTrue((self.live / "codex-history" / "history.jsonl").is_file())
        archived = [p.name for p in self.root.rglob("*") if p.is_file()]
        self.assertNotIn(".credentials.json", archived)
        self.assertNotIn("auth.json", archived)
        self.assertNotIn("write.lock", archived)
        self.assertEqual(report["sources"], {"claude-projects": True, "codex-sessions": True, "codex-history": True,
                                             "codex-auth": True, "codex-archived": False})
        remote = json.loads((self.root / "receipts" / "devx" / "latest-run.json").read_text())
        self.assertEqual(remote["runId"], report["runId"])
        self.assertTrue((self.root / "receipts" / "devx" / f"{report['runId']}.json").is_file())
        self.assertEqual(json.loads((self.state / "latest-run.json").read_text())["status"], "verified")
        self.assertNotIn("turn", json.dumps(remote))
        self.assertFalse((self.root / "staging" / "devx" / report["runId"]).exists())
        if os.name != "nt":
            self.assertEqual(self.live.stat().st_mode & 0o777, 0o700)
            self.assertEqual((self.live / "codex-history" / "history.jsonl").stat().st_mode & 0o777, 0o600)

    def test_unchanged_files_are_not_sent_again(self):
        self.run_archive()
        calls = self.host.calls
        report = self.run_archive()
        self.assertEqual((report["unchanged"], report["sent"], report["pending"]), (4, 0, 0))
        self.assertEqual(self.host.calls, calls + 1)  # only the receipt

    def test_a_growing_session_replaces_its_shorter_copy_without_a_version(self):
        self.run_archive()
        self.write(self.claude / "proj-a" / "s1.jsonl", b'{"turn": 1}\n{"turn": 2}\n')
        report = self.run_archive()
        self.assertEqual((report["grown"], report["versioned"]), (1, 0))
        self.assertEqual((self.live / "claude-projects" / "proj-a" / "s1.jsonl").read_bytes(),
                         b'{"turn": 1}\n{"turn": 2}\n')
        self.assertFalse((self.root / "versions").exists())

    def test_a_rewritten_file_keeps_its_previous_copy(self):
        first = self.run_archive()
        self.write(self.codex / "history.jsonl", b'{"h": 2}\n')
        report = self.run_archive()
        self.assertEqual(report["versioned"], 1)
        self.assertNotEqual(first["runId"], "")
        kept = list((self.root / "versions" / "devx").rglob("history.jsonl"))
        self.assertEqual([p.read_bytes() for p in kept], [b'{"h": 1}\n'])
        self.assertEqual((self.live / "codex-history" / "history.jsonl").read_bytes(), b'{"h": 2}\n')

    def test_a_file_deleted_at_the_source_stays_archived(self):
        self.run_archive()
        (self.claude / "proj-a" / "s1.jsonl").unlink()
        report = self.run_archive()
        self.assertEqual(report["missingAtSource"], 1)
        self.assertEqual(report["archivedFiles"], 4)
        self.assertTrue((self.live / "claude-projects" / "proj-a" / "s1.jsonl").is_file())

    def test_a_file_damaged_in_transit_is_refused_and_retried(self):
        damaged = LocalArchive(self.root, corrupt=(b'{"codex": 1}', b'{"codex": 9}'))
        report = self.run_archive(host=damaged)
        self.assertEqual((report["status"], report["mismatched"], report["new"]), ("partial", 1, 3))
        self.assertFalse((self.live / "codex-sessions" / "2026" / "10" / "25" / "rollout-a.jsonl").exists())
        retry = self.run_archive()
        self.assertEqual((retry["status"], retry["new"], retry["unchanged"]), ("verified", 1, 3))

    def test_batches_split_by_file_count(self):
        report = self.run_archive(batch_files=1)
        self.assertEqual(report["new"], 4)
        self.assertEqual(self.host.calls, 5)

    def test_dry_run_sends_nothing(self):
        report = self.run_archive(dry_run=True)
        self.assertEqual((report["status"], report["pending"], report["sent"]), ("dry-run", 4, 0))
        self.assertEqual(self.host.calls, 0)
        self.assertFalse(self.live.exists())

    def test_a_held_lock_refuses_a_concurrent_run(self):
        self.state.mkdir()
        (self.state / module.LOCK_NAME).write_text("1")
        with self.assertRaises(RuntimeError):
            self.run_archive()

    def test_receiver_refuses_paths_that_leave_the_archive(self):
        stream = io.BytesIO(b'F {"path": "../escape.txt"}\nC 3\nbad' + b"D x 3\nE\n")
        results = module.receive(stream, self.root, "devx", "20261025T000000Z")
        self.assertEqual(results, {"../escape.txt": "unsafe"})
        self.assertFalse((self.root / "live" / "escape.txt").exists())
        self.assertFalse((self.root / "escape.txt").exists())
        for path in ("/abs", "a//b", "a\\b", "a/./b", ""):
            self.assertFalse(module.safe_relative(path), path)

    def test_receiver_rejects_a_truncated_stream(self):
        with self.assertRaises(ValueError):
            module.receive(io.BytesIO(b'F {"path": "a.jsonl"}\nC 10\nshort'), self.root, "devx", "20261025T000000Z")
        self.assertFalse((self.live / "a.jsonl").exists())

    def test_command_line_validates_labels_and_destination(self):
        with self.assertRaises(SystemExit):
            module.main(["send", "--host-label", "DevX", "--source", "a=/tmp", "--destination-host", "h",
                         "--destination-root", "/srv", "--state-dir", str(self.state)])
        with self.assertRaises(ValueError):
            module.SshArchive("-oProxyCommand=x", "/srv")
        with self.assertRaises(ValueError):
            module.SshArchive("archive", "/srv/../etc")


@unittest.skipUnless(os.name != "nt" and shutil.which("bash"), "needs a POSIX shell for the SSH stand-in")
class SessionArchiveOverSshTests(unittest.TestCase):
    """The real command line and bootstrap, with ssh replaced by a local shell."""

    def test_end_to_end_through_the_shipped_receiver(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "projects" / "p"
            source.mkdir(parents=True)
            (source / "s.jsonl").write_bytes(b'{"turn": "it\'s"}\n')
            root = base / "archive root"
            root.mkdir()
            fake = base / "ssh"
            fake.write_text(textwrap.dedent(f"""\
                #!{sys.executable}
                import subprocess, sys
                args = sys.argv[1:]
                while args and args[0] == "-o":
                    args = args[2:]
                sys.exit(subprocess.call(["bash", "-c", args[1]]))
                """))
            fake.chmod(0o700)
            env = dict(os.environ, PATH=f"{base}{os.pathsep}{os.environ['PATH']}")
            command = [sys.executable, str(SCRIPT), "send", "--host-label", "devx",
                       "--source", f"claude-projects={base / 'projects'}", "--destination-host", "archive.invalid",
                       "--destination-root", str(root), "--state-dir", str(base / "state")]
            result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual((report["status"], report["new"]), ("verified", 1))
            self.assertEqual((root / "live" / "devx" / "claude-projects" / "p" / "s.jsonl").read_bytes(),
                             b'{"turn": "it\'s"}\n')
            self.assertTrue((root / "receipts" / "devx" / "latest-run.json").is_file())
            again = json.loads(subprocess.run(command, capture_output=True, text=True, env=env, timeout=60).stdout)
            self.assertEqual((again["unchanged"], again["sent"]), (1, 0))

    def test_collect_runs_the_shipped_sender_on_the_source_host(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "home" / ".codex" / "sessions" / "2026"
            source.mkdir(parents=True)
            (source / "rollout-a.jsonl").write_bytes(b'{"codex": "remote"}\n')
            (base / "home" / ".codex" / "auth.json").write_bytes(b"{}")
            root = base / "archive"
            root.mkdir()
            calls = base / "calls.log"
            fake = base / "ssh"
            fake.write_text(textwrap.dedent(f"""\
                #!{sys.executable}
                import subprocess, sys
                args = sys.argv[1:]
                while args and args[0] == "-o":
                    args = args[2:]
                with open({str(calls)!r}, "a") as log:
                    log.write(args[0] + "\\n")
                sys.exit(subprocess.call(["bash", "-c", args[1]], cwd="/"))
                """))
            fake.chmod(0o700)
            # Run the collector from a copy elsewhere, as the archive host would.
            installed = base / "archive-host" / "session_archive.py"
            installed.parent.mkdir()
            shutil.copy(SCRIPT, installed)
            env = dict(os.environ, PATH=f"{base}{os.pathsep}{os.environ['PATH']}")
            command = [sys.executable, str(installed), "collect", "--host-label", "devx",
                       "--source-host", "devx.invalid", "--return-host", "archive.invalid",
                       "--source", f"codex-sessions={base / 'home' / '.codex' / 'sessions'}",
                       "--source", f"codex-auth={base / 'home' / '.codex' / 'auth.json'}",
                       "--destination-root", str(root), "--state-dir", str(base / "source-state")]
            result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual((report["status"], report["host"], report["new"]), ("verified", "devx", 1))
            self.assertEqual((root / "live" / "devx" / "codex-sessions" / "2026" / "rollout-a.jsonl").read_bytes(),
                             b'{"codex": "remote"}\n')
            self.assertFalse(any(p.name == "auth.json" for p in root.rglob("*")))
            self.assertEqual(calls.read_text().split(), ["devx.invalid", "archive.invalid", "archive.invalid"])
            self.assertTrue((base / "source-state" / "latest-run.json").is_file())

    def test_collect_reports_an_unreachable_source_host(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            fake = base / "ssh"
            fake.write_text(f"#!{sys.executable}\nimport sys\nsys.stderr.write('ssh: connect to host devx port 22: No route to host\\n')\nsys.exit(255)\n")
            fake.chmod(0o700)
            env = dict(os.environ, PATH=f"{base}{os.pathsep}{os.environ['PATH']}")
            result = subprocess.run([sys.executable, str(SCRIPT), "collect", "--host-label", "devx", "--source-host", "devx",
                                     "--return-host", "archive", "--source", "a=/nowhere", "--destination-root", "/archive",
                                     "--state-dir", "/state"], capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual(result.returncode, 1)
            report = json.loads(result.stdout)
            self.assertEqual((report["status"], report["error"]), ("failed", "SourceHostUnavailable"))
            self.assertIn("No route to host", report["detail"])


if __name__ == "__main__":
    unittest.main()
