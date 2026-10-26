import copy
import email.message
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_store import load, save
import objective_review as worker
from objective_schema import validate
from objective_sources import inventory, materialize, pages
import objective_equivalence as equivalent

QUEUE = "11111111-1111-4111-8111-111111111111"
DISPATCH = "22222222-2222-4222-8222-222222222222"


def moment(quote):
    return {"title": "Un déménagement annoncé", "description": "La personne décrit son déménagement.",
        "category": "home", "startDate": "2014-08", "endDate": None, "startPrecision": "month", "endPrecision": "unknown",
        "ongoing": False, "originalDate": "août 2014", "subject": "owner", "subjectName": "Personne fictive",
        "occurrenceStatus": "reported", "claimType": "direct", "uncertainty": "Jour non précisé.",
        "rationale": "Déclaration explicite datée.", "quotes": [quote], "relationHints": []}


class Client:
    base, task_type = "http://core.test", "mail_review"

    def __init__(self, fail=False, invalid=False, deny=False):
        self.calls, self.assertions = [], []
        self.fail, self.invalid, self.deny = fail, invalid, deny

    def _call(self, method, path, body):
        self.assertions.append((method, path, body))
        if self.deny:
            raise RuntimeError("dispatch refused")
        return 200, {"status": "success"}, {}

    def busy(self):
        return None

    def extract(self, system, prompt, light=False, request_id=None):
        self.calls.append(request_id)
        if self.fail:
            raise TimeoutError("uncertain transport")
        passage = json.loads(prompt)["untrustedContent"]
        found = "Mon déménagement" in passage
        return {"summary": "Ce passage contient une déclaration de déménagement." if found else "Aucun fait de vie personnel dans ce passage.",
                "classification": "life-events" if found else "no-life-event", "gaps": [],
                "moments": [moment("absent" if self.invalid else "Mon déménagement est terminé en août 2014.")] if found else []}


class ObjectiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {"id": "life", "version": "v1", "kind": "life-timeline", "ownerAliases": ["Personne fictive"],
                       "selection": {"gmailMessageIds": ["message01"], "outlookSha256": []}}
        self.file = self.root / "objective.json"
        save(self.file, self.config)
        self.message = self.mail("message01", "Mon déménagement est terminé en août 2014.")
        save(self.root / "page-reviews/general.json", {"unrelated": "preserve"})

    def mail(self, mid, body, html=None, outlook=False):
        message = email.message.EmailMessage()
        message["From"] = "Personne fictive <owner@example.test>"
        message["To"] = "Ami fictif <friend@example.test>"
        message["Date"] = "Fri, 1 Aug 2014 10:00:00 +0000"
        message["Message-ID"] = "<" + mid + "@example.test>"
        message["Subject"] = "Nouvelles fictives"
        message.set_content(body)
        if html:
            message.add_alternative(html, subtype="html")
        raw = message.as_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        relative = "raw/" + digest + ".eml"
        (self.root / "raw").mkdir(exist_ok=True)
        (self.root / relative).write_bytes(raw)
        row = {"messageId": mid, "threadId": "thread001", "sha256": digest, "path": relative,
               "bytes": len(raw), "internalDate": "1406887200000", "labelIds": ["SENT"]}
        if outlook:
            save(self.root / "outlook/inventory.json", {"items": {digest: {"sha256": digest, "kind": "mail", "path": relative,
                "bytes": len(raw), "messageId": str(message["Message-ID"]), "date": str(message["Date"]), "alsoInGmail": [mid]}}})
        else:
            save(self.root / "raw-receipts" / (mid + ".json"), row)
        return row

    def prepare(self):
        return worker.prepare(self.root, worker.config_at(self.file))

    def run_worker(self, client, **kwargs):
        objective, manifest = self.prepare()
        return worker.run(self.root, objective, manifest, client, max_pages=kwargs.pop("max_pages", 20),
                          queue_id=QUEUE, dispatch_id=DISPATCH, **kwargs)

    def test_version_has_immutable_config_and_source_snapshot(self):
        objective, manifest = self.prepare()
        self.mail("message02", "Une autre source arrivée plus tard.")
        self.assertEqual(len(self.prepare()[1]["sources"]), 1)
        self.config["ownerAliases"].append("Autre alias")
        save(self.file, self.config)
        with self.assertRaisesRegex(ValueError, "another intent"):
            self.prepare()
        self.config["version"] = "v2"
        save(self.file, self.config)
        self.assertNotEqual(objective, self.prepare()[0])

    def test_old_general_receipts_are_preserved_and_do_not_skip_objective(self):
        client = Client()
        result = self.run_worker(client)
        self.assertEqual(result["phase"], "done")
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(load(self.root / "page-reviews/general.json"), {"unrelated": "preserve"})
        self.assertEqual(self.run_worker(client)["newlyReviewedPages"], 0)
        self.assertEqual(len(client.calls), 1)

    def test_exact_quote_candidates_keep_native_identity_and_never_confirm(self):
        self.run_worker(Client())
        objective, _ = self.prepare()
        finding = load(objective / "findings.json")[0]
        record = load(objective / "sources.json")[0]
        self.assertEqual(finding["reviewState"], "candidate")
        self.assertFalse(finding["userConfirmed"])
        self.assertEqual(record["nativeRef"]["sourceSha256"], self.message["sha256"])
        self.assertEqual(record["bodySha256"], hashlib.sha256(record["body"].encode()).hexdigest())
        self.assertTrue(all(c["quote"] in record["body"] for c in finding["claimsWithExactQuotes"]))

    def test_invalid_quote_does_not_become_read_receipt_or_retry(self):
        client = Client(invalid=True)
        self.assertEqual(self.run_worker(client)["phase"], "validation-error")
        self.assertEqual(self.run_worker(client)["phase"], "validation-error")
        self.assertEqual(len(client.calls), 1)
        objective, _ = self.prepare()
        self.assertEqual(load(objective / "findings.json"), [])

    def test_lost_result_blocks_replacement(self):
        client = Client(fail=True)
        self.assertEqual(self.run_worker(client)["phase"], "uncertain")
        self.assertEqual(self.run_worker(client)["phase"], "uncertain")
        self.assertEqual(len(client.calls), 1)

    def test_native_queue_assertion_is_required_before_inference(self):
        client = Client(deny=True)
        with self.assertRaisesRegex(RuntimeError, "dispatch refused"):
            self.run_worker(client)
        self.assertFalse(client.calls)
        self.assertTrue(client.assertions)
        objective, manifest = self.prepare()
        with self.assertRaises(ValueError):
            worker.run(self.root, objective, manifest, client, max_pages=1, queue_id="", dispatch_id=DISPATCH)

    def test_every_mime_text_representation_and_html_supplement_is_separate(self):
        self.mail("message01", "Texte fictif.", '<p>Autre version fictive.</p><img alt="Une image décrite" src="https://example.test/no-fetch">')
        source = inventory(self.root, self.config["selection"])[0]
        current, units, gaps = materialize(self.root, source)
        self.assertEqual(sum(u["representation"] == "mime-text" for u in units), 2)
        supplement = next(u for u in units if u["representation"] == "html-inert-supplement")
        self.assertIn("Une image décrite", supplement["content"])
        self.assertFalse(json.loads(supplement["content"])["contentFetched"])
        self.assertEqual(gaps, [])

    def test_outlook_conversion_is_not_an_independent_gmail_testimony(self):
        self.mail("message01", "Source fictive.", outlook=True)
        rows = inventory(self.root)
        self.assertEqual(len(rows), 2)
        outlook = next(r for r in rows if r["system"] == "outlook-export")
        self.assertEqual(outlook["alsoInGmail"], ["message01"])
        current, _, _ = materialize(self.root, outlook)
        self.assertEqual(current["rfc822MessageId"], "<message01@example.test>")
        self.assertEqual(current["direction"], "unknown")

    def test_tampered_original_is_not_reviewed(self):
        (self.root / self.message["path"]).write_bytes(b"changed")
        client = Client()
        result = self.run_worker(client)
        self.assertEqual(result["phase"], "source-error")
        self.assertFalse(client.calls)
        self.assertEqual(result["coverage"]["counts"]["sourceErrors"], 1)

    def test_unknown_source_selection_and_path_traversal_refuse(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            inventory(self.root, {"gmailMessageIds": ["missing01"]})
        with self.assertRaisesRegex(ValueError, "outside"):
            materialize(self.root, {**inventory(self.root)[0], "path": "../outside.eml"})
        self.config["version"] = "../../escape"
        save(self.file, self.config)
        with self.assertRaises(ValueError):
            worker.config_at(self.file)

    def test_page_budget_does_not_count_the_rest_of_a_source_as_read(self):
        self.mail("message01", "Texte fictif. " * 1800)
        result = self.run_worker(Client(), max_pages=1)
        self.assertEqual(result["phase"], "partial")
        self.assertEqual(result["coverage"]["counts"]["sourcesTextReviewed"], 0)
        self.assertGreater(result["coverage"]["counts"]["pendingPagesKnown"], 0)

    def test_empty_and_non_event_results_are_valid_read_receipts(self):
        self.mail("message01", "Une publicité fictive sans événement personnel.")
        result = self.run_worker(Client())
        self.assertEqual(result["phase"], "done")
        objective, _ = self.prepare()
        self.assertEqual(load(objective / "findings.json"), [])
        self.assertEqual(result["coverage"]["semanticAcceptance"], "not-established")

    def test_pagination_is_lossless_and_stable_with_bounded_overlap(self):
        source, units, _ = materialize(self.root, inventory(self.root)[0])
        units[0]["content"] = "abcdef" * 800
        chunks = list(pages(source, units, "a" * 64, page_chars=1000, overlap=100))
        self.assertEqual(chunks, list(pages(source, units, "a" * 64, page_chars=1000, overlap=100)))
        self.assertEqual("".join(p["content"] if i == 0 else p["content"][100:] for i, p in enumerate(chunks)), units[0]["content"])

    def test_status_does_not_create_an_unplanned_campaign(self):
        with self.assertRaisesRegex(ValueError, "status never creates"):
            worker.prepare(self.root, worker.config_at(self.file), create=False)
        self.assertFalse((self.root / "objective-reviews").exists())

    def test_corrupt_receipt_is_not_counted_as_read_or_replaced(self):
        self.run_worker(Client())
        objective, manifest = self.prepare()
        file = next((objective / "page-reviews").glob("*.json"))
        value = load(file)
        value["sourceRecord"]["body"] += "tampered"
        save(file, value)
        report = worker.coverage(objective, manifest)
        self.assertEqual(report["counts"]["invalidReviewReceipts"], 1)
        self.assertEqual(report["counts"]["reviewedPages"], 0)
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.run_worker(Client())

    def test_mixed_date_precision_does_not_invent_an_interval_conflict(self):
        value = {"summary": "Résumé fictif.", "classification": "life-events", "moments": [moment("citation")], "gaps": []}
        value["moments"][0].update(startDate="2014-08-20", startPrecision="day", endDate="2014", endPrecision="year")
        self.assertEqual(validate(value, "citation"), value)

    def test_whitespace_equivalent_outlook_copy_reuses_read_without_new_fact(self):
        self.mail("message01", "Mon\n  déménagement est terminé en août 2014.\n", outlook=True)
        self.config["selection"].pop("outlookSha256")
        save(self.file, self.config)
        client = Client()
        result = self.run_worker(client)
        self.assertEqual(result["phase"], "done")
        self.assertEqual(len(client.calls), 1)
        counts = result["coverage"]["counts"]
        self.assertEqual((counts["reviewedPages"], counts["equivalentPages"]), (1, 1))
        self.assertEqual((counts["sourcesTextReviewed"], counts["sourcesTextCovered"]), (1, 2))
        self.assertFalse(result["coverage"]["allTargetTextReviewed"])
        self.assertTrue(result["coverage"]["allTargetTextCovered"])
        objective, _ = self.prepare()
        findings, sources = load(objective / "findings.json"), load(objective / "sources.json")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["sourceIndependence"], "same-declaration")
        self.assertEqual(len(findings[0]["sourceIds"]), 2)
        indexed = {s["id"]: s for s in sources}
        self.assertTrue(all(c["quote"] in indexed[c["sourceId"]]["body"] for c in findings[0]["claimsWithExactQuotes"]))
        alias = next(s for s in sources if s["nativeRef"]["system"] == "outlook-export")
        self.assertEqual(alias["bodyScope"], "verified-equivalent-unit-not-read-by-model")
        self.run_worker(client)
        self.assertEqual(len(client.calls), 1)

    def test_identical_text_with_another_rfc_date_context_is_read_separately(self):
        self.mail("message02", "Mon déménagement est terminé en août 2014.")
        self.config["selection"]["gmailMessageIds"].append("message02")
        save(self.file, self.config)
        client = Client()
        result = self.run_worker(client)
        self.assertEqual(result["phase"], "done")
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(result["coverage"]["counts"]["equivalentPages"], 0)

    def test_new_mime_variant_is_not_covered_by_another_body(self):
        self.mail("message01", "Un corps fictif.", "<p>Un autre contenu.</p>")
        client = Client()
        result = self.run_worker(client)
        self.assertEqual(result["phase"], "done")
        self.assertEqual(len(client.calls), 2)

    def test_exact_plain_html_equivalence_does_not_create_two_read_counts(self):
        self.mail("message01", "Un corps fictif.", "<p>Un corps fictif.</p>")
        client = Client()
        result = self.run_worker(client)
        self.assertEqual(result["phase"], "done")
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(result["coverage"]["counts"]["equivalentPages"], 1)

    def test_equivalent_date_zones_and_display_names_preserve_native_message_identity(self):
        source, units, _ = materialize(self.root, inventory(self.root)[0])
        copy_source = copy.deepcopy(source)
        copy_source["mailDate"] = "2014-08-01T06:00:00-04:00"
        copy_source["headers"]["from"] = '"Autre affichage" <owner@example.test>'
        self.assertEqual(equivalent.key(source, units[0]), equivalent.key(copy_source, units[0]))
        copy_source["direction"] = "draft"
        self.assertNotEqual(equivalent.key(source, units[0]), equivalent.key(copy_source, units[0]))

    def test_visual_attachments_remain_gaps_without_ocr_or_render(self):
        save(self.root / "threads/thread001/manifest.json", {"messages": [{"id": "message01", "attachments": [
            {"filename": "photo.jpg", "mimeType": "image/jpeg", "sha256": "f" * 64, "status": "needs_visual_review"}]}]})
        _, _, gaps = materialize(self.root, inventory(self.root)[0])
        self.assertIn("visual-or-ocr-qualification-pending", [g["code"] for g in gaps])

    def test_dates_precision_subject_and_classification_fail_closed(self):
        value = {"summary": "Résumé fictif.", "classification": "life-events", "moments": [moment("citation")], "gaps": []}
        for key, bad in [("startDate", "2014-13"), ("endDate", "2013-01-01"), ("subject", "confirmed"), ("ongoing", "yes")]:
            wrong = copy.deepcopy(value)
            wrong["moments"][0][key] = bad
            with self.assertRaises(ValueError):
                validate(wrong, "citation")
        wrong = copy.deepcopy(value)
        wrong["classification"] = "no-life-event"
        with self.assertRaises(ValueError):
            validate(wrong, "citation")

    def test_worker_output_bounds_match_the_core_context_contract(self):
        value = {"summary": "Résumé fictif.", "classification": "life-events", "moments": [moment("citation")], "gaps": []}
        for key, maximum in [("title", 500), ("description", 16000), ("uncertainty", 2000), ("rationale", 8000), ("subjectName", 300)]:
            wrong = copy.deepcopy(value)
            wrong["moments"][0][key] = "x" * (maximum + 1)
            with self.assertRaisesRegex(ValueError, "bound"):
                validate(wrong, "citation")
        wrong = copy.deepcopy(value)
        wrong["moments"][0]["quotes"] *= 21
        with self.assertRaisesRegex(ValueError, "bound"):
            validate(wrong, "citation")

    def test_scheduling_priority_does_not_change_objective_or_page_intent(self):
        self.mail("message02", "Aucun événement personnel dans ce message fictif.")
        self.config["selection"]["gmailMessageIds"].append("message02")
        save(self.file, self.config)
        _, manifest = self.prepare()
        result = self.run_worker(Client(), max_pages=1, priority=["gmail:message02"])
        row = next(s for s in result["coverage"]["sources"] if s["messageId"] == "message02")
        self.assertEqual(row["reviewedPages"], 1)
        self.assertEqual(self.prepare()[1]["objectiveSha256"], manifest["objectiveSha256"])


if __name__ == "__main__":
    unittest.main()
