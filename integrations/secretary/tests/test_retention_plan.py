from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence_record import record_page
from evidence_store import load, save
from history_coverage import content_hash, cutoff_date, coverage
from retention_plan import ANALYSIS_CONTRACT, QUALIFICATION_CASES, plan, review_packet, qualification_valid
from secretary_evidence import Archive, sha
from verify_archive import verify


class RetentionPlanTests(unittest.TestCase):
    def test_passing_focus_cases_do_not_override_an_absent_or_false_qualification_attestation(self):
        self.assertTrue(qualification_valid(self.qualification))
        for value in (False, None, 1, "true"):
            with self.subTest(value=value):
                receipt = {**self.qualification, 'qualified': value}
                self.assertFalse(qualification_valid(receipt))
        receipt = dict(self.qualification)
        del receipt['qualified']
        self.assertFalse(qualification_valid(receipt))

    def test_new_reference_challenges_are_unqualified_inputs_not_successful_process_receipts(self):
        corpus = load(ROOT / 'fixtures/retention-challenges.json')
        self.assertFalse(corpus['qualified'])
        self.assertFalse(qualification_valid(corpus))
        covered = {kind for case in corpus['cases'] for kind in case['covers']}
        self.assertTrue({'signature_information', 'owner_aliases', 'mime_alternatives', 'external_references'}.issubset(covered))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "primary"
        self.before = cutoff_date("2026-01-01T00:00:00-05:00")
        self.clock = datetime(2026, 10, 15, 8, tzinfo=timezone.utc)
        self.mid = "1234567890abcdef"
        messages = [{"id": mid, "threadId": "1234567890abcdea", "body": "Synthetic complete source",
                     "labelIds": labels, "internalDate": str(int(date.timestamp() * 1000)),
                     "headers": {"message-id": f"<{mid}@example.invalid>"}}
                    for mid, labels, date in (
                        (self.mid, ["INBOX", "Secretary/Processed"], self.before - timedelta(seconds=1)),
                        ("1234567890abcde0", ["INBOX"], self.before),
                        ("1234567890abcde1", ["DRAFT"], self.before - timedelta(days=1)))]
        self.archive = Archive(self.root, lambda _: {"thread": {"messages": messages}})
        manifest = self.archive.collect_thread("1234567890abcdea")
        for message in messages:
            data = f"Message-ID: <{message['id']}@example.invalid>\r\n\r\nSynthetic complete source".encode()
            relative = f"raw/{sha(data)}.eml"
            (self.root / "raw").mkdir(exist_ok=True)
            (self.root / relative).write_bytes(data)
            save(self.root / "raw-receipts" / f"{message['id']}.json", {
                "messageId": message["id"], "threadId": manifest["threadId"], "path": relative,
                "sha256": sha(data), "bytes": len(data)})
        for page in self.archive.review_pages(manifest):
            record_page(self.archive, page, {"pageId": page["pageId"], "summary": "Synthetic reading receipt",
                "actions": [], "memories": [], "deliverables": [], "invoices": [], "unresolved": []}, export=False)
        copy = Path(self.temp.name) / "mirror"
        shutil.copytree(self.root, copy)
        tree_index = {"files": {p.relative_to(self.root).as_posix(): {"sha256": sha(p.read_bytes()), "bytes": p.stat().st_size}
                                 for p in self.root.rglob("*") if p.is_file()}}
        self.primary = verify(self.root, with_sources=True, tree_index=tree_index)[0]["verificationProof"]
        self.mirror = verify(copy, with_sources=True, tree_index=tree_index)[0]["verificationProof"]
        self.mirror["host"] = "independent-synthetic-host"
        self.inventory = {"query": f"in:anywhere before:{int(self.before.timestamp())}", "complete": True,
                          "next": None, "updatedAt": self.clock.isoformat(),
                          "ids": [self.mid, "1234567890abcde1"]}
        self.qualification = {"schema": "agentx.secretary-retention-qualification/v1", "qualified": True, "at": self.clock.isoformat(),
            "analysisContract": ANALYSIS_CONTRACT, "reviewerId": "synthetic-qualified-reviewer", "corpusSha256": "a" * 64,
            "cases": [{"passed": True, "sourceSha256": "b" * 64, "reason": "Synthetic case independently compared",
                       "covers": sorted(QUALIFICATION_CASES)}]}

    def decision(self, mid=None):
        row = next(r for r in coverage(self.archive, self.before, self.primary, self.mirror)["messages"]
                   if r["messageId"] == (mid or self.mid))
        packet = review_packet(self.archive, row)
        disposition = {"state": "addressed", "reason": "Synthetic evidence checked", "evidenceRef": "synthetic-receipt"}
        return {"schema": ANALYSIS_CONTRACT, "messageId": row["messageId"], "threadId": row["threadId"],
                "sourceSha256": row["originalSha256"], "evidenceHash": row["evidenceHash"],
                "reviewSha256": row["reviewSha256"], "packetSha256": content_hash(packet),
                "qualificationSha256": content_hash(self.qualification), "reviewerId": self.qualification["reviewerId"],
                "at": self.clock.isoformat(), "reason": "Synthetic full-source analysis and disposition checked",
                "checks": {key: True for key in ("wholeOriginalRead", "quotedAuthorshipChecked", "datesChecked",
                    "threadContextChecked", "noOutstandingAction", "allInformationAddressed", "signaturesChecked",
                    "identityAttributionChecked", "allMimeRepresentationsChecked", "externalReferencesDispositioned")},
                "findings": {key: {**disposition, "state": "resolved" if kind == "actions" else "retained"}
                             for key, kind in packet["findingIds"].items()},
                "pages": {key: {**disposition, "state": "read"} for key in packet["pageIds"]},
                "attachments": {key: deepcopy(disposition) for key in packet["attachmentIds"]},
                "questions": {key: deepcopy(disposition) for key in packet["questionIds"]}}

    def result(self, decisions=()):
        return plan(self.archive, self.before, self.inventory, self.primary, self.mirror,
                    self.qualification, decisions, clock=self.clock)

    def target(self, result):
        return next(r for r in result["messages"] if r["messageId"] == self.mid)

    def test_no_receipt_means_no_candidate_even_when_processed_and_fully_read(self):
        result = self.result()
        self.assertEqual(result["counts"]["candidatesForOwnerReview"], 0)
        self.assertIn("analysis_missing_or_ambiguous", self.target(result)["blockers"])
        self.assertFalse(result["executionAllowed"])

    def test_qualified_exact_review_only_prepares_an_owner_candidate_and_preserves_mixed_thread(self):
        result = self.result([self.decision(), self.decision("1234567890abcde1")])
        self.assertEqual(result["counts"]["candidatesForOwnerReview"], 1)
        self.assertTrue(self.target(result)["candidateForOwnerReview"])
        self.assertTrue(result["requiresNativeApproval"])
        self.assertFalse(any(r["executionAllowed"] for r in result["messages"]))
        self.assertNotIn("1234567890abcde0", [r["messageId"] for r in result["messages"]])
        self.assertIn("draft", next(r for r in result["messages"] if r["messageId"].endswith("1"))["blockers"])

    def test_incomplete_wrong_timezone_duplicate_or_stale_inventory_blocks(self):
        original = deepcopy(self.inventory)
        for changes in ({"complete": False}, {"query": "before:2026/01/01"}, {"ids": [self.mid, self.mid]},
                        {"updatedAt": (self.clock - timedelta(days=2)).isoformat()},
                        {"updatedAt": (self.clock + timedelta(hours=1)).isoformat()}):
            with self.subTest(changes=changes):
                self.inventory = {**original, **changes}
                self.assertFalse(self.target(self.result([self.decision()]))["candidateForOwnerReview"])

    def test_same_host_or_corrupt_copy_cannot_be_waived_by_analysis(self):
        self.mirror["host"] = self.primary["host"]
        self.assertIn("independent_original_copy_not_verified", self.target(self.result([self.decision()]))["blockers"])
        self.mirror["host"] = "independent-synthetic-host"
        self.primary["intact"] = False
        self.assertIn("original_integrity_not_verified", self.target(self.result([self.decision()]))["blockers"])

    def test_source_revision_and_page_receipts_are_pinned(self):
        decision = self.decision()
        decision["sourceSha256"] = "c" * 64
        self.assertIn("analysis_receipt_stale_or_wrong_source", self.target(self.result([decision]))["blockers"])
        decision = self.decision()
        decision["pages"] = {}
        self.assertIn("pages_review_incomplete", self.target(self.result([decision]))["blockers"])

    def test_retaining_an_open_action_or_claiming_no_actions_cannot_hide_a_finding(self):
        path = self.root / "reviews/1234567890abcdea.json"
        review = load(path)
        review["actions"] = [{"messageId": self.mid, "text": "Synthetic unpaid follow-up", "status": "open"}]
        save(path, review)
        decision = self.decision()
        identity = next(iter(decision["findings"]))
        decision["findings"][identity]["state"] = "retained"
        self.assertIn("finding_disposition_unproven", self.target(self.result([decision]))["blockers"])
        decision["findings"] = {}
        self.assertIn("finding_dispositions_incomplete", self.target(self.result([decision]))["blockers"])

    def test_thread_questions_require_exact_evidence_even_when_source_has_no_findings(self):
        path = self.root / "reviews/1234567890abcdea.json"
        review = load(path); review["unresolved"] = ["Synthetic question with unclear author"]
        save(path, review)
        decision = self.decision(); decision["questions"] = {}
        self.assertIn("questions_review_incomplete", self.target(self.result([decision]))["blockers"])

    def test_failed_or_changed_calibration_and_ambiguous_decisions_block(self):
        decision = self.decision()
        self.qualification["cases"][0]["passed"] = False
        row = self.target(self.result([decision]))
        self.assertIn("triage_process_not_qualified", row["blockers"])
        self.assertIn("analysis_receipt_stale_or_wrong_source", row["blockers"])
        self.assertIn("analysis_missing_or_ambiguous", self.target(self.result([decision, decision]))["blockers"])

    def test_explicit_outstanding_action_or_unaddressed_information_holds(self):
        for check in ("noOutstandingAction", "allInformationAddressed", "signaturesChecked",
                      "identityAttributionChecked", "allMimeRepresentationsChecked", "externalReferencesDispositioned"):
            decision = self.decision(); decision["checks"][check] = False
            self.assertIn(check, self.target(self.result([decision]))["blockers"])

    def test_visual_attachment_review_cannot_replace_missing_copies_or_be_omitted(self):
        file = self.root / "threads/1234567890abcdea/manifest.json"
        manifest = load(file)
        data = b"synthetic attachment bytes"
        attachment = {"sha256": sha(data), "path": "files/synthetic.png", "bytes": len(data),
                      "status": "visual_review_needed", "partId": "1"}
        next(m for m in manifest["messages"] if m["id"] == self.mid)["attachments"] = [attachment]
        save(file, manifest)
        (self.root / "files").mkdir(exist_ok=True)
        (self.root / attachment["path"]).write_bytes(data)
        self.primary = verify(self.root, with_sources=True)[0]["verificationProof"]
        decision = self.decision()
        self.assertIn("attachment_copies_not_verified", self.target(self.result([decision]))["blockers"])
        mirror = Path(self.temp.name) / "mirror"
        shutil.copytree(self.root, mirror, dirs_exist_ok=True)
        self.mirror = verify(mirror, with_sources=True)[0]["verificationProof"]
        self.mirror["host"] = "independent-synthetic-host"
        decision = self.decision(); decision["attachments"] = {}
        self.assertIn("attachments_review_incomplete", self.target(self.result([decision]))["blockers"])

    def test_even_exact_analysis_cannot_override_a_stale_thread_review(self):
        file = self.root / "reviews/1234567890abcdea.json"
        review = load(file); review["evidenceHash"] = "old"
        save(file, review)
        self.assertIn("review_missing_or_stale", self.target(self.result([self.decision()]))["blockers"])

    def test_missing_provider_message_is_reported_without_expanding_candidate_scope(self):
        self.inventory["ids"].append("abcdef1234567890")
        result = self.result([self.decision()])
        self.assertEqual(result["providerMessagesWithoutHistoricalArchive"], ["abcdef1234567890"])
        self.assertEqual(result["counts"]["candidatesForOwnerReview"], 1)


if __name__ == "__main__":
    unittest.main()
