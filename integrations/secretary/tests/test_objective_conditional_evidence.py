"""Type-specific generation choices and contextual conditions preserve old reads."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_grounding as grounding
import objective_uncertainty_context as uncertainty
import objective_review as worker
from evidence_store import load
from objective_schema import normalize_representation, validate
from review_receipts import hashed
import test_objective_claim_proofs as fixtures
import test_objective_dispositions as disposition_fixtures


def alternatives(body, context=None):
    schema = grounding.schema_for(body, grounding.CONDITIONAL_CONTRACT, source_context=context)
    return {b['properties']['factType']['enum'][0]: b
            for b in schema['properties']['moments']['items']['anyOf']}


class ConditionalSchemaTests(unittest.TestCase):
    def test_each_type_has_only_its_own_evidence_and_permitted_date_scope(self):
        body = ('Envoyé : 5 mai 2020\nJe vous envoie mon CV.\n'
                'Voici ma dernière version du code, à vérifier.\n'
                "Je travaille au projet le 12 mai 2020.\nJe démissionne de mon poste.\n"
                "Ma candidature est transmise.\nUn entretien d'embauche est proposé.\nUne offre d'emploi est reçue.")
        context = fixtures.context(body, mailDate='2020-05-05T12:30:00-04:00')
        before = copy.deepcopy(grounding.SCHEMA_V6)
        branches = alternatives(body, context)
        spans = grounding.catalog(body)
        kinds = {r['factType']: r['citationIds'] for r in grounding.proofs.fact_catalog(spans)}
        dates = grounding.dates.catalog(spans, context)
        communication = {r['id'] for r in dates if r['kind'] == 'communication'}
        event_dates = {r['id'] for r in dates if r['kind'] == 'event-expression'}
        self.assertTrue(communication)
        self.assertTrue(event_dates)
        self.assertEqual(set(branches), {'life-event', *kinds})
        for kind, branch in branches.items():
            props = branch['properties']
            self.assertEqual(next(iter(props)), 'factType')
            self.assertFalse(branch['additionalProperties'])
            self.assertEqual(set(branch['required']), set(props))
            if kind == 'life-event':
                self.assertEqual(props['factTypeCitationIds']['maxItems'], 0)
            else:
                self.assertEqual(props['factTypeCitationIds']['minItems'], 1)
                self.assertEqual(props['factTypeCitationIds']['items']['enum'], kinds[kind])
                self.assertEqual(props['category']['enum'], ['work'])
            for side in ('start', 'end'):
                allowed = set(props[side + 'DateRef']['enum'])
                expected = {None, *event_dates}
                if side == 'start' and kind in {'career-contact', 'application', 'work-correspondence'}:
                    expected |= communication
                self.assertEqual(allowed, expected, (kind, side))
            self.assertNotIn('startDate', props)
        self.assertEqual(grounding.SCHEMA_V6, before)

    def test_neutral_event_has_no_work_evidence_or_communication_date_choices(self):
        body = 'Envoyé : 5 mai 2020\nMon installation est terminée.'
        branches = alternatives(body, fixtures.context(body, mailDate='2020-05-05T10:00:00Z'))
        self.assertEqual(set(branches), {'life-event'})
        props = branches['life-event']['properties']
        self.assertEqual(props['startDateRef']['enum'], [None])
        self.assertEqual(props['endDateRef']['enum'], [None])
        self.assertEqual(props['factTypeCitationIds']['maxItems'], 0)
        self.assertEqual(props['hypotheses']['maxItems'], 0)

    def test_backend_ignoring_schema_still_cannot_borrow_header_or_work_evidence(self):
        body = 'Envoyé : 5 mai 2020\nMon installation est terminée.'
        raw = fixtures.response(body)
        raw['moments'][0]['observations'][0]['citationIds'] = ['q2']
        raw['moments'][0]['startDateRef'] = 'd1'
        with self.assertRaisesRegex(ValueError, 'communication date cannot date'):
            grounding.project(raw, body, grounding.CONDITIONAL_CONTRACT)
        raw['moments'][0]['startDateRef'] = None
        raw['moments'][0]['factTypeCitationIds'] = ['q2']
        with self.assertRaisesRegex(ValueError, 'neutral life-event'):
            grounding.project(raw, body, grounding.CONDITIONAL_CONTRACT)
        raw['moments'][0]['factTypeCitationIds'] = []
        result, _ = grounding.project(raw, body, grounding.CONDITIONAL_CONTRACT)
        validate(result, body)
        self.assertIsNone(result['moments'][0]['startDate'])

    def test_empty_passage_still_forbids_moments_and_absence_references(self):
        schema = grounding.schema_for(' \r\n', grounding.CONDITIONAL_CONTRACT)
        self.assertEqual(schema['properties']['moments']['maxItems'], 0)
        self.assertEqual(schema['properties']['summaryCitationIds']['maxItems'], 0)
        self.assertNotIn('no-explicit-uncertainty', json.dumps(schema))


class ContextualConditionTests(unittest.TestCase):
    def test_names_symbols_and_indirect_questions_do_not_supply_conditions(self):
        for body in ('Nous visitons Port Si Doré, puis une autre ville.',
                     'Le symbole Si est écrit sur le document.',
                     'Le studio IF organise une exposition.',
                     'Je me demande si nous partirons.',
                     'Je ne sais pas si le budget est accepté.',
                     'I wonder if they will come.'):
            with self.subTest(body=body):
                self.assertIn('condition', grounding.language.uncertainty_bases(body))
                self.assertNotIn('condition', uncertainty.bases(body))

    def test_real_clauses_and_other_uncertainties_remain_literal(self):
        for body in ('Nous réserverons si le budget est accepté.',
                     'Nous appellerons si on se perd.',
                     'Ou si je peux vous aider pour autre chose.',
                     'Si Marie arrive, nous partirons.',
                     'We will book if the budget is approved.',
                     'We will leave unless it rains.',
                     'Départ à condition de réserver.',
                     'Accord sous réserve de confirmation.',
                     'We can go provided that the office agrees.'):
            with self.subTest(body=body):
                self.assertIn('condition', uncertainty.bases(body))
        for body in ('Viendras-tu ?', 'Maybe next year.', 'Ce sera peut-être demain.'):
            self.assertEqual(uncertainty.bases(body), grounding.language.uncertainty_bases(body))
        self.assertEqual(uncertainty.bases('Si nous partons ' + 'x' * 450), [])

    def test_new_ids_bind_the_real_clause_in_schema_projection_and_summary(self):
        body = 'Nous visitons Port Si Doré.\nNous appellerons si on se perd.'
        rows = uncertainty.catalog(grounding.catalog(body))
        self.assertEqual([(r['id'], r['basis'], r['citationIds']) for r in rows],
                         [('u1', 'condition', ['q2'])])
        props = alternatives(body)['life-event']['properties']
        self.assertEqual(props['hypotheses']['items']['enum'], ['u1'])
        raw = fixtures.response(body)
        raw['moments'][0]['hypotheses'] = ['u1']
        raw['moments'][0]['observations'].append({'text': 'Un appel est prévu sous condition.', 'citationIds': ['q2']})
        result, changes = normalize_representation(raw, body, grounding.CONDITIONAL_CONTRACT)
        validate(result, body)
        self.assertIn('Condition citée, sans en déduire la réalisation : « Nous appellerons si on se perd. »', result['moments'][0]['relationHints'][0])
        self.assertNotIn('Port Si Doré', result['moments'][0]['relationHints'][0])
        self.assertEqual(changes[0]['contract'], grounding.CONDITIONAL_CONTRACT)
        self.assertEqual(changes[0]['factPolicy']['facts'][0]['uncertaintyRefs'], ['u1'])
        raw['moments'][0]['hypotheses'] = ['u2']
        with self.assertRaisesRegex(ValueError, 'categorized reference'):
            grounding.project(raw, body, grounding.CONDITIONAL_CONTRACT)

    def test_ignored_schema_cannot_reintroduce_a_name_only_condition(self):
        body = 'Nous visitons Port Si Doré.'
        raw = fixtures.response(body)
        raw['moments'][0]['hypotheses'] = ['u1']
        with self.assertRaisesRegex(ValueError, 'categorized reference'):
            grounding.project(raw, body, grounding.CONDITIONAL_CONTRACT)
        # Old results keep their literal original projection, including its
        # known lexical limitation; never reinterpret or rewrite an old read.
        result, changes = grounding.project(raw, body, grounding.PROOF_CONTRACT)
        self.assertIn('Condition citée', result['moments'][0]['relationHints'][0])
        self.assertEqual(changes[0]['contract'], grounding.PROOF_CONTRACT)

    def test_v5_schema_fingerprint_and_page_choices_remain_frozen(self):
        self.assertEqual(hashed(grounding.SCHEMA_V5), '3b60241755f9f97c0a0954a5d7fbd1afc9f0df283ed75585de5c88d1e15856f8')
        self.assertEqual(grounding.contract_for({'responseSchemaSha256': hashed(grounding.SCHEMA_V5)}), grounding.PROOF_CONTRACT)
        self.assertEqual(grounding.contract_for({'responseSchemaSha256': hashed(grounding.SCHEMA_V6)}), grounding.CONDITIONAL_CONTRACT)
        body = 'Envoyé : 5 mai 2020\nNous visitons Port Si Doré.'
        schema = grounding.schema_for(body, grounding.PROOF_CONTRACT)
        props = schema['properties']['moments']['items']['properties']
        self.assertEqual(props['hypotheses']['items']['enum'], ['u1'])
        self.assertEqual(props['startDateRef']['enum'], [None, 'd1'])


class ConditionalWorkerTests(unittest.TestCase):
    def setUp(self):
        fixtures.fixtures.SourceLanguageWorkerTests.setUp(self)
        frozen = patch.object(worker, 'SCHEMA', grounding.SCHEMA_V6)
        frozen.start(); self.addCleanup(frozen.stop)
    mail = fixtures.fixtures.SourceLanguageWorkerTests.mail
    prepare = fixtures.fixtures.SourceLanguageWorkerTests.prepare
    run_worker = fixtures.fixtures.SourceLanguageWorkerTests.run_worker

    def test_native_payload_and_receipt_use_same_contextual_catalog_and_resume_without_call(self):
        body = 'Nous visitons Port Si Doré.\nNous appellerons si on se perd.'
        self.mail('message01', body)
        def output(prompt, reply):
            self.assertEqual(prompt['groundingContract'], grounding.CONDITIONAL_CONTRACT)
            self.assertEqual(prompt['uncertaintyCatalog'], uncertainty.catalog(grounding.catalog(body)))
            self.assertEqual(prompt['uncertaintyCatalog'][0]['citationIds'], ['q2'])
            value = fixtures.response(body)
            value['moments'][0]['hypotheses'] = ['u1']
            reply['response'] = json.dumps(value)
            return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client)['newlyReviewedPages'], 1)
        objective, manifest = self.prepare()
        row = worker.read_receipt(next((objective / 'page-reviews').glob('*.json')), manifest)
        self.assertEqual(row['resultProcessing']['changes'][0]['contract'], grounding.CONDITIONAL_CONTRACT)
        self.assertEqual(self.run_worker(client)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        self.assertFalse(load(objective / 'findings.json')[0]['userConfirmed'])

    def test_frozen_v5_worker_retains_original_catalog_and_replays_under_new_code(self):
        body = 'Nous visitons Port Si Doré.'
        self.mail('message01', body)
        def output(prompt, reply):
            self.assertEqual(prompt['groundingContract'], grounding.PROOF_CONTRACT)
            self.assertEqual(prompt['uncertaintyCatalog'][0]['citationIds'], ['q1'])
            value = fixtures.response(body)
            value['moments'][0]['hypotheses'] = ['u1']
            reply['response'] = json.dumps(value)
            return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        with patch.object(worker, 'SCHEMA', grounding.SCHEMA_V5):
            self.assertEqual(self.run_worker(client)['newlyReviewedPages'], 1)
            objective, manifest = self.prepare()
        row = worker.read_receipt(next((objective / 'page-reviews').glob('*.json')), manifest)
        self.assertEqual(row['resultProcessing']['changes'][0]['contract'], grounding.PROOF_CONTRACT)
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
