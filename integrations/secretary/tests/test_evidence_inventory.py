from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence_inventory import collection_status, collect_discovered, rediscovered, unavailable
from evidence_store import load, save
from gmail_provider import GmailProviderError, failure_kind
from secretary_evidence import Archive
import mailbox_backfill


class InventoryReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.row = {"id": "oldDraft1", "threadId": "thread01", "labels": ["DRAFT"]}
        save(self.root / "inventory-contact.json", {"complete": True, "messages": {self.row["id"]: self.row}})
        self.manifest = {"threadId": "thread01", "messages": [{"id": "message1", "attachments": []}]}

    def archive(self, kind="not_found", thread_missing=False):
        def run(command):
            if command[:3] == ["gmail", "thread", "get"]:
                if thread_missing:
                    raise GmailProviderError("gmail.thread.get", 5, "not_found")
                return {"thread": {"messages": [{"id": "message1", "threadId": "thread01",
                                                  "body": "Synthetic preserved message"}]}}
            if command[:2] == ["gmail", "get"]:
                raise GmailProviderError("gmail.get", 5, kind)
            raise AssertionError(command)
        return Archive(self.root, run)

    def test_stale_draft_is_reconciled_without_erasing_inventory_or_thread(self):
        archive = self.archive()
        result = collect_discovered(archive, "thread01", [self.row])
        self.assertEqual(result, {"collected": True, "unavailable": ["oldDraft1"]})
        status = collection_status(archive, ["contact"], [self.manifest])
        self.assertEqual(status, {"uncollectedThreads": 0, "discoveringScopes": [],
                                  "unavailableMessages": 1, "unavailableDraftMessages": 1})
        self.assertIn("oldDraft1", load(self.root / "inventory-contact.json")["messages"])
        self.assertTrue((self.root / "threads/thread01/original.json").exists())
        receipt = load(self.root / "source-availability/oldDraft1.json")
        self.assertEqual(load(self.root / receipt["receipt"])["outcome"], "not_found")

    def test_thread_not_found_requires_individual_message_not_found_evidence(self):
        result = collect_discovered(self.archive(thread_missing=True), "thread01", [self.row])
        self.assertFalse(result["collected"])
        self.assertTrue(unavailable(self.root, self.row))

    def test_auth_network_and_unknown_errors_never_hide_missing_sources(self):
        for kind in ("authorization", "transient", "unknown"):
            with self.subTest(kind=kind), self.assertRaises(GmailProviderError):
                collect_discovered(self.archive(kind), "thread01", [self.row])
            self.assertFalse(unavailable(self.root, self.row))
            self.assertEqual(collection_status(self.archive(), ["contact"], [self.manifest])["uncollectedThreads"], 1)

    def test_a_source_that_still_exists_remains_pending_until_full_collection(self):
        archive = self.archive()
        original = archive.run
        archive.run = lambda command: {"id": "oldDraft1", "threadId": "thread01"} if command[:2] == ["gmail", "get"] else original(command)
        collect_discovered(archive, "thread01", [self.row])
        self.assertFalse(unavailable(self.root, self.row))
        self.assertEqual(collection_status(archive, ["contact"], [self.manifest])["uncollectedThreads"], 1)

    def test_rediscovery_reopens_collection_and_retains_both_observations(self):
        collect_discovered(self.archive(), "thread01", [self.row])
        rediscovered(self.root, self.row)
        self.assertFalse(unavailable(self.root, self.row))
        self.assertEqual(collection_status(self.archive(), ["contact"], [self.manifest])["uncollectedThreads"], 1)
        outcomes = {load(p)["outcome"] for p in (self.root / "source-observations/oldDraft1").glob("*.json")}
        self.assertEqual(outcomes, {"available", "not_found"})

    def test_pacer_does_not_retry_not_found_or_authorization_as_transient(self):
        for kind in ("not_found", "authorization"):
            called = []
            def run(command):
                called.append(command)
                raise GmailProviderError("gmail.get", 5, kind)
            pacer = mailbox_backfill.Pacer(run, sleep=lambda _: self.fail("must not back off"))
            with self.assertRaises(GmailProviderError):
                pacer(["gmail", "get", "oldDraft1"])
            self.assertEqual(len(called), 1)

    def test_exit_code_alone_is_not_evidence_of_disappearance(self):
        self.assertEqual(failure_kind(SimpleNamespace(stderr="", returncode=5)), "unknown")
        self.assertEqual(failure_kind(SimpleNamespace(stderr="Google API error (404 notFound): Requested entity was not found.")), "not_found")
        self.assertEqual(failure_kind(SimpleNamespace(stderr="Google API error (403): permission denied")), "authorization")

    def test_losing_the_immutable_observation_reopens_the_gap(self):
        collect_discovered(self.archive(), "thread01", [self.row])
        receipt = load(self.root / "source-availability/oldDraft1.json")
        (self.root / receipt["receipt"]).unlink()
        self.assertFalse(unavailable(self.root, self.row))


if __name__ == "__main__":
    unittest.main()
