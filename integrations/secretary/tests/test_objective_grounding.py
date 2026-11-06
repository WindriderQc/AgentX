"""Grounded extraction keeps exact evidence, uncertainty and recovery separate."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_store import load, save
import objective_grounding as grounding
import objective_review as worker
from objective_schema import normalize_representation, validate
import test_objective_review as fixtures
import test_objective_dispositions as disposition_fixtures


def grounded(content, hypotheses=True):
    item = fixtures.moment("")
    for key in ("description", "rationale", "quotes", "relationHints"):
        item.pop(key)
    ids = [grounding.catalog(content)[0]["id"]]
    item.update(observations=[{"text": "Des corrections sont demandées après la mission.", "citationIds": ids}],
                hypotheses=[{"text": "Le statut professionnel reste à vérifier.", "citationIds": ids}] if hypotheses else [])
    return {"summary": "Un suivi de mission est documenté.", "emptyAssessment": "no-life-event", "moments": [item], "gaps": []}


class ProjectionTests(unittest.TestCase):
    def test_exact_spans_preserve_joined_signature_crlf_unicode_and_repetition(self):
        body = "\r\n Alex, PMP555-0100\t\r\nÉté\u00a0nouveau\r\n Alex, PMP555-0100\t"
        catalog = grounding.catalog(body)
        self.assertEqual(len(catalog), 3)
        for row in catalog:
            self.assertEqual(body[row["start"]:row["end"]], row["text"])
        raw = grounded(body)
        raw["moments"][0]["observations"][0]["citationIds"] = ["q1", "q2", "q3"]
        result, changes = normalize_representation(raw, body)
        validate(result, body)
        self.assertEqual(result["moments"][0]["quotes"], [catalog[0]["text"], catalog[1]["text"]])
        self.assertEqual(len(changes[0]["claims"][0]["sourceSpans"]), 3)
        self.assertNotIn("PMP 555", result["moments"][0]["quotes"][0])

    def test_hypotheses_never_enter_observation_description_or_unlabelled_rationale(self):
        body = "Des corrections restent sur la feuille de temps après le contrat."
        raw = grounded(body)
        raw["moments"][0]["hypotheses"][0]["text"] = "Le statut indépendant est une hypothèse, non établi ici."
        before = copy.deepcopy(raw)
        result, changes = normalize_representation(raw, body)
        validate(result, body)
        moment = result["moments"][0]
        self.assertNotIn("indépendant", moment["description"])
        self.assertIn("Hypothèses à vérifier :\nLe statut indépendant", moment["rationale"])
        self.assertTrue(moment["relationHints"][0].startswith("Hypothèse à vérifier :"))
        self.assertEqual(raw, before)
        self.assertEqual(changes[0]["contract"], grounding.LEGACY_CONTRACT)

    def test_classification_is_derived_without_overriding_a_model_classification(self):
        body = "Une source explicite."
        raw = grounded(body)
        self.assertEqual(grounding.project(raw, body)[0]["classification"], "life-events")
        raw["moments"] = []
        for assessment in ("no-life-event", "uncertain"):
            raw["emptyAssessment"] = assessment
            self.assertEqual(grounding.project(raw, body)[0]["classification"], assessment)
        raw["classification"] = "life-events"
        with self.assertRaisesRegex(ValueError, "result shape"):
            grounding.project(raw, body)

    def test_unknown_duplicate_empty_or_non_string_citations_are_refused(self):
        for ids in (["q999"], ["q1", "q1"], [], [1], "q1", [True]):
            raw = grounded("Une source explicite.")
            raw["moments"][0]["observations"][0]["citationIds"] = ids
            with self.assertRaisesRegex(ValueError, "source spans"):
                grounding.project(raw, "Une source explicite.")
        with self.assertRaises(ValueError):
            grounding.project(grounded("Non vide."), " \r\n\t")

    def test_missing_observations_and_forged_quotes_or_free_rationale_are_refused(self):
        for key, value in (("observations", []), ("quotes", ["Une fausse citation"]), ("rationale", "Une déduction libre")):
            raw = grounded("Une source explicite.")
            raw["moments"][0][key] = value
            with self.assertRaises(ValueError):
                grounding.project(raw, "Une source explicite.")

    def test_page_schema_only_advertises_its_own_citation_ids_and_does_not_mutate_template(self):
        before = copy.deepcopy(grounding.SCHEMA)
        schema = grounding.schema_for("Une ligne\nDeux lignes", grounding.FACT_CONTRACT)
        props = schema["properties"]["moments"]["items"]["properties"]
        ids = props["observations"]["items"]["properties"]["citationIds"]["items"]["enum"]
        self.assertEqual(ids, ["q1", "q2"])
        self.assertEqual(props["hypotheses"]["maxItems"], 0)
        self.assertNotIn("no-explicit-uncertainty", json.dumps(schema))
        self.assertEqual(grounding.SCHEMA, before)


class GroundedWorkerTests(unittest.TestCase):
    mail = fixtures.ObjectiveTests.mail
    prepare = fixtures.ObjectiveTests.prepare
    run_worker = fixtures.ObjectiveTests.run_worker

    def setUp(self):
        fixtures.ObjectiveTests.setUp(self)
        self.legacy_schema.stop()

    def test_worker_exports_candidates_with_verified_projection_and_no_reinference(self):
        client = fixtures.Client()
        first = self.run_worker(client)
        self.assertEqual(first["newlyReviewedPages"], 1)
        self.assertEqual(first["inferenceCalls"], 1)
        objective, manifest = self.prepare()
        file = next((objective / "page-reviews").glob("*.json"))
        receipt = worker.read_receipt(file, manifest)
        self.assertEqual(receipt["resultProcessing"]["changes"][0]["contract"], grounding.CONTRACT)
        finding = load(objective / "findings.json")[0]
        self.assertFalse(finding["userConfirmed"])
        self.assertEqual(finding["reviewState"], "candidate")
        self.assertEqual(self.run_worker(client)["inferenceCalls"], 0)
        self.assertEqual(len(client.calls), 1)
        original = copy.deepcopy(receipt)
        receipt.pop("resultProcessing")
        save(file, receipt)
        with self.assertRaisesRegex(ValueError, "requires its retained native projection"):
            worker.read_receipt(file, manifest)
        receipt = original
        receipt["resultProcessing"]["changes"][0]["claims"][0]["sourceSpans"][0]["end"] += 1
        save(file, receipt)
        with self.assertRaisesRegex(ValueError, "retained native result"):
            worker.read_receipt(file, manifest)

    def test_known_invalid_selector_is_retained_without_retry_or_finding(self):
        def invalid_selector(prompt, reply):
            value = grounded(prompt["untrustedContent"])
            value.pop("summary"); value["summaryCitationIds"] = []
            value["moments"][0]["hypotheses"] = []
            value["moments"][0]["observations"][0]["citationIds"] = ["unknown-span"]
            reply["response"] = json.dumps(value)
            return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, invalid_selector)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)["newlyRejectedPages"], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)["inferenceCalls"], 0)
        self.assertEqual(len(calls), 1)
        objective, _ = self.prepare()
        self.assertEqual(load(objective / "findings.json"), [])

    def test_backend_ignoring_new_schema_cannot_supply_legacy_result(self):
        class LegacyClient(fixtures.Client):
            def extract(self, system, prompt, **kwargs):
                payload = json.loads(prompt); payload.pop("citationCatalog")
                return super().extract(system, json.dumps(payload), **kwargs)
        client = LegacyClient()
        self.assertEqual(self.run_worker(client)["phase"], "validation-error")
        self.assertEqual(len(client.calls), 1)

    def test_saved_projection_resumes_without_model_after_local_interruption(self):
        client = fixtures.Client()
        with patch.object(worker, "normalize_representation", side_effect=ValueError("interrupted local projection")):
            self.assertEqual(self.run_worker(client)["phase"], "validation-error")
        self.assertEqual(self.run_worker(client)["inferenceCalls"], 0)
        self.assertEqual(len(client.calls), 1)


if __name__ == "__main__":
    unittest.main()
