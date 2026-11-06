"""Literal summaries and source uncertainty cannot invent stronger conclusions."""
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
import objective_source_language as language
from review_receipts import hashed
import test_objective_grounding as fixtures
import test_objective_review as review_fixtures


def response(content, contract=grounding.FACT_CONTRACT):
    value = fixtures.grounded(content, hypotheses=False)
    value.pop("summary")
    value["summaryCitationIds"] = [grounding.catalog(content)[0]["id"]]
    if contract == grounding.FACT_CONTRACT:
        value["omittedCueIds"] = []
        for moment in value["moments"]:
            moment.pop("uncertainty")
            moment["factType"] = "life-event"
    return value


class SourceLanguageTests(unittest.TestCase):
    def test_summary_preserves_qualifiers_negation_and_attribution_without_generated_gist(self):
        body = "Correspondant : ta dernière révision est reçue ; elle n’est pas approuvée."
        raw = response(body)
        result, changes = normalize_representation(raw, body)
        validate(result, body)
        self.assertIn("« " + body + " »", result["summary"])
        self.assertNotIn("version finale", result["summary"])
        self.assertNotIn("Le propriétaire affirme", result["summary"])
        self.assertEqual(changes[0]["contract"], grounding.FACT_CONTRACT)
        span = changes[0]["summary"]["sourceSpans"][0]
        self.assertEqual(body[span["start"]:span["end"]], body)

    def test_free_summary_is_refused_for_new_frozen_contract(self):
        body = "La proposition attend une réponse."
        raw = response(body); raw["summary"] = "La proposition est acceptée."
        with self.assertRaisesRegex(ValueError, "result shape"):
            grounding.project(raw, body, grounding.FACT_CONTRACT)

    def test_long_summary_span_is_not_cut_before_negation_or_condition(self):
        body = "Le document " + "révisé " * 350 + "n’est pas accepté."
        result, changes = normalize_representation(response(body), body)
        validate(result, body)
        self.assertLessEqual(len(result["summary"]), 2000)
        self.assertNotIn("Le document", result["summary"])
        self.assertEqual(changes[0]["summary"]["reason"], "size-limit")
        self.assertEqual(result["moments"][0]["quotes"], [body])

    def test_summary_uses_source_order_and_never_joins_speakers_into_a_claim(self):
        body = "A : Peut-être en décembre.\r\nB : Aucun accord conclu."
        raw = response(body); raw["summaryCitationIds"] = ["q2", "q1"]
        result, _ = normalize_representation(raw, body)
        self.assertLess(result["summary"].index("A :"), result["summary"].index("B :"))
        self.assertIn("« B : Aucun accord conclu. »", result["summary"])

    def test_explicit_questions_conditions_and_possibilities_are_preserved_verbatim(self):
        for body, basis in (("Viendrais-tu mardi ?", "question"),
                            ("Si le budget est accepté, nous réserverons.", "condition"),
                            ("Nous pourrions partir en automne.", "possibility"),
                            ("Maybe next year.", "possibility")):
            raw = response(body)
            raw["moments"][0]["hypotheses"] = [{"basis": basis, "citationIds": ["q1"]}]
            before = copy.deepcopy(raw)
            result, _ = normalize_representation(raw, body)
            validate(result, body)
            hint = result["moments"][0]["relationHints"][0]
            self.assertIn("« " + body + " »", hint)
            self.assertTrue(hint.startswith("Hypothèse à vérifier :"))
            self.assertEqual(raw, before)

    def test_signature_document_exchange_and_completed_event_cannot_seed_a_new_hypothesis(self):
        for body in ("Alex, titre professionnel 555-0100", "Objet : Copies du relevé annuel.",
                     "Mon installation est terminée.", "Adresse https://example.test/?page=2"):
            for basis in language.LABELS:
                raw = response(body)
                raw["moments"][0]["hypotheses"] = [{"basis": basis, "citationIds": ["q1"]}]
                with self.assertRaisesRegex(ValueError, "does not explicitly express"):
                    grounding.project(raw, body)

    def test_generated_hypothesis_text_unknown_ids_and_wrong_basis_fail_closed(self):
        body = "Si la demande est retenue, j’en reparlerai."
        for item in ({"basis": "condition", "citationIds": ["q1"], "text": "Un déménagement est probable."},
                     {"basis": "condition", "citationIds": ["q999"]},
                     {"basis": "question", "citationIds": ["q1"]}):
            raw = response(body);raw["moments"][0]["hypotheses"] = [item]
            with self.assertRaises(ValueError):
                grounding.project(raw, body)

    def test_unknown_duplicate_and_non_string_summary_references_fail_closed(self):
        body = "Un passage sans interprétation."
        for ids in (["q999"], ["q1", "q1"], [False], "q1"):
            raw = response(body);raw["summaryCitationIds"] = ids
            with self.assertRaisesRegex(ValueError, "source spans"):
                grounding.project(raw, body)

    def test_page_schema_exposes_only_explicit_uncertainty_spans(self):
        schema = grounding.schema_for("Un titre et un numéro.\nViendras-tu ?\nPeut-être en hiver.", grounding.FACT_CONTRACT)
        item = schema["properties"]["moments"]["items"]["properties"]["hypotheses"]["items"]
        self.assertEqual(item["properties"]["citationIds"]["items"]["enum"], ["q2", "q3"])
        self.assertNotIn("text", item["properties"])
        self.assertNotIn("summary", schema["properties"])

    def test_legacy_projection_is_identical_and_cannot_bypass_new_contract(self):
        body = "Une ancienne réponse à conserver."
        raw = fixtures.grounded(body)
        before = copy.deepcopy(raw)
        result, changes = grounding.project(raw, body, grounding.LEGACY_CONTRACT)
        self.assertEqual(changes[0]["contract"], grounding.LEGACY_CONTRACT)
        self.assertEqual(result["summary"], raw["summary"])
        self.assertEqual(raw, before)
        self.assertEqual(grounding.contract_for({"responseSchemaSha256": hashed(grounding.SCHEMA_V1)}), grounding.LEGACY_CONTRACT)
        with self.assertRaises(ValueError):
            grounding.project(raw, body, grounding.FACT_CONTRACT)


