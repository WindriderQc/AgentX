import tempfile
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from memory_review import reporting  # noqa: E402


def run_doc(*, status="proposed", updated="2026-08-11T01:02:03Z"):
    return {
        "runId": "run-1",
        "mode": "review",
        "status": "ready_for_review",
        "createdAt": "2026-08-11T01:00:00Z",
        "updatedAt": updated,
        "window": {},
        "model": {},
        "collectors": [],
        "audit": [],
        "candidates": [{
            "candidateId": "abc123",
            "type": "durable_fact",
            "statement": "A bounded durable statement.",
            "target": {"kind": "shared_fact"},
            "status": status,
            "evidence": [],
            "recurrence": {},
            "risk": {},
            "apply": {"attemptedAt": updated, "result": "ok", "adapter": "shared_fact"}
            if status == "applied" else {},
        }],
    }


class ReportingTests(unittest.TestCase):
    def test_empty_completed_collection_renders_without_candidate_policy(self):
        run = run_doc()
        run.update(status="completed", candidates=[], summary={"noEligibleObservations": True},
                   collectors=[{"runtime": "openclaw", "host": "synthetic-host",
                                "eligibleObservations": 0, "rejectedObservations": 2}])
        with tempfile.TemporaryDirectory() as temp:
            target = reporting.write_report(Path(temp), run)
            text = target.read_text(encoding="utf-8")
        self.assertIn("eligible=0 rejected=2", text)
        self.assertIn("No eligible observations - the model was not called.", text)
        self.assertNotIn("- policy:", text)

    def test_policy_belongs_to_each_candidate_not_the_collector(self):
        run = run_doc()
        run["collectors"] = [{"runtime": "openclaw"}]
        run["candidates"][0]["automation"] = {"disposition": "review", "reason": "owner_only"}
        run["candidates"].append({**run["candidates"][0], "candidateId": "second", "statement": "Second statement.",
                                  "automation": {"disposition": "shadow", "reason": "insufficient_evidence"}})
        text = reporting.render_report(run)
        collectors, candidates = text.split("## Candidates", 1)
        self.assertNotIn("- policy:", collectors)
        self.assertEqual(candidates.count("- policy:"), 2)
        self.assertIn("policy: review (owner_only)", candidates)
        self.assertIn("policy: shadow (insufficient_evidence)", candidates)

    def test_shadow_report_does_not_overclaim_apply(self):
        text = reporting.render_report(run_doc())
        self.assertIn("This scheduled run made no semantic", text)

    def test_applied_snapshot_distinguishes_scheduled_and_operator_actions(self):
        text = reporting.render_report(run_doc(status="applied"))
        self.assertIn("separately authorized operator apply activity", text)
        self.assertNotIn("This scheduled run made no semantic", text)

    def test_repeated_renders_create_versioned_snapshots_and_latest_pointer(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = reporting.write_report(root, run_doc(updated="2026-08-11T01:02:03Z"))
            second = reporting.write_report(root, run_doc(updated="2026-08-11T01:03:04Z"))
            self.assertNotEqual(first, second)
            self.assertTrue(first.exists())
            self.assertTrue(second.exists())
            latest = (root / "reports" / "latest-report.md").read_text(encoding="utf-8")
            self.assertIn(second.name, latest)


if __name__ == "__main__":
    unittest.main()
