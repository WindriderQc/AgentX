import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SECRETARY_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SECRETARY_DIR))
SPEC = importlib.util.spec_from_file_location("mailbox_backfill", SECRETARY_DIR / "mailbox_backfill.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
evidence = sys.modules["secretary_evidence"]


def thread_payload(thread_id, message_ids):
    return {"thread": {"messages": [
        {"id": mid, "threadId": thread_id, "body": f"Synthetic body {mid}",
         "headers": {"subject": "Synthetic"}, "payload": {"parts": []}}
        for mid in message_ids]}}


class FakeGmail:
    """Synthetic read-only provider: search pages and full threads."""

    def __init__(self, threads, head=None, fail=()):
        self.threads, self.head, self.fail = threads, head or [], set(fail)
        self.commands = []

    def __call__(self, command):
        self.commands.append(command)
        if command[:3] == ["gmail", "messages", "search"]:
            return {"messages": self.head}
        if command[:3] == ["gmail", "thread", "get"]:
            if command[3] in self.fail:
                raise RuntimeError("Gmail gmail.thread.get failed (exit 1)")
            return thread_payload(command[3], self.threads[command[3]])
        raise AssertionError(f"unexpected provider command {command[:3]}")


class BackfillTests(unittest.TestCase):
    def setUp(self):
        queries = mock.patch.dict(evidence.QUERIES, {"mailbox": "in:anywhere"}, clear=True)
        queries.start()
        self.addCleanup(queries.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def inventory(self, rows):
        evidence.save(self.root / "inventory-mailbox.json", {
            "query": "in:anywhere", "complete": True, "pages": 1,
            "messages": {row["id"]: row for row in rows}})

    def archive(self, gmail):
        archive = evidence.Archive(self.root, gmail)
        archive.run = module.Pacer(archive.run, min_interval=0, sleep=lambda _: None)
        return archive

    def lock(self):
        lock = module.Lock(self.root)
        self.assertTrue(lock.acquire())
        self.addCleanup(lock.release)
        return lock

    def test_copies_every_uncollected_thread_newest_first_then_reports_done(self):
        self.inventory([
            {"id": "message01", "threadId": "thread01", "date": "2007-01-01 10:00"},
            {"id": "message02", "threadId": "thread02", "date": "2026-01-01 10:00"},
            {"id": "message03", "threadId": "thread02", "date": "2026-01-02 10:00"},
        ])
        gmail = FakeGmail({"thread01": ["message01"], "thread02": ["message02", "message03"]})
        result = module.backfill(self.archive(gmail), self.lock())
        self.assertEqual(result["phase"], "done")
        self.assertEqual(result["collected"], 2)
        fetched = [c[3] for c in gmail.commands if c[:3] == ["gmail", "thread", "get"]]
        self.assertEqual(fetched, ["thread02", "thread01"])
        self.assertTrue(all(c[1] in ("messages", "thread") for c in gmail.commands))
        status = json.loads((self.root / module.STATUS_NAME).read_text())
        self.assertEqual((status["phase"], status["remaining"]), ("done", 0))
        self.assertNotIn("Synthetic body", json.dumps(status))

    def test_already_archived_threads_are_not_fetched_again(self):
        self.inventory([{"id": "message01", "threadId": "thread01", "date": "2020-01-01"}])
        gmail = FakeGmail({"thread01": ["message01"]})
        evidence.Archive(self.root, gmail).collect_thread("thread01")
        gmail.commands.clear()
        result = module.backfill(self.archive(gmail), self.lock())
        self.assertEqual((result["phase"], result["collected"]), ("done", 0))
        self.assertFalse([c for c in gmail.commands if c[:3] == ["gmail", "thread", "get"]])

    def test_new_head_mail_is_added_without_dropping_discovered_rows(self):
        self.inventory([{"id": "message01", "threadId": "thread01", "date": "2020-01-01"}])
        head = [{"id": "message09", "threadId": "thread09", "date": "2026-10-01"},
                {"id": "message01", "threadId": "thread01", "date": "2020-01-01"}]
        gmail = FakeGmail({"thread01": ["message01"], "thread09": ["message09"]}, head=head)
        result = module.backfill(self.archive(gmail), self.lock())
        rows = evidence.load(self.root / "inventory-mailbox.json")["messages"]
        self.assertEqual(set(rows), {"message01", "message09"})
        self.assertEqual(result["collected"], 2)

    def test_unfinished_discovery_is_completed_before_collection(self):
        pages = iter([{"messages": [{"id": "message01", "threadId": "thread01"}], "nextPageToken": "next"},
                      {"messages": [{"id": "message02", "threadId": "thread02"}]}])
        gmail = FakeGmail({"thread01": ["message01"], "thread02": ["message02"]})
        search = gmail.__call__
        gmail_run = lambda c: next(pages) if c[:3] == ["gmail", "messages", "search"] else search(c)
        result = module.backfill(self.archive(gmail_run), self.lock())
        self.assertTrue(evidence.load(self.root / "inventory-mailbox.json")["complete"])
        self.assertEqual((result["phase"], result["collected"]), ("done", 2))

    def test_transient_provider_errors_are_retried_with_backoff(self):
        calls, delays = [], []

        def flaky(command):
            calls.append(command)
            if len(calls) < 3:
                raise RuntimeError("Gmail gmail.thread.get failed (exit 1)")
            return "ok"
        pacer = module.Pacer(flaky, min_interval=0, delays=(5, 15, 45), sleep=delays.append)
        self.assertEqual(pacer(["gmail"]), "ok")
        self.assertEqual([d for d in delays if d], [5, 15])
        self.assertEqual(pacer.retries, 2)

    def test_invalid_provider_data_is_not_retried(self):
        def broken(_):
            raise ValueError("Empty or invalid Gmail thread")
        pacer = module.Pacer(broken, min_interval=0, sleep=lambda _: self.fail("must not wait"))
        with self.assertRaises(ValueError):
            pacer(["gmail"])

    def test_calls_are_spaced_by_the_minimum_interval(self):
        ticks, waits = iter([0.0, 0.05, 0.05]), []
        pacer = module.Pacer(lambda _: None, min_interval=0.2, sleep=waits.append, clock=lambda: next(ticks))
        pacer(["a"])
        pacer(["b"])
        self.assertAlmostEqual(waits[0], 0.15)

    def test_repeated_failures_stop_resumably_and_a_later_run_finishes(self):
        rows = [{"id": f"message{n:02}", "threadId": f"thread{n:02}", "date": f"2026-01-{n:02}"} for n in range(1, 8)]
        self.inventory(rows)
        threads = {row["threadId"]: [row["id"]] for row in rows}
        gmail = FakeGmail(threads, fail=set(threads))
        archive = self.archive(gmail)
        archive.run.delays = ()
        lock = self.lock()
        with mock.patch.object(module, "MAX_CONSECUTIVE_FAILURES", 3):
            result = module.backfill(archive, lock)
        self.assertEqual((result["phase"], result["failed"]), ("stopped", 3))
        self.assertEqual(len(evidence.load(self.root / module.ERRORS_NAME)), 3)
        gmail.fail.clear()
        result = module.backfill(archive, lock)
        self.assertEqual((result["phase"], result["collected"]), ("done", 7))
        self.assertEqual(evidence.load(self.root / module.ERRORS_NAME), {})

    def test_trial_run_stops_after_the_requested_threads(self):
        rows = [{"id": f"message{n:02}", "threadId": f"thread{n:02}", "date": f"2026-01-{n:02}"} for n in range(1, 5)]
        self.inventory(rows)
        gmail = FakeGmail({row["threadId"]: [row["id"]] for row in rows})
        result = module.backfill(self.archive(gmail), self.lock(), max_threads=2)
        self.assertEqual((result["phase"], result["collected"], result["remaining"]), ("partial", 2, 2))

    def test_only_one_runner_and_a_crashed_runner_lock_is_taken_over(self):
        first = self.lock()
        self.assertFalse(module.Lock(self.root).acquire())
        evidence.save(first.file, {**first.owner, "pid": 2 ** 22 + 12345})
        with mock.patch.object(module.os, "kill", side_effect=OSError):
            second = module.Lock(self.root)
            self.assertTrue(second.acquire())
        self.assertEqual(evidence.load(second.file)["pid"], os.getpid())

    def test_triage_collection_waits_while_a_backfill_holds_a_fresh_lock(self):
        self.inventory([{"id": "message01", "threadId": "thread01", "date": "2020-01-01"}])
        lock = self.lock()
        archive = evidence.Archive(self.root, lambda c: self.fail(f"provider called: {c[:3]}"))
        self.assertEqual(archive.native_next()["outcome"], "empty")
        self.assertFalse((self.root / "threads").exists())
        # A lock left by a crashed runner stops blocking triage once it is old.
        os.utime(lock.file, (0, 0))
        gmail = FakeGmail({"thread01": ["message01"]})
        evidence.Archive(self.root, gmail).native_next()
        self.assertIn(["gmail", "thread", "get", "thread01", "--full"], gmail.commands)


if __name__ == "__main__":
    unittest.main()
