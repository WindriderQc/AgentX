"""Objective consumer regressions: synthetic originals, no provider or inference."""
import copy
import email.message
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_attribution as attribution
import objective_grounding as grounding
import objective_review as worker
from evidence_store import load, save
from objective_sources import _unit, pages
from review_attempts import hashed
import test_objective_review as fixtures
from quote_consumer_fixtures import A, B, CAMP, INVOICES, JULY, OCTOBER, GMAIL, cases, quoted


class ObjectiveQuoteContextTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.objective = self.root / "objective-reviews/life/v2"
        self.manifest = {"attributionContract": attribution.CONTRACT, "objectiveSha256": "a" * 64,
                         "sources": [], "config": {"pageChars": 1000, "overlap": 100}}

    def mail(self, mid, body, *, sender=B, date=OCTOBER):
        mime = email.message.EmailMessage()
        for key, value in {"From": sender, "To": A if sender == B else B, "Date": date,
                           "Message-ID": f"<{mid}@example.invalid>", "Subject": "Synthetic request"}.items():
            mime[key] = value
        mime.set_content(body)
        raw = mime.as_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        path = f"raw/{digest}.eml"
        (self.root / "raw").mkdir(exist_ok=True)
        (self.root / path).write_bytes(raw)
        ref = {"system": "gmail", "id": mid, "threadId": "synthetic-thread", "sha256": digest,
               "path": path, "bytes": len(raw), "labels": ["INBOX"]}
        self.manifest["sources"].append(ref)
        return ref

    def plan(self, ref):
        current, units, _ = worker.materialize(self.root, ref)
        plan = list(pages(current, units, self.manifest["objectiveSha256"], 1000, 100))
        old = copy.deepcopy(plan)
        attribution.bind_pages(self.root, self.objective, self.manifest, current, units, plan)
        for before, after in zip(old, plan):
            self.assertEqual({k: v for k, v in before.items() if k != "sourceContext"},
                             {k: v for k, v in after.items() if k not in ("sourceContext", "attributionEvidenceSha256")})
        return plan

    def quote(self, page, text):
        return attribution.project(self.objective, worker._source_record(page),
                                   {"moments": [{"quotes": [text]}]})["moments"][0][0]

    def test_shared_corpus_retains_author_claims_spans_boundaries_and_original_bytes(self):
        for name, body, text, claimed, relation in cases():
            with self.subTest(name=name):
                self.manifest["sources"] = []
                ref = self.mail("case" + str(len(body)), body)
                raw = (self.root / ref["path"]).read_bytes()
                page = next(p for p in self.plan(ref) if text in p["content"])
                context = page["sourceContext"]
                self.assertEqual(context["schema"], "secretary.source-context/v2")
                found = self.quote(page, text)
                self.assertEqual((found["state"], found.get("claimedAuthor")), (relation, claimed))
                self.assertIsNone(found.get("author"))
                self.assertIsNone(found.get("date"))
                self.assertTrue(found["requiresReconciliation"])
                self.assertEqual((self.root / ref["path"]).read_bytes(), raw)
                if name == "continuation":
                    self.assertGreater(page["offset"], 0)
                    self.assertTrue(context["segments"][0]["startsBeforePage"])
                    self.assertIn("boundary", context)
                self.assertTrue(found["sourceSpans"])
                record = worker._source_record(page)
                new_context = grounding.extraction_context(record, self.manifest)
                self.assertIsNone(new_context.get("mailDate"))
                import objective_date_evidence
                dates = objective_date_evidence.catalog(grounding.catalog(page["content"]), new_context)
                self.assertFalse(any(d["id"] == "m0" for d in dates))

    def test_later_replies_and_repeat_occurrences_share_original_without_resolution(self):
        for text in (CAMP, INVOICES):
            with self.subTest(text=text):
                self.manifest["sources"] = []
                original = self.mail("original", text, sender=A, date=JULY)
                copy = self.mail("copy", "October reply.\n" + GMAIL + quoted(text + "\n" + text))
                later = self.mail("later", "Already discussed; details still need review.", date="Mon, 12 Oct 2026 12:00:00 +0000")
                # Each iteration uses its own objective evidence directory.
                self.objective = self.objective.parent / hashlib.sha256(text.encode()).hexdigest()
                own = self.quote(self.plan(original)[0], text)
                repeated = self.quote(self.plan(copy)[0], text)
                self.assertEqual(repeated["state"], "matched-original")
                self.assertEqual((repeated["author"], repeated["date"]), (A, JULY))
                self.assertEqual(repeated["assertionKey"], own["assertionKey"])
                self.assertEqual(len(repeated["sourceSpans"]), 2)
                self.assertIn(later["id"], repeated["laterMessageIds"])
                self.assertIn(copy["id"], own["laterMessageIds"])
                self.assertNotIn("resolved", repeated)
                self.assertNotIn("obligation", repeated)

    def test_frozen_context_survives_missing_peer_and_tampering_is_rejected(self):
        first = self.mail("original", CAMP, sender=A, date=JULY)
        ref = self.mail("copy", GMAIL + quoted(CAMP))
        page = self.plan(ref)[0]
        before = copy.deepcopy(page)
        (self.root / first["path"]).unlink()
        self.assertEqual(self.plan(ref)[0], before)
        evidence = self.objective / "attribution-evidence" / (page["attributionEvidenceSha256"] + ".json")
        changed = load(evidence)
        changed["own"]["headers"]["from"] = "Invented"
        save(evidence, changed)
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.quote(page, CAMP)

    def test_repeated_unmatched_quotes_and_multiple_originals_remain_unresolved(self):
        first = self.mail("copy-one", GMAIL + quoted(INVOICES))
        second = self.mail("copy-two", GMAIL + quoted(INVOICES), date="Mon, 12 Oct 2026 12:00:00 +0000")
        one, two = self.quote(self.plan(first)[0], INVOICES), self.quote(self.plan(second)[0], INVOICES)
        self.assertEqual(one["state"], "quoted")
        self.assertEqual(one["assertionKey"], two["assertionKey"])
        self.objective = self.objective.parent / "ambiguous"
        self.mail("original-one", INVOICES, sender=A, date=JULY)
        self.mail("original-two", INVOICES, sender=A, date="Fri, 17 Jul 2026 20:00:00 +0000")
        found = self.quote(self.plan(second)[0], INVOICES)
        self.assertEqual((found["state"], found["reason"]), ("quoted", "several-earlier-originals"))
        self.assertIsNone(found["author"])
        self.assertIsNone(found["date"])

    def test_drafts_do_not_verify_old_quotes_and_new_sources_do_not_extend_the_frozen_scope(self):
        original = self.mail("draft", CAMP, sender=A, date=JULY)
        original["labels"] = ["DRAFT"]
        ref = self.mail("copy", GMAIL + quoted(CAMP))
        page = self.plan(ref)[0]
        self.assertEqual(self.quote(page, CAMP)["state"], "quoted")
        future = self.mail("unselected", "A later answer.", date="Mon, 12 Oct 2026 12:00:00 +0000")
        self.manifest["sources"].remove(future)
        self.assertEqual(self.plan(ref)[0], page)
        self.assertNotIn("unselected", self.quote(page, CAMP).get("laterMessageIds", []))

    def test_attachment_context_cannot_inherit_the_container_author(self):
        source = {"system": "gmail", "id": "attachment", "threadId": "t", "sha256": "f" * 64,
                  "headers": {"from": B, "date": OCTOBER}, "direction": "received"}
        unit = _unit("attachment-existing-text", INVOICES)
        plan = list(pages(source, [unit], "a" * 64))
        attribution.bind_pages(self.root, self.objective, self.manifest, source, [unit], plan)
        self.assertEqual(self.quote(plan[0], INVOICES)["state"], "attachment")
        self.assertIsNone(plan[0]["sourceContext"]["segments"][0]["author"])


