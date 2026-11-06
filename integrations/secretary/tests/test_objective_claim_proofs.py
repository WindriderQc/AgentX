"""A message date cannot become a move date; type and uncertainty need evidence."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_grounding as grounding
import objective_claim_proofs as proofs
import objective_date_evidence as dates
import objective_review as worker
from objective_schema import normalize_representation, validate
from evidence_store import load, save
from review_receipts import hashed
import test_objective_source_language as fixtures
import test_objective_dispositions as disposition_fixtures


def wire_v5(value, date_entries=()):
    """Fake model selects supplied references, never computes its own dates."""
    value = copy.deepcopy(value)
    for moment in value["moments"]:
        for side in ("start", "end"):
            wanted = moment.pop(side + "Date")
            moment.pop(side + "Precision")
            moment[side + "DateRef"] = next((r["id"] for r in date_entries
                if r["kind"] == "event-expression" and r["value"] == wanted), None)
        moment.pop("originalDate")
        moment["factTypeCitationIds"] = []
    return value


def response(body):
    return wire_v5(fixtures.response(body, grounding.FACT_CONTRACT))


def context(body, **extra):
    return {"offset": 0, "end": len(body), "totalChars": len(body), **extra}


def project(raw, body, ctx=None):
    result, changes = normalize_representation(raw, body, grounding.CONTRACT, ctx)
    validate(result, body)
    return result, changes


class LiteralDateTests(unittest.TestCase):
    def test_precise_literal_dates_preserve_precision_and_original_offsets(self):
        for words, value, precision in [("12 mai 2021", "2021-05-12", "day"),
                ("août 2014", "2014-08", "month"), ("February 29, 2024", "2024-02-29", "day"),
                ("2021-05-09", "2021-05-09", "day"), ("2021-05", "2021-05", "month"),
                ("en 2015", "2015", "year")]:
            body = "Une étape est annoncée " + words + "."
            rows = dates.catalog(grounding.catalog(body))
            self.assertEqual(len(rows), 1, words)
            row = rows[0]
            self.assertEqual((row["value"], row["precision"]), (value, precision))
            self.assertEqual(body[row["start"]:row["end"]], row["text"])

    def test_ordinal_days_keep_day_precision_and_invalid_days_cannot_be_reduced_to_month(self):
        for words in ("9th May 2021", "May 9th, 2021", "21st May 2021"):
            rows = dates.catalog(grounding.catalog("Une étape est annoncée " + words + "."))
            self.assertEqual(len(rows), 1, words)
            self.assertEqual(rows[0]["precision"], "day", words)
            self.assertEqual(rows[0]["text"], words)
        for words in ("31st February 2024", "February 31st, 2024", "999th May 2021"):
            self.assertEqual(dates.catalog(grounding.catalog("Une étape est annoncée " + words + ".")), [], words)

    def test_invalid_partial_relative_and_bare_dates_are_not_completed_or_downgraded(self):
        for body in ("Je pars après-demain.", "Départ le 12 juillet.", "Date : 31 février 2024",
                     "Date : en 2024-13-01", "31 février 2024", "12 mai 2021"):
            self.assertEqual(dates.catalog(grounding.catalog(body)), [], body)

    def test_headers_and_metadata_stay_communication_dates_without_timezone_shift(self):
        body = "Envoyé : 7 mai 2021 08:15\nMon déménagement est terminé."
        entries = dates.catalog(grounding.catalog(body), context(body, mailDate="2021-05-08T00:30:00+09:00"))
        self.assertTrue(all(r["kind"] == "communication" for r in entries))
        self.assertEqual(entries[0]["value"], "2021-05-08")
        self.assertEqual(entries[1]["value"], "2021-05-07")

    def test_finished_move_cannot_borrow_a_message_date(self):
        body = "Envoyé : 7 mai 2021 08:15\nMon déménagement est terminé."
        raw = response(body);moment = raw["moments"][0]
        moment["observations"] = [{"text": "La personne déclare son déménagement terminé.", "citationIds": ["q2"]}]
        ctx = context(body, mailDate="2021-05-07T08:15:00-04:00")
        for ref in [r["id"] for r in dates.catalog(grounding.catalog(body), ctx)]:
            moment["startDateRef"] = ref
            with self.assertRaisesRegex(ValueError, "communication date cannot date"):
                project(raw, body, ctx)
        moment["startDateRef"] = None
        result, _ = project(raw, body, ctx)
        self.assertIsNone(result["moments"][0]["startDate"])
        self.assertIn("Date de l'événement", result["moments"][0]["uncertainty"])

    def test_explicit_event_date_requires_its_own_observation(self):
        body = "Mon déménagement est terminé le 12 mai 2021.\nUn autre événement est raconté."
        raw = response(body);moment = raw["moments"][0]
        moment["startDateRef"] = dates.catalog(grounding.catalog(body))[0]["id"]
        result, _ = project(raw, body, context(body))
        self.assertEqual(result["moments"][0]["startDate"], "2021-05-12")
        moment["observations"][0]["citationIds"] = ["q2"]
        with self.assertRaisesRegex(ValueError, "own observations"):project(raw, body, context(body))

    def test_cv_contact_can_use_metadata_only_for_its_communication(self):
        body = "Je vous transmets mon CV pour discuter de vos projets."
        raw = response(body);moment = raw["moments"][0]
        moment.update(factType="career-contact", factTypeCitationIds=["q1"], startDateRef="m0", category="work")
        ctx = context(body, mailDate="2011-04-14T23:50:00-05:00")
        result, changes = project(raw, body, ctx)
        self.assertEqual(result["moments"][0]["startDate"], "2011-04-14")
        self.assertIn("date une communication", result["moments"][0]["uncertainty"])
        self.assertEqual(changes[0]["factPolicy"]["facts"][0]["dates"][0]["source"], "retained-message-metadata")
        moment["endDateRef"] = "m0"
        with self.assertRaisesRegex(ValueError, "communication date cannot date"):project(raw, body, ctx)

    def test_legacy_date_values_and_fabricated_references_fail_closed(self):
        body = "Le déménagement est déjà terminé."
        for extra in ({"startDate": "2021-05-07"}, {"startDateRef": "invented-date"}, {"originalDate": "7 mai"}):
            raw = response(body);raw["moments"][0].update(extra)
            with self.assertRaises(ValueError):project(raw, body)


class TypedFactTests(unittest.TestCase):
    def test_version_delivery_has_a_work_correspondence_type_and_no_employment_claim(self):
        body = "Envoyé : 9 mai 2021 09:25\nVoici ma dernière version du code, à vérifier."
        raw = response(body);moment = raw["moments"][0]
        moment.update(category="work", factType="work-correspondence", factTypeCitationIds=["q2"],
                      startDateRef="d1", observations=[{"text": "La personne présente sa dernière version à vérifier.", "citationIds": ["q2"]}])
        result, changes = project(raw, body, context(body))
        self.assertEqual(result["moments"][0]["startDate"], "2021-05-09")
        self.assertIn("Nature proposée", result["moments"][0]["uncertainty"])
        self.assertIn("aucun changement d'emploi", result["moments"][0]["uncertainty"])
        self.assertNotIn("Changement professionnel explicitement mentionné", result["moments"][0]["uncertainty"])
        self.assertIn("Envoyé : 9 mai 2021 09:25", result["moments"][0]["quotes"])
        self.assertEqual(changes[0]["factPolicy"]["facts"][0]["proposedFactType"], "work-correspondence")
        moment["factType"] = "employment-change"
        with self.assertRaisesRegex(ValueError, "matching evidence"):project(raw, body, context(body))
        schema = grounding.schema_for(body)
        self.assertNotIn("employment-change", schema["properties"]["moments"]["items"]["properties"]["factType"]["enum"])

    def test_post_contract_work_is_not_automatically_an_employment_transition(self):
        body = "J'ai passé trois heures sur le planificateur pour des corrections post-contrat."
        raw = response(body);raw["moments"][0].update(category="work", factType="work-activity", factTypeCitationIds=["q1"])
        result, _ = project(raw, body, context(body))
        self.assertIsNone(result["moments"][0]["startDate"])
        self.assertIn("activité ou suivi", result["moments"][0]["uncertainty"])
        self.assertNotIn("employment-change", [r["factType"] for r in proofs.fact_catalog(grounding.catalog(body))])

    def test_personal_documents_lease_end_and_timetable_do_not_supply_professional_types(self):
        for body in ("Mon contrat de location est terminé.", "Voici mon nouveau document personnel.",
                     "Je prépare mon nouvel emploi du temps."):
            kinds = [r["factType"] for r in proofs.fact_catalog(grounding.catalog(body))]
            self.assertNotIn("employment-change", kinds)
            self.assertNotIn("work-correspondence", kinds)

    def test_type_cannot_borrow_an_unrelated_observation(self):
        body = "Voici ma version du code.\nJe démissionne de mon poste."
        raw = response(body);raw["moments"][0].update(factType="employment-change", factTypeCitationIds=["q2"], category="work")
        with self.assertRaisesRegex(ValueError, "own observations"):project(raw, body)
        raw["moments"][0]["observations"][0]["citationIds"] = ["q2"]
        result, _ = project(raw, body)
        self.assertIn("proposée à relire", result["moments"][0]["uncertainty"])
        self.assertNotIn("explicitement mentionné", result["moments"][0]["uncertainty"])


class CategorizedUncertaintyTests(unittest.TestCase):
    def test_condition_reference_carries_its_only_admissible_category(self):
        body = "Nous réserverons si le budget est accepté."
        catalog = proofs.uncertainty_catalog(grounding.catalog(body))
        self.assertEqual([(r["id"], r["basis"], r["citationIds"]) for r in catalog], [("u1", "condition", ["q1"])])
        raw = response(body);raw["moments"][0]["hypotheses"] = ["u1"]
        result, changes = project(raw, body)
        self.assertIn("Condition citée", result["moments"][0]["relationHints"][0])
        self.assertIn(body, result["moments"][0]["relationHints"][0])
        self.assertEqual(changes[0]["factPolicy"]["facts"][0]["uncertaintyRefs"], ["u1"])

    def test_uncertainty_cannot_supply_an_independent_or_wrong_basis(self):
        body = "Si nous nous perdons, nous appellerons."
        for selection in ([{"basis": "possibility", "citationIds": ["q1"]}], ["q1"], ["u999"], ["u1", "u1"], [False]):
            raw = response(body);raw["moments"][0]["hypotheses"] = selection
            with self.assertRaisesRegex(ValueError, "categorized reference"):project(raw, body)

    def test_schema_and_catalog_have_no_selectable_absence_marker(self):
        for body, expected in [("Une simple signature.", []), ("Viendras-tu ?", ["u1"]), ("Peut-être demain.", ["u1"])]:
            schema = grounding.schema_for(body);hyp=schema["properties"]["moments"]["items"]["properties"]["hypotheses"]
            if expected:self.assertEqual(hyp["items"]["enum"], expected)
            else:self.assertEqual(hyp["maxItems"], 0)
            self.assertNotIn("no-explicit-uncertainty", json.dumps(schema))
            self.assertNotIn("basis", hyp["items"])

    def test_four_frozen_schemas_and_v4_projection_are_preserved(self):
        self.assertEqual(hashed(grounding.SCHEMA_V4), "f8e5bda15d3930124d12a64db3f20cbe9f59a296d66cd4b5c59cf6a8723e9fc8")
        self.assertEqual(grounding.contract_for({"responseSchemaSha256":hashed(grounding.SCHEMA_V4)}), grounding.FACT_CONTRACT)
        body = "Un ancien passage à relire."
        raw = fixtures.response(body, grounding.FACT_CONTRACT)
        result, changes = normalize_representation(raw, body, grounding.FACT_CONTRACT)
        self.assertEqual(changes[0]["contract"], grounding.FACT_CONTRACT)
        self.assertIn("Portée limitée", result["moments"][0]["uncertainty"])
        with self.assertRaises(ValueError):project(raw, body)


class ProofWorkerTests(unittest.TestCase):
    setUp = fixtures.SourceLanguageWorkerTests.setUp
    mail = fixtures.SourceLanguageWorkerTests.mail
    prepare = fixtures.SourceLanguageWorkerTests.prepare
    run_worker = fixtures.SourceLanguageWorkerTests.run_worker

    def test_message_date_catalog_is_frozen_in_projection_and_replay_never_reinfers(self):
        body = "Je vous transmets mon CV."
        self.mail("message01", body)
        def output(prompt, reply):
            self.assertEqual(prompt["uncertaintyCatalog"], [])
            self.assertEqual(prompt["dateCatalog"][0]["id"], "m0")
            value = response(body);value["moments"][0].update(category="work", factType="career-contact", factTypeCitationIds=["q1"], startDateRef="m0")
            reply["response"] = json.dumps(value)
            return reply
        client,calls=disposition_fixtures.DispositionTests.client(self,output)
        self.assertEqual(self.run_worker(client)["newlyReviewedPages"],1)
        self.assertEqual(self.run_worker(client)["inferenceCalls"],0)
        self.assertEqual(len(calls),1)
        objective,manifest=self.prepare();file=next((objective/'page-reviews').glob('*.json'));row=worker.read_receipt(file,manifest)
        row["sourceRecord"]["mailDate"]="2020-01-01T12:00:00+00:00";save(file,row)
        with self.assertRaisesRegex(ValueError,"retained native result"):worker.read_receipt(file,manifest)

    def test_invalid_header_date_selection_is_retained_without_reissue(self):
        body="Envoyé : 7 mai 2021 08:15\nMon déménagement est terminé."
        self.mail("message01",body)
        def output(prompt,reply):
            value=response(body);value["moments"][0].update(startDateRef="m0",observations=[{"text":"Le déménagement est dit terminé.","citationIds":["q2"]}])
            reply["response"]=json.dumps(value);return reply
        client,calls=disposition_fixtures.DispositionTests.client(self,output)
        self.assertEqual(self.run_worker(client,retain_rejected_pages=True)["newlyRejectedPages"],1)
        self.assertEqual(self.run_worker(client,retain_rejected_pages=True)["inferenceCalls"],0)
        self.assertEqual(len(calls),1)
        objective,manifest=self.prepare();p=next((objective/'page-dispositions').glob('*.json'))
        self.assertIn("communication date cannot date",load(p)["failure"]["message"])


if __name__ == "__main__":
    unittest.main()
