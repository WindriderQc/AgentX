import base64
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SECRETARY_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SECRETARY_DIR))
SPEC = importlib.util.spec_from_file_location("raw_messages", SECRETARY_DIR / "raw_messages.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
evidence = sys.modules["secretary_evidence"]
backfill = sys.modules["mailbox_backfill"]


def rfc822(mid):
    return (f"Message-ID:\r\n <{mid}@example.invalid>\r\nSubject: Synthetic\r\n\r\nSynthetic body {mid}\r\n").encode()


class FakeGmail:
    """Synthetic read-only provider for full threads and raw messages."""

    def __init__(self, threads):
        self.threads = threads
        self.commands, self.tamper = [], {}

    def __call__(self, command):
        self.commands.append(command)
        if command[:3] == ["gmail", "thread", "get"]:
            return {"thread": {"messages": [
                {"id": mid, "threadId": command[3], "internalDate": str(1000 + n), "body": "x",
                 "headers": {"message-id": f"<{mid}@example.invalid>", "subject": "Synthetic"},
                 "payload": {"parts": []}}
                for n, mid in enumerate(self.threads[command[3]])]}}
        if command[:2] == ["gmail", "get"] and command[3] == "--format=raw":
            mid = command[2]
            data = self.tamper.get(mid, {}).get("data", rfc822(mid))
            size = self.tamper.get(mid, {}).get("size", len(data))
            return {"message": {"id": mid, "raw": base64.urlsafe_b64encode(data).decode().rstrip("="),
                                "sizeEstimate": size, "labelIds": ["INBOX"], "internalDate": "1000", "historyId": "7"}}
        raise AssertionError(f"unexpected provider command {command[:3]}")


class RawMessageTests(unittest.TestCase):
    def setUp(self):
        queries = mock.patch.dict(evidence.QUERIES, {"mailbox": "in:anywhere"}, clear=True)
        queries.start()
        self.addCleanup(queries.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.gmail = FakeGmail({"thread01": ["message01", "message02"], "thread02": ["message03"]})
        self.archive = evidence.Archive(self.root, self.gmail)
        for thread in self.gmail.threads:
            self.archive.collect_thread(thread)
        rows = [{"id": mid, "threadId": tid} for tid, mids in self.gmail.threads.items() for mid in mids]
        evidence.save(self.root / "inventory-mailbox.json",
                      {"query": "in:anywhere", "complete": True, "messages": {r["id"]: r for r in rows}})
        self.archive.run = backfill.Pacer(self.gmail, min_interval=0, sleep=lambda _: None)

    def lock(self):
        lock = backfill.Lock(self.root, module.LOCK_NAME)
        self.assertTrue(lock.acquire())
        self.addCleanup(lock.release)
        return lock

    def test_every_archived_message_gets_a_verified_original_eml(self):
        result = module.sync(self.archive, self.lock())
        self.assertEqual((result["phase"], result["fetched"]), ("done", 3))
        receipt = json.loads((self.root / module.RECEIPTS / "message01.json").read_text())
        self.assertEqual((self.root / receipt["path"]).read_bytes(), rfc822("message01"))
        self.assertTrue(receipt["path"].endswith(".eml"))
        self.assertEqual(receipt["labelIds"], ["INBOX"])
        self.assertTrue(receipt["messageIdMatched"])

    def test_a_second_sync_fetches_nothing_already_verified(self):
        module.sync(self.archive, self.lock())
        self.gmail.commands.clear()
        result = module.sync(self.archive, backfill.Lock(self.root, module.LOCK_NAME))
        self.assertEqual((result["fetched"], result["pendingAtStart"]), (0, 0))
        self.assertFalse(self.gmail.commands)

    def test_size_or_message_id_mismatch_is_never_accepted(self):
        self.gmail.tamper["message01"] = {"size": 1}
        self.gmail.tamper["message03"] = {"data": rfc822("someone-else")}
        result = module.sync(self.archive, self.lock())
        self.assertEqual((result["phase"], result["fetched"], result["failed"]), ("partial", 1, 2))
        self.assertFalse((self.root / module.RECEIPTS / "message01.json").exists())
        errors = json.loads((self.root / module.ERRORS_NAME).read_text())
        self.assertEqual(set(errors), {"message01", "message03"})
        self.assertNotIn("Synthetic body", json.dumps(errors))

    def test_completeness_report_lists_what_is_missing_by_id_only(self):
        report = module.completeness(self.archive)
        self.assertFalse(report["complete"])
        self.assertEqual(report["scopes"]["mailbox"]["missingRaw"], ["message01", "message02", "message03"])
        module.sync(self.archive, self.lock())
        report = module.completeness(self.archive, rehash=True)
        self.assertTrue(report["complete"])
        self.assertEqual(module.summary(report)["scopes"]["mailbox"]["rawVerified"], 3)

    def test_a_damaged_original_is_detected_by_rehash_and_refetched(self):
        module.sync(self.archive, self.lock())
        receipt = json.loads((self.root / module.RECEIPTS / "message03.json").read_text())
        file = self.root / receipt["path"]
        file.write_bytes(b"X" * len(file.read_bytes()))
        self.assertFalse(module.completeness(self.archive, rehash=True)["complete"])
        result = module.sync(self.archive, backfill.Lock(self.root, module.LOCK_NAME), rehash=True)
        self.assertEqual(result["fetched"], 1)
        self.assertEqual(file.read_bytes(), rfc822("message03"))

    def test_a_thread_never_archived_is_reported_missing(self):
        inventory = evidence.load(self.root / "inventory-mailbox.json")
        inventory["messages"]["message09"] = {"id": "message09", "threadId": "thread09"}
        evidence.save(self.root / "inventory-mailbox.json", inventory)
        report = module.completeness(self.archive)
        self.assertEqual(report["scopes"]["mailbox"]["missingThread"], ["message09"])

    def test_the_raw_sync_lock_does_not_pause_triage_collection(self):
        self.lock()
        self.assertFalse((self.root / backfill.LOCK_NAME).exists())


if __name__ == "__main__":
    unittest.main()
