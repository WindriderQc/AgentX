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
from verify_archive import verify
from test_retention_plan import RetentionPlanTests

AT = "2026-10-15T08:00:00+00:00"


class OwnerDispositionTests(unittest.TestCase):
    """Owner decisions and bulk mail stand in for an exact-message analysis."""

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
        self.mirror = verify(copy, with_sources=True, tree_index=tree)[0]["verificationProof"]
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

    def test_bulk_mail_becomes_a_candidate_without_the_analysis_qualification(self):
        self.lane("bulk")
        row, result = self.target(self.owned(), qualification={})
        self.assertTrue(row["candidateForOwnerReview"], row["blockers"])
        self.assertEqual(row["basis"], "bulk-lane")
        self.assertFalse(result["executionAllowed"])
        self.assertTrue(result["requiresNativeApproval"])

    def test_bulk_mail_with_an_undecided_obligation_stays_held(self):
        self.with_finding("actions")
        self.lane("bulk")
        row, _ = self.target(self.owned())
        self.assertIn("finding_not_decided_by_owner", row["blockers"])

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
        self.assertTrue(kept["candidateForOwnerReview"], kept["blockers"])
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
        self.assertTrue(target["candidateForOwnerReview"], target["blockers"])

    def test_a_stale_or_mismatched_disposition_is_refused(self):
        self.lane("bulk")
        rows = self.owned()
        stale = [{**r, "sourceSha256": "0" * 64} if r["messageId"] == self.mid else r for r in rows]
        row, _ = self.target(stale)
        self.assertIn("owner_disposition_stale_or_wrong_source", row["blockers"])
        wrong = [{**r, "basis": "owner-decided"} if r["messageId"] == self.mid else r for r in rows]
        row, _ = self.target(wrong)
        self.assertIn("owner_disposition_basis_invalid", row["blockers"])

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