class ObjectiveFrozenContractTests(unittest.TestCase):
    setUp = fixtures.ObjectiveTests.setUp
    mail = fixtures.ObjectiveTests.mail
    prepare = fixtures.ObjectiveTests.prepare
    run_worker = fixtures.ObjectiveTests.run_worker

    def make_legacy(self):
        config = worker.config_at(self.file)
        base = worker.INSTRUCTIONS + "\n\nPrivate owner instructions:\n" + config["instructions"]
        legacy = {"schema": worker.CONTRACT, "config": config, "createdAt": "2026-11-01T00:00:00Z",
                  "sources": worker.inventory(self.root, config["selection"]), "systemSha256": hashed(base),
                  "responseSchemaSha256": hashed(worker.SCHEMA)}
        legacy["objectiveSha256"] = hashed({"contract": worker.CONTRACT, "config": config, "system": base, "schema": worker.SCHEMA})
        objective = self.root / "objective-reviews/life/v1"
        save(objective / "manifest.json", legacy)
        return objective, legacy

    def test_legacy_manifest_pages_receipts_and_attempts_remain_byte_identical_without_rereading(self):
        objective, manifest = self.make_legacy()
        self.assertEqual(self.prepare()[1], manifest)
        client = fixtures.Client()
        self.assertEqual(self.run_worker(client)["newlyReviewedPages"], 1)
        frozen = {f: f.read_bytes() for d in ("page-reviews", "review-attempts") for f in (objective / d).rglob("*") if f.is_file()}
        self.assertNotIn("attributionContract", self.prepare()[1])
        self.assertEqual(self.run_worker(client)["inferenceCalls"], 0)
        for file, data in frozen.items():
            self.assertEqual(file.read_bytes(), data)
        self.assertEqual(len(client.calls), 1)
        row = worker.read_receipt(next((objective / "page-reviews").glob("*.json")), manifest)
        self.assertNotIn("quoteAttribution", row)
        self.assertFalse((objective / "attribution-evidence").exists())

    def test_new_version_has_explicit_contract_and_a_distinct_intent(self):
        _, old = self.make_legacy()
        self.config["version"] = "v2"
        save(self.file, self.config)
        objective, new = self.prepare()
        self.assertEqual(new["attributionContract"], attribution.CONTRACT)
        self.assertNotEqual(new["objectiveSha256"], old["objectiveSha256"])
        self.assertEqual(self.run_worker(fixtures.Client())["newlyReviewedPages"], 1)
        row = worker.read_receipt(next((objective / "page-reviews").glob("*.json")), new)
        self.assertEqual(row["quoteAttribution"]["schema"], attribution.CONTRACT)
        self.assertEqual(load(objective / "findings.json")[0]["quoteAttribution"]["schema"], attribution.CONTRACT)
        changed = copy.deepcopy(row)
        changed["quoteAttribution"]["moments"][0][0]["author"] = "Invented"
        file = objective / "page-reviews" / (row["pageId"] + ".json")
        save(file, changed)
        with self.assertRaisesRegex(ValueError, "attribution"):
            worker.read_receipt(file, new)

    def test_uncertain_legacy_intent_is_not_upgraded_or_called_again(self):
        objective, manifest = self.make_legacy()
        client = fixtures.Client(fail=True)
        self.assertEqual(self.run_worker(client)["phase"], "uncertain")
        attempts = {f: f.read_bytes() for f in (objective / "review-attempts").rglob("*") if f.is_file()}
        client.fail = False
        self.assertEqual(self.run_worker(client)["phase"], "uncertain")
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(load(objective / "manifest.json"), manifest)
        for file, data in attempts.items():
            self.assertEqual(file.read_bytes(), data)


if __name__ == "__main__":
    unittest.main()
