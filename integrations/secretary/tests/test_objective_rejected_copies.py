import copy
import email
from email import policy
import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_store import load, save
import objective_review as worker
import objective_rejected_copies as copies
import test_objective_review as fixtures
import test_objective_dispositions as rejected_fixtures


class RejectedCopyTests(unittest.TestCase):
    setUp = fixtures.ObjectiveTests.setUp
    mail = fixtures.ObjectiveTests.mail
    prepare = fixtures.ObjectiveTests.prepare
    run_worker = fixtures.ObjectiveTests.run_worker
    client = rejected_fixtures.DispositionTests.client

    def duplicate_sources(self, count=2, body="Un fichier.pdf est envoyé."):
        original = self.mail("message01", body)
        raw = (self.root / original["path"]).read_bytes()
        mids = ["message01"]
        for index in range(2, count + 1):
            mid = f"message{index:02d}"
            data = b"X-Synthetic-Copy: " + str(index).encode() + b"\n" + raw
            digest = hashlib.sha256(data).hexdigest()
            relative = "raw/" + digest + ".eml"
            (self.root / relative).write_bytes(data)
            save(self.root / "raw-receipts" / (mid + ".json"), {
                **original, "messageId": mid, "path": relative, "sha256": digest, "bytes": len(data)})
            mids.append(mid)
        self.config["selection"]["gmailMessageIds"] = mids
        save(self.file, self.config)

    def change_source(self, mid, *, header=None, value=None, text=None, draft=False):
        receipt_file = self.root / "raw-receipts" / (mid + ".json")
        record = load(receipt_file)
        message = email.message_from_bytes((self.root / record["path"]).read_bytes(), policy=policy.default)
        if header:
            del message[header]
            if value is not None:
                message[header] = value
        if text is not None:
            message.set_content(text)
        raw = message.as_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        relative = "raw/" + digest + ".eml"
        (self.root / relative).write_bytes(raw)
        save(receipt_file, {**record, "path": relative, "sha256": digest, "bytes": len(raw),
                            "labelIds": ["DRAFT"] if draft else record["labelIds"]})

    def target(self):
        objective, manifest = self.prepare()
        source = next(s for s in manifest["sources"] if s["id"] == "message02")
        current, units, gaps = worker.materialize(self.root, source)
        plan = list(worker.pages(current, units, manifest["objectiveSha256"],
                                 manifest["config"]["pageChars"], manifest["config"]["overlap"]))
        save(objective / "sources" / (worker.source_key(source) + ".json"), {
            "source": current, "pageIds": [p["pageId"] for p in plan], "gaps": gaps,
            "representations": [worker.equivalent.unit_ref(u) for u in units]})
        return objective, manifest, current, units[0], plan

    def first_rejected(self, **kwargs):
        client, calls = self.client()
        result = self.run_worker(client, retain_rejected_pages=True, max_pages=1, **kwargs)
        self.assertEqual(result["newlyRejectedPages"], 1)
        self.assertEqual(len(calls), 1)
        return client, calls

    def test_exact_copies_are_reports_not_reads_rejections_aliases_or_facts(self):
        self.duplicate_sources(5)
        client, calls = self.client()
        result = self.run_worker(client, retain_rejected_pages=True)
        counts = result["coverage"]["counts"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["inferenceCalls"], 1)
        self.assertEqual(result["newlyRejectedPages"], 1)
        self.assertEqual(result["newlyDeferredRejectedCopyPages"], 4)
        self.assertEqual(result["processedPages"], 5)
        self.assertEqual(counts["rejectedPages"], 1)
        self.assertEqual(counts["sourcesWithRejectedPages"], 1)
        self.assertEqual(counts["deferredRejectedCopyPages"], 4)
        self.assertEqual(counts["sourcesWithDeferredRejectedCopies"], 4)
        for field in ("sourcesTextReviewed", "sourcesTextCovered", "reviewedPages", "equivalentPages", "pendingPagesKnown", "extractedMoments"):
            self.assertEqual(counts.get(field, 0), 0, field)
        self.assertEqual(counts["sourcesWithGaps"], 5)
        self.assertFalse(result["coverage"]["allTargetTextCovered"])
        objective, manifest = self.prepare()
        self.assertEqual(load(objective / "findings.json"), [])
        self.assertEqual(load(objective / "sources.json"), [])
        self.assertFalse((objective / "equivalences").exists())
        annual = result["coverage"]["annualCoverage"]["totals"]
        self.assertEqual(annual["reviewedSources"], 0)
        self.assertEqual(annual["coveredSources"], 0)
        self.assertEqual(annual["rejectedSources"], 1)
        self.assertEqual(annual["gapSources"], 5)
        before = {str(f.relative_to(objective)): f.read_bytes() for directory in
                  ("review-attempts", "page-dispositions", "rejected-copy-reports")
                  for f in (objective / directory).rglob("*") if f.is_file()}
        resumed = self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(resumed["processedPages"], 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(before, {name: (objective / name).read_bytes() for name in before})
        for row in copies.receipts(objective, manifest):
            self.assertFalse(row["modelRead"])
            self.assertFalse(row["textCovered"])
            self.assertFalse(row["rejectedOutput"])
            self.assertNotIn("result", row)
            self.assertNotIn("quotes", row)

    def test_reports_and_actual_reviews_share_the_bounded_budget(self):
        self.duplicate_sources(5)
        client, calls = self.client()
        first = self.run_worker(client, retain_rejected_pages=True, max_pages=3)
        self.assertEqual(first["processedPages"], 3)
        self.assertEqual(first["newlyRejectedPages"], 1)
        self.assertEqual(first["newlyDeferredRejectedCopyPages"], 2)
        second = self.run_worker(client, retain_rejected_pages=True, max_pages=1)
        self.assertEqual(second["processedPages"], 1)
        self.assertEqual(second["newlyDeferredRejectedCopyPages"], 1)
        self.assertEqual(second["inferenceCalls"], 0)
        self.assertEqual(len(calls), 1)

    def test_known_rejection_wins_over_a_new_alias_to_another_accepted_copy(self):
        self.duplicate_sources(3)
        def third_accepted(prompt, reply):
            if prompt["source"]["id"] == "message03":
                import json
                value = json.loads(reply["response"])
                value["moments"][0]["quotes"] = ["Un fichier.pdf est envoyé."]
                reply["response"] = json.dumps(value)
            return reply
        client, calls = self.client(third_accepted)
        self.run_worker(client, retain_rejected_pages=True, max_pages=1)
        # A historical accepted copy is allowed to remain. It cannot lend its
        # result to the as-yet-unvisited second copy of a known rejected unit.
        self.run_worker(client, priority=("gmail:message03",), max_pages=1)
        result = self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(len(calls), 2)
        self.assertEqual(result["coverage"]["counts"]["reviewedPages"], 1)
        self.assertEqual(result["coverage"]["counts"]["sourcesTextCovered"], 1)
        self.assertEqual(result["coverage"]["counts"]["deferredRejectedCopyPages"], 1)
        objective, _ = self.prepare()
        self.assertEqual(list((objective / "equivalences").glob("*.json")), [])

    def test_date_author_subject_recipients_rfc_draft_or_exact_text_change_cannot_defer(self):
        variations = [
            {"header": "Date", "value": "Sat, 2 Aug 2014 10:00:00 +0000"},
            {"header": "From", "value": "Other <other@example.test>"},
            {"header": "Subject", "value": "Another subject"},
            {"header": "To", "value": "Other <other@example.test>"},
            {"header": "Message-ID", "value": "<different@example.test>"},
            {"header": "Message-ID", "value": None},
            {"text": "Un  fichier.pdf est envoyé."},
            {"draft": True},
        ]
        for variation in variations:
            with self.subTest(variation=variation):
                self.setUp()
                self.duplicate_sources()
                self.change_source("message02", **variation)
                client, calls = self.client()
                result = self.run_worker(client, retain_rejected_pages=True)
                self.assertEqual(len(calls), 2)
                self.assertEqual(result["coverage"]["counts"]["deferredRejectedCopyPages"], 0)

    def test_partial_canonical_unit_is_not_registered_and_reports_count_per_source(self):
        self.duplicate_sources(body=("Un fichier.pdf est envoyé. " * 60))
        self.config.update(pageChars=1000, overlap=100)
        save(self.file, self.config)
        client, calls = self.first_rejected()
        objective, _ = self.prepare()
        self.assertFalse((objective / "rejected-copy-index").exists())
        # Both sources are completed a page at a time. No unit proof exists
        # until every canonical page has a certain terminal rejection.
        completed = self.run_worker(client, retain_rejected_pages=True, max_pages=10, per_source_pages=1)
        self.assertEqual(completed["newlyDeferredRejectedCopyPages"], 1)
        self.assertEqual(completed["newlyRejectedPages"], 1)
        self.assertEqual(completed["processedPages"], 2)
        self.assertEqual(len(calls), 2)
        self.assertGreater(completed["coverage"]["counts"]["pendingPagesKnown"], 0)

    def test_target_owned_invalid_cache_keeps_its_native_path(self):
        self.duplicate_sources()
        client, calls = self.first_rejected()
        legacy = self.run_worker(client, priority=("gmail:message02",), max_pages=1)
        self.assertEqual(legacy["phase"], "validation-error")
        self.assertEqual(len(calls), 2)
        result = self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(result["inferenceCalls"], 0)
        self.assertEqual(result["newlyRejectedPages"], 1)
        self.assertEqual(result["newlyDeferredRejectedCopyPages"], 0)
        self.assertEqual(result["coverage"]["counts"]["rejectedPages"], 2)

    def test_target_owned_uncertain_attempt_blocks_and_is_not_bypassed(self):
        self.duplicate_sources()
        self.first_rejected()
        client = fixtures.Client(fail=True)
        self.assertEqual(self.run_worker(client, priority=("gmail:message02",), max_pages=1)["phase"], "uncertain")
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)["phase"], "uncertain")
        self.assertEqual(len(client.calls), 1)
        objective, _ = self.prepare()
        self.assertFalse((objective / "rejected-copy-reports").exists())

    def test_original_target_fence_blocks_a_report_even_before_linked_child_starts(self):
        self.duplicate_sources()
        self.first_rejected()
        objective, manifest, source, unit, plan = self.target()
        # A parent's native recovery identity exists even while the selected
        # child attempt directory has not yet been created.
        parent = objective / "review-attempts" / worker.hashed(plan[0]["pageId"])
        save(parent / "retry-plan.json", {"retained": "native parent fence"})
        self.assertIsNone(copies.defer(objective, manifest, source, unit, plan, plan[0]))
        self.assertFalse((objective / "rejected-copy-reports").exists())

    def test_saved_report_conflicting_with_attempt_review_or_rejection_blocks(self):
        for directory in ("review-attempts", "page-reviews", "page-dispositions"):
            with self.subTest(directory=directory):
                self.setUp()
                self.duplicate_sources()
                client, _ = self.client()
                self.run_worker(client, retain_rejected_pages=True)
                objective, manifest = self.prepare()
                report = next(copies.receipts(objective, manifest))
                if directory == "review-attempts":
                    worker.result_file(objective, report["pageId"]).parent.mkdir(parents=True)
                else:
                    save(objective / directory / (report["pageId"] + ".json"), {})
                with self.assertRaisesRegex(copies.RejectedCopyIntegrityError, "conflict"):
                    worker.coverage(objective, manifest)
                with self.assertRaises(copies.RejectedCopyIntegrityError):
                    self.run_worker(client, retain_rejected_pages=True)

    def test_report_policy_cannot_be_implicitly_disabled(self):
        self.duplicate_sources()
        client, calls = self.client()
        self.run_worker(client, retain_rejected_pages=True)
        with self.assertRaisesRegex(ValueError, "explicit review-only"):
            self.run_worker(client)
        self.assertEqual(len(calls), 1)

    def test_tampered_canonical_bytes_index_or_target_report_fail_closed(self):
        self.duplicate_sources()
        client, _ = self.client()
        self.run_worker(client, retain_rejected_pages=True)
        objective, manifest = self.prepare()
        paths = [next((objective / "rejected-copy-index").glob("*.json")),
                 next((objective / "rejected-copy-reports").glob("*.json")),
                 next((objective / "page-dispositions").glob("*.json")),
                 next((objective / "review-attempts").glob("*/response-1-http.txt"))]
        for path in paths:
            before = path.read_bytes()
            path.write_bytes(before + b" ")
            # A report's own JSON is content-checked; formatting alone is not a
            # new identity, while canonical byte references are sealed exactly.
            if "rejected-copy-reports" in str(path):
                changed = load(path); changed["textCovered"] = True; save(path, changed)
            with self.assertRaises((copies.RejectedCopyIntegrityError, worker.dispositions.DispositionIntegrityError)):
                self.run_worker(client, retain_rejected_pages=True)
            path.write_bytes(before)
        self.assertEqual(len(list(copies.receipts(objective, manifest))), 1)

    def test_target_offsets_partial_plan_and_representation_scope_must_match(self):
        self.duplicate_sources()
        self.first_rejected()
        objective, manifest, source, unit, plan = self.target()
        partial = copy.deepcopy(plan)
        partial[0]["end"] -= 1
        with self.assertRaisesRegex(copies.RejectedCopyIntegrityError, "complete current plan"):
            copies.defer(objective, manifest, source, unit, partial, partial[0])
        other = {**unit, "mimeType": "text/html"}
        other_plan = copies._plan(source, other, manifest)
        self.assertIsNone(copies.defer(objective, manifest, source, other, other_plan, other_plan[0]))
        self.assertIsNotNone(copies.defer(objective, manifest, source, unit, plan, plan[0]))

    def test_same_text_cannot_borrow_a_different_objectives_rejection(self):
        self.duplicate_sources()
        self.first_rejected()
        objective, manifest, source, unit, _ = self.target()
        different = {**manifest, "objectiveSha256": "f" * 64}
        other_plan = copies._plan(source, unit, different)
        self.assertIsNone(copies.defer(objective, different, source, unit, other_plan, other_plan[0]))

    def test_an_empty_existing_index_cannot_be_treated_as_a_missing_cache(self):
        self.duplicate_sources()
        self.first_rejected()
        objective, manifest, source, unit, plan = self.target()
        file = next((objective / "rejected-copy-index").glob("*.json"))
        save(file, {})
        with self.assertRaisesRegex(copies.RejectedCopyIntegrityError, "empty or malformed"):
            copies.defer(objective, manifest, source, unit, plan, plan[0])
        self.assertFalse((objective / "rejected-copy-reports").exists())


if __name__ == "__main__":
    unittest.main()
