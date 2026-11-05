"""New extraction cannot select absence markers or certify personal closeness."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_grounding as grounding
import objective_review as worker
from evidence_store import load, save
from objective_schema import validate
from review_receipts import hashed
import test_objective_source_language as fixtures
import test_objective_review as review_fixtures


class AttributionContractTests(unittest.TestCase):
    def test_no_eligible_source_requires_empty_hypotheses_without_selectable_sentinel(self):
        body = "Objet : Copies annuelles\nDe : Alex\nBonne soirée !"
        template = copy.deepcopy(grounding.SCHEMA)
        schema = grounding.schema_for(body)
        hypotheses = schema["properties"]["moments"]["items"]["properties"]["hypotheses"]
        self.assertEqual(hypotheses["maxItems"], 0)
        self.assertNotIn("no-explicit-uncertainty", json.dumps(schema))
        raw = fixtures.response(body)
        result, _ = grounding.project(raw, body, grounding.CONTRACT)
        validate(result, body)
        self.assertEqual(result["moments"][0]["relationHints"], [])
        raw["moments"][0]["hypotheses"] = [{"basis": "possibility", "citationIds": ["no-explicit-uncertainty"]}]
        with self.assertRaisesRegex(ValueError, "known distinct source spans"):
            grounding.project(raw, body, grounding.CONTRACT)
        self.assertEqual(grounding.SCHEMA, template)

    def test_empty_source_has_no_selectable_moment_summary_or_absence_marker(self):
        schema = grounding.schema_for(" \r\n\t")
        self.assertEqual(schema["properties"]["moments"]["maxItems"], 0)
        self.assertEqual(schema["properties"]["summaryCitationIds"]["maxItems"], 0)
        self.assertNotIn("no-source-span", json.dumps(schema))

    def test_source_uncertainty_remains_available_when_explicit(self):
        schema = grounding.schema_for("Un envoi administratif.\nViendras-tu ?")
        hypotheses = schema["properties"]["moments"]["items"]["properties"]["hypotheses"]
        self.assertEqual(hypotheses["maxItems"], 4)
        self.assertEqual(hypotheses["items"]["properties"]["citationIds"]["items"]["enum"], ["q2"])

    def test_model_cannot_certify_closeness_even_when_backend_ignores_schema(self):
        for body in ("Alex transmet les documents. Bonne soirée !", "Alex écrit : ma sœur viendra."):
            raw = fixtures.response(body)
            raw["moments"][0].update(subject="related", subjectName="Alex")
            before = copy.deepcopy(raw)
            with self.assertRaisesRegex(ValueError, "Personal proximity requires human review"):
                grounding.project(raw, body, grounding.CONTRACT)
            self.assertEqual(raw, before)
            for subject in ("thirdparty", "unknown", "owner"):
                raw["moments"][0]["subject"] = subject
                result, _ = grounding.project(raw, body, grounding.CONTRACT)
                validate(result, body)
                self.assertEqual(result["moments"][0]["subject"], subject)
        choices = grounding.SCHEMA["properties"]["moments"]["items"]["properties"]["subject"]["enum"]
        self.assertNotIn("related", choices)

    def test_v2_schema_and_projection_preserve_old_proximity_and_sentinel_verbatim(self):
        body = "Un ancien échange documentaire."
        raw = fixtures.response(body, grounding.WORDING_CONTRACT)
        raw["moments"][0]["subject"] = "related"
        result, changes = grounding.project(raw, body, grounding.WORDING_CONTRACT)
        validate(result, body)
        self.assertEqual(result["moments"][0]["subject"], "related")
        self.assertEqual(changes[0]["contract"], grounding.WORDING_CONTRACT)
        self.assertEqual(changes[0]["reason"], "Whole source excerpts in summary; only explicitly expressed source uncertainty, without generated hypotheses.")
        schema = grounding.schema_for(body, grounding.WORDING_CONTRACT)
        refs = schema["properties"]["moments"]["items"]["properties"]["hypotheses"]["items"]["properties"]["citationIds"]["items"]
        self.assertEqual(refs["enum"], ["no-explicit-uncertainty"])
        self.assertEqual(grounding.contract_for({"responseSchemaSha256": hashed(grounding.SCHEMA_V2)}), grounding.WORDING_CONTRACT)
        self.assertNotEqual(hashed(grounding.SCHEMA_V2), hashed(grounding.SCHEMA))


class AttributionReceiptTests(unittest.TestCase):
    setUp = fixtures.SourceLanguageWorkerTests.setUp
    mail = fixtures.SourceLanguageWorkerTests.mail
    prepare = fixtures.SourceLanguageWorkerTests.prepare
    run_worker = fixtures.SourceLanguageWorkerTests.run_worker

    def test_v2_receipt_keeps_its_exact_projection_and_tampering_still_refuses(self):
        with patch.object(worker, "SCHEMA", grounding.SCHEMA_V2):
            self.assertEqual(self.run_worker(review_fixtures.Client())["newlyReviewedPages"], 1)
            objective, manifest = self.prepare()
            file = next((objective / "page-reviews").glob("*.json"))
        receipt = worker.read_receipt(file, manifest)
        self.assertEqual(receipt["resultProcessing"]["changes"][0]["contract"], grounding.WORDING_CONTRACT)
        receipt.pop("resultProcessing")
        save(file, receipt)
        with self.assertRaisesRegex(ValueError, "requires its retained native projection"):
            worker.read_receipt(file, manifest)

    def test_unsupported_proximity_is_retained_rejected_and_never_reissued(self):
        import test_objective_dispositions as disposition_fixtures
        def invalid(prompt, reply):
            raw = fixtures.response(prompt["untrustedContent"])
            raw["moments"][0]["subject"] = "related"
            reply["response"] = json.dumps(raw)
            return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, invalid)
        first = self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(first["newlyRejectedPages"], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)["inferenceCalls"], 0)
        self.assertEqual(len(calls), 1)
        objective, _ = self.prepare()
        self.assertEqual(load(objective / "findings.json"), [])


if __name__ == "__main__":
    unittest.main()
