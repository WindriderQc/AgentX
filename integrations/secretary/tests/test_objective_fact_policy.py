"""Career recall, concrete limits and frozen source-scope replay."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_fact_policy as policy
import objective_grounding as grounding
import objective_review as worker
from evidence_store import load, save
from objective_schema import normalize_representation, validate
from review_receipts import hashed
import test_objective_source_language as fixtures
import test_objective_review as review_fixtures
import test_objective_dispositions as disposition_fixtures


def career_response(body):
    value = fixtures.response(body)
    moment = value["moments"][0]
    moment.update(title="Prise de contact avec CV", factType="career-contact", category="work",
                  startDate=None, endDate=None, startPrecision="unknown", endPrecision="unknown",
                  originalDate="", observations=[{"text": "La personne annonce un CV et souhaite discuter des projets.", "citationIds": ["q1"]}])
    return value


class FactPolicyTests(unittest.TestCase):
    def test_cv_contact_remains_a_career_step_without_recruitment_or_certainty_label(self):
        body = "Je vous envoie mon CV et souhaite discuter de vos projets."
        raw = career_response(body);before = copy.deepcopy(raw)
        result, changes = normalize_representation(raw, body, grounding.FACT_CONTRACT)
        validate(result, body)
        moment = result["moments"][0]
        self.assertIsNone(moment["startDate"])
        self.assertIn("Prise de contact", moment["uncertainty"])
        self.assertIn("ni entretien, offre ou embauche", moment["uncertainty"])
        self.assertIn("Date de l'événement ou de la démarche non précisée", moment["uncertainty"])
        self.assertNotIn("factType", moment)
        proof = changes[0]["factPolicy"]
        self.assertEqual(proof["careerCues"][0]["disposition"], "cited-observation")
        self.assertEqual(proof["facts"][0]["factType"], "career-contact")
        self.assertEqual(raw, before)

    def test_lexical_cues_are_not_events_and_silent_omission_refuses(self):
        body = "Je vous transmets mon CV ci-joint."
        raw = career_response(body);raw["moments"] = []
        with self.assertRaisesRegex(ValueError, "potentially useful career cue"):
            grounding.project(raw, body, grounding.FACT_CONTRACT)
        raw["omittedCueIds"] = ["q1"]
        result, changes = grounding.project(raw, body, grounding.FACT_CONTRACT)
        validate(result, body)
        self.assertEqual(result["moments"], [])
        self.assertEqual(result["classification"], "no-life-event")
        self.assertIn(body, result["gaps"][0])
        self.assertEqual(changes[0]["factPolicy"]["careerCues"][0]["disposition"], "source-review-gap")
        for ids in (["q2"], ["q1", "q1"], [True]):
            raw["omittedCueIds"] = ids
            with self.assertRaises(ValueError):grounding.project(raw, body, grounding.FACT_CONTRACT)

    def test_a_cue_cannot_be_both_retained_and_omitted(self):
        body = "Je joins mon CV."
        raw = career_response(body);raw["omittedCueIds"] = ["q1"]
        with self.assertRaisesRegex(ValueError, "both retained and omitted"):
            grounding.project(raw, body, grounding.FACT_CONTRACT)

    def test_administrative_noise_does_not_acquire_an_automatic_fact(self):
        for body in ("Objet : Relevé annuel\nBonne soirée !", "Je prévois l'entretien de ma voiture."):
            self.assertEqual(policy.career_cues(grounding.catalog(body)), [])
            raw = fixtures.response(body);raw["moments"] = [];raw["summaryCitationIds"] = []
            result, _ = grounding.project(raw, body, grounding.FACT_CONTRACT)
            self.assertEqual(result["moments"], [])
            self.assertEqual(result["gaps"], [])

    def test_date_plan_actor_question_and_partial_scope_have_distinct_concrete_limits(self):
        body = "Peut-être que le correspondant viendra."
        raw = fixtures.response(body);moment = raw["moments"][0]
        moment.update(subject="thirdparty", occurrenceStatus="planned", startDate=None,
                      startPrecision="unknown", hypotheses=[{"basis": "possibility", "citationIds": ["q1"]}])
        context = {"offset": 100, "end": 100 + len(body), "totalChars": 800}
        result, changes = normalize_representation(raw, body, grounding.FACT_CONTRACT, context)
        validate(result, body)
        text = result["moments"][0]["uncertainty"]
        for expected in ("réalisation non confirmée", "Date de l'événement", "Acteur tiers", "Passage partiel", "100", "800", "Questions, conditions ou possibilités"):
            self.assertIn(expected, text)
        self.assertIn(body, result["moments"][0]["relationHints"][0])
        self.assertTrue(changes[0]["factPolicy"]["scope"]["partial"])
        self.assertLessEqual(len(text), 2000)
        raw["moments"][0]["subject"] = "unknown"
        result, _ = grounding.project(raw, body, grounding.FACT_CONTRACT)
        self.assertIn("Identité de l'acteur non établie", result["moments"][0]["uncertainty"])

    def test_scope_cannot_disagree_with_the_retained_character_range(self):
        body = "Un passage exact."
        raw = fixtures.response(body)
        for context in ({"offset": 0, "end": len(body)+1, "totalChars": 100},
                        {"offset": True, "end": len(body), "totalChars": 100},
                        {"offset": 0, "end": len(body), "totalChars": 0}):
            with self.assertRaisesRegex(ValueError, "Source scope"):
                grounding.project(raw, body, grounding.FACT_CONTRACT, context)
        result, changes = grounding.project(raw, body, grounding.FACT_CONTRACT,
            {"offset": 0, "end": len(body), "totalChars": len(body)})
        self.assertFalse(changes[0]["factPolicy"]["scope"]["partial"])
        self.assertNotIn("Passage partiel", result["moments"][0]["uncertainty"])

    def test_free_confidence_wrong_fact_types_and_misclassified_career_steps_refuse(self):
        body = "Je vous envoie mon CV."
        for key, value in (("uncertainty", "low"), ("factType", "confirmed-hiring"), ("category", "people")):
            raw = career_response(body);raw["moments"][0][key] = value
            with self.assertRaises(ValueError):grounding.project(raw, body, grounding.FACT_CONTRACT)

    def test_schema_disables_omissions_without_cues_and_advertises_actual_ids_only(self):
        before = copy.deepcopy(grounding.SCHEMA)
        self.assertEqual(grounding.schema_for("Un simple message.")["properties"]["omittedCueIds"]["maxItems"], 0)
        schema = grounding.schema_for("Bonjour.\nJe vous envoie mon CV.")
        self.assertEqual(schema["properties"]["omittedCueIds"]["items"]["enum"], ["q2"])
        moment = schema["properties"]["moments"]["items"]
        self.assertNotIn("uncertainty", moment["properties"])
        self.assertIn("career-contact", moment["properties"]["factType"]["enum"])
        self.assertEqual(grounding.SCHEMA, before)

    def test_v3_schema_and_projection_keep_their_original_uncertainty(self):
        self.assertEqual(hashed(grounding.SCHEMA_V3), "17fbdb5bffe5ee03514631d84e3314e902a89555bee9b2499ac9182f5efba17d")
        body = "Une ancienne réponse inchangée."
        raw = fixtures.response(body, grounding.PROXIMITY_CONTRACT)
        raw["moments"][0]["uncertainty"] = "low"
        result, changes = grounding.project(raw, body, grounding.PROXIMITY_CONTRACT)
        self.assertEqual(result["moments"][0]["uncertainty"], "low")
        self.assertEqual(changes[0]["contract"], grounding.PROXIMITY_CONTRACT)
        self.assertNotIn("factPolicy", changes[0])
        self.assertEqual(grounding.contract_for({"responseSchemaSha256": hashed(grounding.SCHEMA_V3)}), grounding.PROXIMITY_CONTRACT)
        with self.assertRaises(ValueError):grounding.project(raw, body, grounding.FACT_CONTRACT)


class FactPolicyWorkerTests(unittest.TestCase):
    def setUp(self):
        fixtures.SourceLanguageWorkerTests.setUp(self)
        frozen = patch.object(worker, "SCHEMA", grounding.SCHEMA_V4)
        frozen.start(); self.addCleanup(frozen.stop)
    mail = fixtures.SourceLanguageWorkerTests.mail
    prepare = fixtures.SourceLanguageWorkerTests.prepare
    run_worker = fixtures.SourceLanguageWorkerTests.run_worker

    def test_native_selection_scope_and_projection_resume_without_another_call(self):
        body = "Je joins mon CV pour discuter de vos projets."
        self.mail("message01", body)
        def output(prompt, reply):
            self.assertEqual(prompt["selectionCues"][0]["text"], body)
            reply["response"] = json.dumps(career_response(prompt["untrustedContent"]))
            return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        first = self.run_worker(client)
        self.assertEqual(first["newlyReviewedPages"], 1)
        objective, manifest = self.prepare();file = next((objective/"page-reviews").glob("*.json"))
        receipt = worker.read_receipt(file, manifest)
        self.assertTrue(receipt["resultProcessing"]["changes"][0]["factPolicy"]["scope"]["known"])
        self.assertFalse(receipt["resultProcessing"]["changes"][0]["factPolicy"]["scope"]["partial"])
        self.assertEqual(self.run_worker(client)["inferenceCalls"], 0)
        self.assertEqual(len(calls), 1)
        original = copy.deepcopy(receipt)
        receipt["sourceRecord"]["nativeRef"]["offset"] += 1
        save(file, receipt)
        with self.assertRaisesRegex(ValueError, "retained page identity"):worker.read_receipt(file, manifest)
        receipt = original
        receipt["resultProcessing"]["changes"][0]["factPolicy"]["scope"]["end"] += 1
        save(file, receipt)
        with self.assertRaisesRegex(ValueError, "retained native result"):worker.read_receipt(file, manifest)

    def test_v3_receipts_still_require_their_frozen_projection(self):
        with patch.object(worker, "SCHEMA", grounding.SCHEMA_V3):
            self.assertEqual(self.run_worker(review_fixtures.Client())["newlyReviewedPages"], 1)
            objective, manifest = self.prepare();file = next((objective/"page-reviews").glob("*.json"))
        receipt = worker.read_receipt(file, manifest)
        self.assertEqual(receipt["resultProcessing"]["changes"][0]["contract"], grounding.PROXIMITY_CONTRACT)
        receipt.pop("resultProcessing");save(file, receipt)
        with self.assertRaisesRegex(ValueError, "requires its retained native projection"):worker.read_receipt(file, manifest)


if __name__ == "__main__":
    unittest.main()