class SourceLanguageWorkerTests(unittest.TestCase):
    setUp = fixtures.GroundedWorkerTests.setUp
    mail = fixtures.GroundedWorkerTests.mail
    prepare = fixtures.GroundedWorkerTests.prepare
    run_worker = fixtures.GroundedWorkerTests.run_worker

    def test_summary_projection_is_verified_on_receipt_reads_and_saved_results_resume_without_model(self):
        client = review_fixtures.Client()
        with patch.object(worker, "normalize_representation", side_effect=ValueError("interrupted projection")):
            self.assertEqual(self.run_worker(client)["phase"], "validation-error")
        self.assertEqual(self.run_worker(client)["inferenceCalls"], 0)
        self.assertEqual(len(client.calls), 1)
        objective, manifest = self.prepare()
        file = next((objective / "page-reviews").glob("*.json"))
        receipt = worker.read_receipt(file, manifest)
        receipt["result"]["summary"] = "Un événement confirmé et terminé."
        save(file, receipt)
        with self.assertRaisesRegex(ValueError, "retained native result"):
            worker.read_receipt(file, manifest)

    def test_v1_receipt_still_requires_its_original_projection_after_schema_upgrade(self):
        with patch.object(worker, "SCHEMA", grounding.SCHEMA_V1):
            self.assertEqual(self.run_worker(review_fixtures.Client())["newlyReviewedPages"], 1)
            objective, manifest = self.prepare()
        file = next((objective / "page-reviews").glob("*.json"))
        receipt = worker.read_receipt(file, manifest)
        self.assertEqual(receipt["resultProcessing"]["changes"][0]["contract"], grounding.LEGACY_CONTRACT)
        receipt.pop("resultProcessing"); save(file, receipt)
        with self.assertRaisesRegex(ValueError, "requires its retained native projection"):
            worker.read_receipt(file, manifest)

    def test_forbidden_interpretation_is_retained_as_rejection_without_retry(self):
        def invalid(prompt, reply):
            raw = response(prompt["untrustedContent"])
            raw["moments"][0]["hypotheses"] = [{"basis": "possibility", "citationIds": ["q1"]}]
            reply["response"] = json.dumps(raw)
            return reply
        client, calls = fixtures.disposition_fixtures.DispositionTests.client(self, invalid)
        first = self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(first["newlyRejectedPages"], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)["inferenceCalls"], 0)
        self.assertEqual(len(calls), 1)
        objective, _ = self.prepare()
        self.assertEqual(load(objective / "findings.json"), [])


if __name__ == "__main__":
    unittest.main()
