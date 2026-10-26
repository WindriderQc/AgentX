import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_store import save
from objective_annual import aggregate, project, FIELDS, _year
from objective_status import projection
import objective_review


class AnnualCoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.entries = []

    def add(self, system="gmail", date="Sat, 31 Dec 2005 23:30:00 -0500", *, reviewed=False, covered=False,
            rejected=False, gaps=False, available=True, metadata_match=True):
        mid = "message" + str(len(self.entries)).zfill(3)
        source = {"system": system, "id": mid, "threadId": "thread001", "sha256": str(len(self.entries)) * 64,
                  "path": "raw/" + mid, "bytes": 4, "sourceDate": "946684800000" if system == "gmail" else date}
        if available:
            file = self.root / source["path"]
            file.parent.mkdir(exist_ok=True)
            file.write_text("mail")
        save(self.root / "raw-receipts" / (mid + ".json"), {"messageId": mid, "threadId": source["threadId"],
             "sha256": source["sha256"] if metadata_match else "bad", "path": source["path"]})
        thread = self.root / "threads/thread001/manifest.json"
        manifest = json.loads(thread.read_text()) if thread.exists() else {"threadId": "thread001", "messages": []}
        manifest["messages"].append({"id": mid, "headers": {"Date": date, "Subject": "PRIVATE SUBJECT"}})
        save(thread, manifest)
        row = {"textReviewComplete": reviewed, "textCovered": covered, "rejectedPages": int(rejected),
               "gaps": [{"code": "synthetic-gap"}] if gaps else [], "error": None}
        self.entries.append((source, {}, row))
        return self.entries[-1]

    def aggregate(self):
        return aggregate(self.root, {"sources": [x[0] for x in self.entries]}, self.entries)

    def test_native_header_year_and_unknowns_preserve_every_physical_target(self):
        self.add(reviewed=True, covered=True)
        self.add("outlook-export", "2006-02-03T00:00:00Z", covered=True, rejected=True, gaps=True)
        self.add(date="not a date", rejected=True)
        self.add(date=None, available=False)
        self.add(date="Wed, 1 Jan 1997 00:00:00 +0000", metadata_match=False)
        annual = self.aggregate()
        self.assertEqual([row["year"] for row in annual["years"]], [2005, 2006])
        self.assertEqual(annual["unknown"]["totals"]["targetedSources"], 3)
        total = annual["totals"]
        self.assertEqual(total["targetedSources"], 5)
        self.assertEqual(total["availableSources"], 4)
        self.assertEqual(total["reviewedSources"], 1)
        self.assertEqual(total["coveredSources"], 2)
        self.assertEqual(total["rejectedSources"], 2)
        self.assertEqual(annual["metadata"], {"missingDates": 1, "invalidDates": 1, "identityMismatches": 1, "unavailableFiles": 1})
        self.assertEqual(project(annual), annual)
        self.assertNotIn("PRIVATE", json.dumps(project(annual)))
        for field in FIELDS:
            self.assertEqual(sum(row["totals"][field] for row in [*annual["years"], annual["unknown"]]), total[field])
            self.assertEqual(sum(annual["bySystem"][s][field] for s in annual["bySystem"]), total[field])

    def test_provider_timestamp_and_filesystem_time_never_supply_a_mail_year(self):
        source, _, _ = self.add(date=None)
        annual = self.aggregate()
        self.assertEqual(annual["years"], [])
        self.assertEqual(annual["unknown"]["totals"]["targetedSources"], 1)
        self.assertEqual(source["sourceDate"], "946684800000")
        self.assertEqual(_year("946684800000"), (None, "invalidDates"))
        self.assertEqual(_year("Fri, 31 Feb 2020 00:00:00 +0000"), (None, "invalidDates"))

    def test_original_metadata_identity_must_match_before_using_materialized_date(self):
        source, plan, _ = self.add(date="invalid")
        plan["source"] = {**source, "mailDate": "2012-01-01T00:00:00Z"}
        self.assertEqual(self.aggregate()["years"][0]["year"], 2012)
        plan["source"]["sha256"] = "wrong"
        annual = self.aggregate()
        self.assertEqual(annual["unknown"]["totals"]["targetedSources"], 1)
        self.assertEqual(annual["metadata"]["identityMismatches"], 1)

    def test_copies_are_separate_targets_and_sizes_do_not_attest_integrity(self):
        a = self.add(reviewed=True, covered=True)
        self.add(reviewed=False, covered=True)
        (self.root / a[0]["path"]).write_text("xxxx")  # Same size: availability, no hash qualification.
        annual = self.aggregate()
        self.assertEqual(annual["years"][0]["totals"]["targetedSources"], 2)
        self.assertEqual(annual["totals"]["availableSources"], 2)
        self.assertEqual(annual["availabilityBasis"], "presence-and-size-only")

    def test_closed_projection_drops_content_and_refuses_inconsistent_or_unbounded_data(self):
        self.add()
        annual = self.aggregate()
        dirty = copy.deepcopy(annual)
        dirty.update(prompt="PRIVATE", sourceIds=["PRIVATE"])
        dirty["years"][0]["body"] = "PRIVATE"
        self.assertNotIn("PRIVATE", json.dumps(project(dirty)))
        for change in [lambda x: x["years"].append(copy.deepcopy(x["years"][0])),
                       lambda x: x["totals"].update(coveredSources=100),
                       lambda x: x["bySystem"]["gmail"].update(targetedSources=2),
                       lambda x: x["unknown"]["totals"].update(targetedSources=True)]:
            invalid = copy.deepcopy(annual)
            change(invalid)
            self.assertIsNone(project(invalid))

    def test_existing_native_status_relays_only_the_aggregate_without_reopening_sources(self):
        self.add()
        annual = self.aggregate()
        obj = self.root / "objective-reviews/life/v1"
        save(obj / "coverage.json", {"objectiveId": "life", "version": "v1", "counts": {}, "annualCoverage": annual})
        (self.root / self.entries[0][0]["path"]).unlink()
        value = projection(self.root)["objectiveReviews"][0]["annualCoverage"]
        self.assertEqual(value["totals"]["availableSources"], 1)  # Snapshot, no hidden rescan in GET.
        self.assertNotIn("message000", json.dumps(value))

    def test_canonical_export_builds_the_year_snapshot_without_model_or_body_reads(self):
        source, _, _ = self.add()
        obj = self.root / "objective-reviews/life/v1"
        manifest = {"config": {"id": "life", "version": "v1"}, "objectiveSha256": "a" * 64, "sources": [source]}
        report = objective_review.export(obj, manifest)
        self.assertEqual(report["annualCoverage"]["years"][0]["year"], 2005)
        self.assertEqual(report["annualCoverage"]["totals"]["targetedSources"], report["counts"]["targetSources"])
        self.assertEqual(projection(self.root)["objectiveReviews"][0]["annualCoverage"], report["annualCoverage"])


if __name__ == "__main__":
    unittest.main()
