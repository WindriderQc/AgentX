from datetime import datetime, timezone
from pathlib import Path
import shutil
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence_store import load, save
from history_coverage import coverage, finding_id
from retention_dispositions import dispositions
from retention_plan import plan, rolling_cutoff
from secretary_evidence import sha
from value_lanes import LANES_NAME
from verify_archive import verify, restore_sample
from test_retention_plan import RetentionPlanTests

AT = "2026-10-15T08:00:00+00:00"


class OwnerDispositionTests(unittest.TestCase):
    """Saved decisions inform review but confer no native cleanup acceptance."""

    def setUp(self):
        RetentionPlanTests.setUp(self)
        self.tid = "1234567890abcdea"

    def with_finding(self, section="memories"):
        review_file = self.root / "reviews" / f"{self.tid}.json"
        review = load(review_file)
        review[section] = [{"messageId": self.mid, "text": "Synthetic lasting fact", "status": "historical"}]
        save(review_file, review)
        self.refresh_proofs()
        return finding_id(self.tid, section, review[section][0])

    def refresh_proofs(self):
        copy = Path(self.temp.name) / "mirror"
        shutil.rmtree(copy)
        shutil.copytree(self.root, copy)
        tree = {"files": {p.relative_to(self.root).as_posix(): {"sha256": sha(p.read_bytes()), "bytes": p.stat().st_size}
                          for p in self.root.rglob("*") if p.is_file()}}
        self.primary = verify(self.root, with_sources=True, tree_index=tree)[0]["verificationProof"]
        mirror_report, receipts = verify(copy, with_sources=True, tree_index=tree)
        self.mirror = mirror_report["verificationProof"]
        self.mirror["restoreSample"] = restore_sample(copy, receipts, len(receipts), seed=1)
        self.mirror["host"] = "independent-synthetic-host"

    def lane(self, lane):
        save(self.root / LANES_NAME, {"messages": {self.mid: {"threadId": self.tid, "lane": lane, "reason": "synthetic"}}})

    def entry(self, finding, state="retained", **extra):
        return {"id": "e" * 24, "reviewState": state, "revision": 1,
                "source": {"messageId": self.mid, "threadId": self.tid, "findingId": finding}, **extra}

    def owned(self, entries=(), manifests=()):
        rows, _ = dispositions(self.archive, self.before, list(entries), manifests, at=AT)
        return rows

    def target(self, dispositions_, qualification=None):
        result = plan(self.archive, self.before, self.inventory, self.primary, self.mirror,
                      self.qualification if qualification is None else qualification, [],
                      dispositions=dispositions_, clock=self.clock)
        return next(r for r in result["messages"] if r["messageId"] == self.mid), result

    def test_bulk_mail_only_proposes_review_without_native_acceptance(self):
        self.lane("bulk")
        row, result = self.target(self.owned(), qualification={})
        self.assertTrue(row["reviewProposal"], row["reviewBlockers"])
        self.assertFalse(row["candidateForOwnerReview"])
        self.assertEqual(row["basis"], "bulk-lane")
        self.assertFalse(result["executionAllowed"])
        self.assertTrue(result["requiresNativeApproval"])

    def test_bulk_mail_with_an_undecided_obligation_stays_held(self):
        self.with_finding("actions")
        self.lane("bulk")
        row, _ = self.target(self.owned())
        self.assertIn("finding_not_decided_by_owner", row["blockers"])

    def test_retained_actions_and_deliverables_remain_open_in_every_lane(self):
        for section in ("actions", "deliverables"):
            finding = self.with_finding(section)
            for lane in ("bulk", "person", "important"):
                with self.subTest(section=section, lane=lane):
                    self.lane(lane)
                    saved = self.owned([self.entry(finding, "retained")])
                    row, _ = self.target(saved)
                    self.assertIn("retained_action_still_open", row["reviewBlockers"])
                    self.assertFalse(row["reviewProposal"])
                    self.assertFalse(row["candidateForOwnerReview"])

    def test_bulk_does_not_discharge_information_questions_or_visual_reading(self):
        self.with_finding("memories")
        self.lane("bulk")
        row, _ = self.target(self.owned())
        self.assertIn("finding_not_decided_by_owner", row["reviewBlockers"])
        review_file = self.root / "reviews" / f"{self.tid}.json"
        review = load(review_file)
        review["unresolved"] = ["A thread question still needs a source decision"]
        save(review_file, review)
        self.refresh_proofs()
        row, _ = self.target(self.owned())
        self.assertIn("thread_questions_unresolved", row["reviewBlockers"])
        manifest_file = self.root / "threads" / self.tid / "manifest.json"
        manifest = load(manifest_file)
        image = self.root / "files/synthetic.png"
        image.parent.mkdir(exist_ok=True)
        image.write_bytes(b"synthetic unread image")
        item = {"path": "files/synthetic.png", "sha256": sha(image.read_bytes()), "bytes": image.stat().st_size,
                "status": "visual_review_needed", "partId": "1"}
        next(message for message in manifest["messages"] if message["id"] == self.mid)["attachments"] = [item]
        save(manifest_file, manifest)
        self.refresh_proofs()
        row, _ = self.target(self.owned())
        self.assertIn("attachment_analysis_needs_review", row["reviewBlockers"])

    def test_a_forgotten_or_now_absent_decision_never_dispositions_a_finding(self):
        finding = self.with_finding()
        self.lane("person")
        rows = self.owned([self.entry(finding, "forgotten")])
        row = next(row for row in rows if row["messageId"] == self.mid)
        self.assertEqual(row["findings"][finding]["decidedBy"], [])
        self.assertFalse(self.target(rows)[0]["reviewProposal"])
        self.assertFalse(self.target(self.owned([]))[0]["reviewProposal"])

    def test_an_open_related_core_action_remains_undecided_beside_addressed_information(self):
        finding = self.with_finding()
        self.lane("person")
        kept = self.entry(finding, "retained", kind="fact")
        open_action = {**self.entry("a" * 64, "retained", kind="action"), "id": "b" * 24}
        rows = self.owned([kept, open_action])
        row, _ = self.target(rows)
        self.assertIn("owner_review_entries_undecided", row["reviewBlockers"])
        self.assertFalse(row["reviewProposal"])

    def test_lane_or_page_receipt_changes_make_a_saved_disposition_stale(self):
        self.lane("bulk")
        rows = self.owned()
        self.lane("person")
        self.assertIn("value_lane_snapshot_stale", self.target(rows)[0]["reviewBlockers"])
        self.lane("bulk")
        page = next(page for page in self.archive.review_pages(load(self.root / "threads" / self.tid / "manifest.json"))
                    if page["messageId"] == self.mid)
        file = self.root / "page-reviews" / (page["pageId"] + ".json")
        receipt = load(file)
        receipt["summary"] = "A changed saved reading version"
        save(file, receipt)
        self.assertIn("owner_disposition_stale_or_wrong_source", self.target(rows)[0]["reviewBlockers"])

    def test_person_mail_without_any_finding_waits_for_a_later_owner_validation(self):
        self.lane("person")
        row, _ = self.target(self.owned())
        self.assertIn("no_owner_decision_yet", row["blockers"])
        self.assertFalse(row["candidateForOwnerReview"])

    def test_person_mail_needs_every_finding_decided_by_the_owner(self):
        finding = self.with_finding()
        self.lane("person")
        held, _ = self.target(self.owned())
        self.assertIn("finding_not_decided_by_owner", held["blockers"])
        pending, _ = self.target(self.owned([self.entry(finding, "candidate")]))
        self.assertIn("owner_review_entries_undecided", pending["blockers"])
        kept, _ = self.target(self.owned([self.entry(finding, "retained", souvenirNoteId="f" * 24)]))
        self.assertTrue(kept["reviewProposal"], kept["reviewBlockers"])
        self.assertFalse(kept["candidateForOwnerReview"])
        self.assertEqual(kept["basis"], "owner-decided")

    def test_a_consolidated_candidate_decides_every_finding_it_merged(self):
        finding = self.with_finding()
        self.lane("important")
        cluster = "c" * 64
        manifest = {"entries": [{"source": {"findingId": cluster}, "findingIds": [finding]}]}
        rows = self.owned([self.entry(cluster, "dismissed")], [manifest])
        row = next(r for r in rows if r["messageId"] == self.mid)
        self.assertEqual(row["findings"][finding]["decidedBy"][0]["state"], "dismissed")
        target, _ = self.target(rows)
        self.assertTrue(target["reviewProposal"], target["reviewBlockers"])
        self.assertFalse(target["candidateForOwnerReview"])

    def test_a_stale_or_mismatched_disposition_is_refused(self):
        self.lane("bulk")
        rows = self.owned()
        stale = [{**r, "sourceSha256": "0" * 64} if r["messageId"] == self.mid else r for r in rows]
        row, _ = self.target(stale)
        self.assertIn("owner_disposition_stale_or_wrong_source", row["blockers"])
        wrong = [{**r, "basis": "owner-decided"} if r["messageId"] == self.mid else r for r in rows]
        row, _ = self.target(wrong)
        self.assertIn("owner_disposition_basis_invalid", row["blockers"])

    def test_v1_snapshots_remain_review_data_without_v2_or_native_acceptance(self):
        self.lane("bulk")
        rows = [{**row, "schema": "agentx.secretary-retention-disposition/v1"} for row in self.owned()]
        row, report = self.target(rows)
        self.assertIn("owner_disposition_contract_not_current", row["reviewBlockers"])
        self.assertFalse(row["reviewProposal"])
        self.assertFalse(row["candidateForOwnerReview"])
        self.assertEqual(report["reviewAttestations"]["ownerDispositions"], rows)

    def test_integrity_draft_and_provider_blockers_are_never_waived(self):
        self.lane("bulk")
        save(self.root / LANES_NAME, {"messages": {mid: {"threadId": self.tid, "lane": "bulk", "reason": "synthetic"}
                                                   for mid in (self.mid, "1234567890abcde1")}})
        rows = self.owned()
        result = plan(self.archive, self.before, {**self.inventory, "ids": ["1234567890abcde1"]}, self.primary,
                      self.mirror, {}, [], dispositions=rows, clock=self.clock)
        by_id = {r["messageId"]: r for r in result["messages"]}
        self.assertIn("message_absent_from_provider_inventory", by_id[self.mid]["blockers"])
        self.assertIn("draft", by_id["1234567890abcde1"]["blockers"])

    def test_rolling_cutoff_is_midnight_utc_the_given_days_ago(self):
        cutoff = rolling_cutoff(456, datetime(2026, 10, 23, 15, 30, tzinfo=timezone.utc))
        self.assertEqual(cutoff.isoformat(), "2025-07-24T00:00:00+00:00")
        self.assertEqual(len(coverage(self.archive, cutoff)["messages"]), 0)


if __name__ == "__main__":
    unittest.main()
