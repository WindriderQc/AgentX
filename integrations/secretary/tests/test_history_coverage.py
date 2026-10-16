import base64
from datetime import datetime, timezone
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence_record import record_page
from evidence_store import load, save
from history_coverage import coverage, cutoff_date, proof_matches
from secretary_evidence import Archive, sha
from verify_archive import verify


class HistoricalCoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "primary"
        self.before = cutoff_date("2026-01-01T00:00:00-05:00")
        messages = [self.message("message1", "2025-01-01T12:00:00+00:00"),
                    self.message("message2", "2026-01-01T04:59:59+00:00"),
                    self.message("message3", "2026-01-01T05:00:00+00:00"),
                    self.message("message4", "2024-01-01T12:00:00+00:00", ["DRAFT"])]
        self.archive = Archive(self.root, lambda _: {"thread": {"messages": messages}})
        self.manifest = self.archive.collect_thread("thread01")
        for m in messages:
            data = f"Message-ID: <{m['id']}@example.invalid>\r\nSubject: Synthetic\r\n\r\nSynthetic body\r\n".encode()
            digest = sha(data)
            p = self.root / "raw" / (digest + ".eml")
            p.parent.mkdir(exist_ok=True)
            p.write_bytes(data)
            save(self.root / "raw-receipts" / (m["id"] + ".json"), {
                "messageId": m["id"], "threadId": "thread01", "path": str(p.relative_to(self.root)),
                "sha256": digest, "bytes": len(data)})
        for page in self.archive.review_pages(self.manifest):
            record_page(self.archive, page, {"pageId": page["pageId"], "summary": "Synthetic source reviewed.",
                                            "actions": [], "memories": [], "deliverables": [], "invoices": [],
                                            "unresolved": []}, export=False)
        self.copy = Path(self.temp.name) / "mirror"
        shutil.copytree(self.root, self.copy)
        self.primary = verify(self.root, with_sources=True)[0]["verificationProof"]
        self.mirror = verify(self.copy, with_sources=True)[0]["verificationProof"]
        self.mirror["host"] = "independent-synthetic-host"

    def message(self, mid, date, labels=None):
        return {"id": mid, "threadId": "thread01", "body": "Synthetic body",
                "internalDate": str(int(datetime.fromisoformat(date).timestamp() * 1000)),
                "labelIds": labels or ["INBOX", "Secretary/Processed"],
                "headers": {"message-id": f"<{mid}@example.invalid>"}}

    def report(self):
        return coverage(self.archive, self.before, self.primary, self.mirror)

    def test_timezone_cutoff_is_per_message_and_preserves_recent_members_of_old_threads(self):
        report = self.report()
        self.assertEqual([r["messageId"] for r in report["messages"]], ["message4", "message1", "message2"])
        self.assertEqual(report["excluded"]["at_or_after_cutoff"], 1)
        self.assertEqual(report["years"]["2025"]["messages"], 2)
        self.assertFalse(report["executionAllowed"])

    def test_processed_and_complete_do_not_establish_semantic_validation(self):
        row = self.report()["messages"][-1]
        self.assertTrue(row["coverage"]["originalVerified"])
        self.assertTrue(row["coverage"]["independentCopyVerified"])
        self.assertEqual(row["coverage"]["unreadPages"], 0)
        self.assertIn("analysis_validation_required", row["blockers"])
        self.assertIn("message_classification_proof_required", row["blockers"])
        self.assertFalse(row["executionAllowed"])

    def test_two_paths_on_one_host_do_not_prove_independent_preservation(self):
        self.mirror["host"] = self.primary["host"]
        self.assertFalse(self.report()["messages"][-1]["coverage"]["independentCopyVerified"])

    def test_changed_original_receipt_invalidates_old_proofs(self):
        p = self.root / "raw-receipts/message1.json"
        receipt = load(p)
        receipt["sha256"] = "0" * 64
        save(p, receipt)
        row = next(r for r in self.report()["messages"] if r["messageId"] == "message1")
        self.assertIn("original_integrity_not_verified", row["blockers"])
        self.assertIn("independent_original_copy_not_verified", row["blockers"])

    def test_a_stale_review_and_thread_questions_remain_visible(self):
        p = self.root / "reviews/thread01.json"
        review = load(p)
        review.update(evidenceHash="old", unresolved=["Synthetic question"])
        save(p, review)
        row = self.report()["messages"][-1]
        self.assertIn("review_missing_or_stale", row["blockers"])
        self.assertIn("thread_questions_unresolved", row["blockers"])

    def test_unknown_dates_are_blocked_instead_of_assigned_to_a_year(self):
        p = self.root / "threads/thread01/manifest.json"
        manifest = load(p)
        manifest["messages"][0]["internalDate"] = None
        save(p, manifest)
        row = next(r for r in self.report()["messages"] if r["messageId"] == "message1")
        self.assertIn("source_date_unknown", row["blockers"])

    def test_bare_complete_proof_cannot_certify_an_unidentified_file(self):
        proof = {"schema": "agentx.secretary-archive-verification/v1", "intact": True}
        self.assertFalse(proof_matches(proof, "attachments", "unknown", {}))

    def test_cutoff_without_timezone_is_rejected(self):
        with self.assertRaises(ValueError):
            cutoff_date("2026-01-01")

    def test_proofs_require_real_hashes_numeric_sizes_and_an_observation_time(self):
        proof = {'schema': 'agentx.secretary-archive-verification/v1', 'intact': True, 'at': '2026-01-01T00:00:00Z',
                 'raw': {'message1': {'sha256': 'z' * 64, 'bytes': 1}}}
        self.assertFalse(proof_matches(proof, 'raw', 'message1', {'sha256': 'z' * 64, 'bytes': 1}))
        proof['raw']['message1'] = {'sha256': 'a' * 64, 'bytes': True}
        self.assertFalse(proof_matches(proof, 'raw', 'message1', {'sha256': 'a' * 64, 'bytes': True}))
        proof['raw']['message1']['bytes'] = 1
        proof.pop('at')
        self.assertFalse(proof_matches(proof, 'raw', 'message1', {'sha256': 'a' * 64, 'bytes': 1}))


if __name__ == "__main__":
    unittest.main()
