"""Changed evidence must neither strand the cursor nor rewrite earlier receipts."""
import base64
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    "secretary_evidence", Path(__file__).resolve().parents[1] / "secretary_evidence.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
import evidence_record


class ReviewRevisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = {"thread": {"messages": [
            {"id": "message1", "body": "A" * 9000, "headers": {}, "payload": {"parts": [
                {"filename": "document.txt", "mimeType": "text/plain",
                 "body": {"data": base64.urlsafe_b64encode(b"old document").decode()}}]}},
            {"id": "message2", "body": "Removed message", "headers": {}},
        ]}}
        self.archive = module.Archive(self.root, lambda _: self.payload)
        manifest = self.archive.collect_thread("thread01")
        pages = list(self.archive.review_pages(manifest))
        self.keep_page = pages[0]
        removed_page = next(p for p in pages if p["messageId"] == "message2")
        old_attachment = manifest["messages"][0]["attachments"][0]["sha256"]
        self.archive.review({
            "threadId": "thread01", "evidenceHash": manifest["evidenceHash"],
            "coverage": "partial", "summary": "Earlier revision summary",
            "actions": [
                {"messageId": "message1", "text": "Surviving task", "personalTaskId": "task-receipt"},
                {"messageId": "message2", "text": "Removed source", "personalTaskId": "old-task-receipt"},
                {"messageId": "message1", "attachmentSha256": old_attachment, "text": "Old attachment"}],
            "memories": [{"messageId": "message1", "text": "Surviving note", "personalNoteId": "note-receipt"}],
            "unresolved": ["Earlier question remains open"],
            "pageSummaries": {
                self.keep_page["pageId"]: {"messageId": "message1", "summary": "Unchanged body page"},
                removed_page["pageId"]: {"messageId": "message2", "summary": "Removed page"}},
            "qualityReview": {"status": "accepted"},
        }, export=False)
        self.old_review = module.load(self.root / "reviews/thread01.json")
        self.payload["thread"]["messages"].pop()
        self.payload["thread"]["messages"][0]["payload"]["parts"] = []
        self.manifest = self.archive.collect_thread("thread01")
        self.page = next(p for p in self.archive.review_pages(self.manifest)
                         if p["kind"] == "body" and p["offset"] == 4000)
        module.save(self.root / "native-worker.json", {"lane": 0, "issued": self.page})

    def record(self, **fields):
        return self.archive.native_record({"pageId": self.page["pageId"], "summary": "New page read", **fields})

    def test_changed_sources_preserve_history_and_valid_receipts_then_advance(self):
        result = self.record(actions=[{"messageId": "message1", "text": "New finding"}])
        self.assertTrue(result["saved"])
        review = module.load(self.root / "reviews/thread01.json")
        history = list((self.root / "review-history/thread01").glob("*.json"))
        self.assertEqual(len(history), 1)
        self.assertEqual(module.load(history[0]), self.old_review)
        self.assertEqual(history[0].stem, review["previousReviewRevision"])
        self.assertEqual(history[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(review["evidenceHash"], self.manifest["evidenceHash"])
        self.assertEqual(review["coverage"], "partial")
        self.assertEqual([r["text"] for r in review["actions"]], ["Surviving task", "New finding"])
        self.assertEqual(review["actions"][0]["personalTaskId"], "task-receipt")
        self.assertEqual(review["memories"][0]["personalNoteId"], "note-receipt")
        self.assertEqual(review["unresolved"], self.old_review["unresolved"])
        self.assertEqual(set(review["pageSummaries"]), {self.keep_page["pageId"], self.page["pageId"]})
        self.assertEqual(review["summary"], "New page read")
        self.assertNotIn("qualityReview", review)
        self.assertIsNone(module.load(self.root / "native-worker.json")["issued"])
        self.assertEqual(result["progress"]["reviewedPages"], 1)
        # Retry the same content through the shared catch-up recorder: no second
        # history snapshot, no duplicate finding, and the receipt is unchanged.
        evidence_record.record_page(self.archive, self.page,
                                   {"pageId": self.page["pageId"], "summary": "New page read"})
        self.assertEqual(list((self.root / "review-history/thread01").glob("*.json")), history)
        self.assertEqual(module.load(history[0]), self.old_review)

    def test_new_invalid_citation_still_rejects_without_advancing(self):
        with self.assertRaisesRegex(ValueError, "issued messageId"):
            self.record(actions=[{"messageId": "message2", "text": "Invalid new finding"}])
        self.assertEqual(module.load(self.root / "reviews/thread01.json"), self.old_review)
        self.assertFalse((self.root / "review-history").exists())
        self.assertFalse((self.root / "page-reviews").exists())
        self.assertEqual(module.load(self.root / "native-worker.json")["issued"], self.page)
        self.assertTrue(self.record()["saved"])

    def test_failed_history_write_leaves_original_and_cursor_intact(self):
        original_save = evidence_record.save

        def fail_history(path, value):
            if "review-history" in path.parts:
                raise OSError("archive unavailable")
            original_save(path, value)

        with mock.patch.object(evidence_record, "save", side_effect=fail_history):
            with self.assertRaisesRegex(OSError, "archive unavailable"):
                self.record()
        self.assertEqual(module.load(self.root / "reviews/thread01.json"), self.old_review)
        self.assertFalse((self.root / "page-reviews").exists())
        self.assertEqual(module.load(self.root / "native-worker.json")["issued"], self.page)
        self.assertTrue(self.record()["saved"])

    def test_current_revision_invalid_receipts_are_not_silently_discarded(self):
        invalid = {**self.old_review, "evidenceHash": self.manifest["evidenceHash"]}
        module.save(self.root / "reviews/thread01.json", invalid)
        with self.assertRaisesRegex(ValueError, "collected messageId"):
            self.record()
        self.assertEqual(module.load(self.root / "reviews/thread01.json"), invalid)
        self.assertFalse((self.root / "page-reviews").exists())
        self.assertFalse((self.root / "review-history").exists())


if __name__ == "__main__":
    unittest.main()
