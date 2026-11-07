"""Local attestations never become native cleanup authority, including on faults."""
from copy import deepcopy
from contextlib import redirect_stdout
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_store import load, save
from history_coverage import content_hash
import retention_plan as planner
from retention_dispositions import core_entries
import test_retention_plan as fixtures


class RetentionSafetyTests(unittest.TestCase):
    setUp = fixtures.RetentionPlanTests.setUp
    decision = fixtures.RetentionPlanTests.decision
    result = fixtures.RetentionPlanTests.result
    target = fixtures.RetentionPlanTests.target

    def assert_blocked(self, result):
        self.assertEqual(result["cleanupStatus"], "blocked")
        self.assertEqual(result["counts"]["candidatesForOwnerReview"], 0)
        self.assertFalse(result["executionAllowed"])
        for row in result["messages"]:
            self.assertFalse(row["candidateForOwnerReview"])
            self.assertFalse(row["executionAllowed"])
            self.assertEqual(row["cleanupStatus"], "blocked")
            self.assertTrue(set(planner.NATIVE_GAPS).issubset(row["blockers"]))

    def test_arbitrary_local_verified_claims_never_supply_native_authority(self):
        forged = {"verified": True, "nativeAcceptance": True, "cleanupStatus": "ready",
                  "approval": {"granted": True}, "nativeValidationGaps": []}
        self.qualification.update(deepcopy(forged))
        self.mirror.update(deepcopy(forged))
        self.inventory.update(deepcopy(forged))
        decision = {**self.decision(), **forged}
        result = self.result([decision])
        self.assert_blocked(result)
        self.assertTrue(self.target(result)["reviewProposal"])
        self.assertEqual(result["reviewAttestations"]["analyses"], [decision])
        self.assertEqual(result["inputHashes"]["decisions"], content_hash([decision]))

    def test_restore_counts_and_other_messages_do_not_cover_this_message(self):
        original = deepcopy(self.mirror)
        for sample in (None, {}, {"sampled": 200, "opened": 200, "failures": []},
                       {**original["restoreSample"], "sources": {
                           key: value for key, value in original["restoreSample"]["sources"].items() if key != self.mid}}):
            with self.subTest(sample=sample):
                self.mirror = {**original, "restoreSample": sample}
                result = self.result([self.decision()])
                row = self.target(result)
                self.assertEqual(row["mirrorRestoreObservation"], "missing_or_mismatched")
                self.assertIn("restore_evidence_missing_or_wrong_source", row["reviewBlockers"])
                self.assertFalse(row["reviewProposal"])
                self.assert_blocked(result)

    def test_restore_observation_pins_version_size_path_and_actual_decoding(self):
        original = deepcopy(self.mirror)
        for changes in ({"sha256": "0" * 64}, {"bytes": 0}, {"path": "raw/another.eml"},
                        {"partsDecoded": 0}, {"partsDecoded": True}, {"attachmentsDecoded": True}):
            with self.subTest(changes=changes):
                self.mirror = deepcopy(original)
                self.mirror["restoreSample"]["sources"][self.mid].update(changes)
                row = self.target(self.result([self.decision()]))
                self.assertIn("restore_evidence_missing_or_wrong_source", row["reviewBlockers"])
                self.assertFalse(row["reviewProposal"])

    def test_a_restore_failure_cannot_also_be_a_successful_source(self):
        self.mirror["restoreSample"]["failures"] = [{"messageId": self.mid, "error": "OSError"}]
        row = self.target(self.result([self.decision()]))
        self.assertEqual(row["mirrorRestoreObservation"], "missing_or_mismatched")
        self.assertFalse(row["reviewProposal"])

    def test_malformed_restore_reports_stay_gaps(self):
        original = deepcopy(self.mirror)
        for sample in (True, [], {"sources": [], "failures": []},
                       {"sources": {self.mid: True}, "failures": []},
                       {"sources": {}, "failures": [True]}):
            with self.subTest(sample=sample):
                self.mirror = {**original, "restoreSample": sample}
                row = self.target(self.result([self.decision()]))
                self.assertIn("restore_evidence_missing_or_wrong_source", row["reviewBlockers"])

    def test_even_exact_local_restore_is_observation_only(self):
        result = self.result([self.decision()])
        self.assertEqual(self.target(result)["mirrorRestoreObservation"], "reported")
        self.assert_blocked(result)

    def test_changed_page_receipt_invalidates_analysis_without_rewriting_old_reports(self):
        decision = self.decision()
        old_report = {"schema": "agentx.secretary-retention-plan/v1", "messages": [{"messageId": self.mid}]}
        frozen = Path(self.temp.name) / "old-plan.json"
        save(frozen, old_report)
        original_bytes = frozen.read_bytes()
        packet = self.target(self.result())["reviewPacket"]
        page = next(iter(packet["pageIds"]))
        file = self.root / "page-reviews" / (page + ".json")
        receipt = load(file)
        receipt["summary"] = "Another saved reading receipt version"
        save(file, receipt)
        result = self.result([decision])
        self.assertIn("analysis_receipt_stale_or_wrong_source", self.target(result)["reviewBlockers"])
        self.assertFalse(self.target(result)["reviewProposal"])
        self.assertEqual(frozen.read_bytes(), original_bytes)
        self.assert_blocked(result)

    def test_metadata_change_during_preparation_is_explicit_and_never_promoted(self):
        decision = self.decision()
        original = planner.review_packet
        seen = set()

        def changing(archive, row):
            if row["messageId"] == self.mid and self.mid in seen:
                packet = original(archive, row)
                page = next(iter(packet["pageIds"]))
                file = self.root / "page-reviews" / (page + ".json")
                receipt = load(file)
                receipt["summary"] = "Concurrent reading receipt version"
                save(file, receipt)
            seen.add(row["messageId"])
            return original(archive, row)

        with patch.object(planner, "review_packet", side_effect=changing):
            result = self.result([decision])
        self.assertIn("source_changed_during_preparation", self.target(result)["reviewBlockers"])
        self.assert_blocked(result)

    def test_preparation_never_falls_back_to_provider_or_accepts_a_native_outage(self):
        with patch.object(self.archive, "run", side_effect=AssertionError("No provider access")):
            self.assert_blocked(self.result([self.decision()]))

        def offline(*args, **kwargs):
            raise urllib.error.URLError("Synthetic native Core unavailable")

        with self.assertRaises(urllib.error.URLError):
            core_entries("http://core.invalid", opener=offline)

    def test_cli_keeps_private_analysis_and_disposition_text_in_the_report_only(self):
        directory = Path(self.temp.name)
        output = directory / "private-plan.json"
        analysis = {**self.decision(), "privateExcerpt": "SYNTHETIC_PRIVATE_ANALYSIS_MARKER"}
        disposition = {"messageId": self.mid, "text": "SYNTHETIC_PRIVATE_DISPOSITION_MARKER"}
        argv = ["retention_plan.py", "--root", str(self.root), "--before", self.before.isoformat(),
                "--output", str(output)]
        for name, value in (("inventory", self.inventory), ("primary-proof", self.primary),
                            ("mirror-proof", self.mirror), ("qualification", self.qualification),
                            ("decisions", [analysis]), ("dispositions", [disposition])):
            file = directory / (name + ".json")
            save(file, value)
            argv += ["--" + name, str(file)]
        stdout = io.StringIO()
        with patch.object(sys, "argv", argv), redirect_stdout(stdout):
            planner.main()
        self.assertNotIn("SYNTHETIC_PRIVATE", stdout.getvalue())
        self.assertNotIn(self.mid, stdout.getvalue())
        self.assertNotIn("reviewAttestations", stdout.getvalue())
        report = load(output)
        self.assertEqual(report["reviewAttestations"]["analyses"], [analysis])
        self.assertEqual(report["reviewAttestations"]["ownerDispositions"], [disposition])
        self.assert_blocked(report)


if __name__ == "__main__":
    unittest.main()
