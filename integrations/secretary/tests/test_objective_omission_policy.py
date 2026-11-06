"""Reason references cannot turn a personal activity into administrative noise."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_grounding as grounding
import objective_omission_policy as policy
import objective_review as worker
from evidence_store import load, save
from objective_schema import normalize_representation, validate
from review_receipts import hashed
from unittest.mock import patch
import test_objective_useful_selection as fixtures
import test_objective_dispositions as disposition_fixtures
import test_objective_source_language as worker_fixtures

CONTEXT = {'ownerAliases': ['Personne Exemple']}


def rows(body, context=CONTEXT):
    return policy.catalog(grounding.catalog(body), context)


def reason(body, scope, code, cue=None, context=CONTEXT):
    return next(r['id'] for r in rows(body, context) if r['scope'] == scope
                and r['reasonCode'] == code and r['citationId'] == cue)


def wire_v9(value, catalog):
    """Convert existing fake model fixtures, never fill a silently omitted cue."""
    value = copy.deepcopy(value)
    for item in value['omittedCues']:
        key, code = item['citationId'], item['reasonCode']
        selected = next(r for r in catalog if r['scope'] == 'cue' and r['citationId'] == key
                        and r['reasonCode'] == code)
        item.clear(); item.update(citationId=key, reasonRef=selected['id'])
    if value['abstention'] is not None:
        code = value['abstention']['reasonCode']
        options = [r for r in catalog if r['scope'] == 'passage']
        selected = next((r for r in options if r['reasonCode'] == code), options[-1] if options else
                        {'id': 'no-whole-passage-option', 'reasonCode': 'insufficient-event-context'})
        value['abstention'] = {'reasonRef': selected['id']}
        value['emptyAssessment'] = 'uncertain' if selected['reasonCode'] in fixtures.selection.UNCERTAIN else 'no-life-event'
    return value


def positive(body, ids=('q1',), context=CONTEXT):
    return wire_v9(fixtures.response(body, ids), rows(body, context))


def negative(body, code='insufficient-event-context', *, cue_codes=None, context=CONTEXT):
    return {'emptyAssessment': 'uncertain' if code in fixtures.selection.UNCERTAIN else 'no-life-event',
            'moments': [], 'gaps': [], 'summaryCitationIds': [],
            'omittedCues': [{'citationId': key, 'reasonRef': reason(body, 'cue', why, key, context)}
                            for key, why in (cue_codes or {}).items()],
            'abstention': {'reasonRef': reason(body, 'passage', code, context=context)}}


def project(value, body, context=CONTEXT):
    context = {'offset': 0, 'end': len(body), 'totalChars': len(body), **context}
    result, changes = normalize_representation(value, body, grounding.OMISSION_CONTRACT, context)
    validate(result, body)
    return result, changes


class OmissionCoherenceTests(unittest.TestCase):
    def test_personal_activities_cannot_be_administrative_even_with_a_separate_tax_header(self):
        for activity in ('Mon voyage est terminé.', "J'ai fait du snorkeling en vacances.",
                         'Je débute la boxe.', 'On va faire une randonnée demain.',
                         'Nous avons terminé notre formation.'):
            with self.subTest(activity=activity):
                body = activity + '\nObjet : copies PDF de la déclaration fiscale.'
                self.assertFalse(any(r['reasonCode'] == 'administrative-context' for r in rows(body)))
                raw = negative(body, cue_codes={'q1': 'insufficient-event-context'})
                raw['omittedCues'][0] = {'citationId': 'q1', 'reasonCode': 'administrative-context', 'contextCitationIds': ['q1', 'q2']}
                with self.assertRaisesRegex(ValueError, 'never a free reason code'): project(raw, body)

    def test_useful_activity_can_be_retained_without_a_date_or_be_explicitly_uncertain(self):
        body = "J'ai fait du snorkeling en vacances."
        result, _ = project(positive(body), body)
        self.assertEqual(len(result['moments']), 1)
        self.assertIsNone(result['moments'][0]['startDate'])
        raw = negative(body, cue_codes={'q1': 'ambiguous-actor'})
        result, changes = project(raw, body)
        self.assertEqual(result['moments'], [])
        self.assertEqual(result['classification'], 'uncertain')
        self.assertIn(body, result['gaps'][0])
        self.assertEqual(changes[0]['selectionReview']['omissions'][0]['reasonCode'], 'ambiguous-actor')

    def test_admin_reason_requires_actual_support_and_no_unresolved_personal_cue(self):
        body = 'Objet : copies PDF\nBonne soirée !'
        result, changes = project(negative(body, 'administrative-context'), body)
        self.assertEqual(result['classification'], 'no-life-event')
        self.assertIn('Objet : copies PDF', result['summary'])
        evidence = changes[0]['selectionReview']['abstention']['sourceSpans']
        self.assertEqual([r['id'] for r in evidence], ['q1'])
        for other in ('Un passage sans marqueur explicite.', 'Ce document ne contient aucune facture.'):
            self.assertFalse(any(r['reasonCode'] == 'administrative-context' for r in rows(other)))

    def test_a_greeting_alone_cannot_justify_dismissing_unclassified_content(self):
        body = 'Bonjour !\nUn récit dont le contexte reste à examiner.'
        self.assertFalse(any(r['reasonCode'] == 'non-biographical-context' for r in rows(body)))
        self.assertTrue(any(r['reasonCode'] == 'non-biographical-context' for r in rows('Bonjour !\nMerci !')))

    def test_an_unknown_or_cross_scope_or_cross_cue_reason_is_rejected(self):
        body = 'Je débute la boxe.\nOn va faire une randonnée.'
        raw = negative(body, cue_codes={'q1': 'ambiguous-actor', 'q2': 'insufficient-event-context'})
        for bad in ('unknown-reason', reason(body, 'passage', 'insufficient-event-context'),
                    reason(body, 'cue', 'ambiguous-actor', 'q2')):
            value = copy.deepcopy(raw); value['omittedCues'][0]['reasonRef'] = bad
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, 'own source-conditioned'): project(value, body)
        raw['abstention']['reasonRef'] = reason(body, 'cue', 'ambiguous-actor', 'q1')
        with self.assertRaises(ValueError): project(raw, body)

    def test_nonbiographical_label_needs_explicit_local_context_and_cannot_borrow_a_brochure(self):
        body = 'Je débute la boxe.\nNotre brochure décrit un voyage promotionnel.'
        self.assertFalse(any(r['reasonCode'] == 'non-biographical-context' and r['citationId'] == 'q1' for r in rows(body)))
        raw = positive(body); raw['omittedCues'] = [{'citationId': 'q2', 'reasonRef': reason(body, 'cue', 'non-biographical-context', 'q2')}]
        result, _ = project(raw, body)
        self.assertEqual(len(result['moments']), 1)
        self.assertIn('brochure', result['gaps'][0])
        negated = "Mon voyage n'est pas une fiction."
        self.assertFalse(any(r['reasonCode'] == 'non-biographical-context' for r in rows(negated)))

    def test_quoted_speaker_reason_includes_nearest_header_and_respects_owner_aliases(self):
        body = ('Je débute la boxe.\nFrom: Auteur Autre <other@example.invalid>\n'
                'On a fait des sauts.\nDe : Personne Exemple <owner@example.invalid>\nMon voyage est terminé.')
        other = [r for r in rows(body) if r['reasonCode'] == 'other-person-context']
        self.assertEqual([(r['citationId'], r['contextCitationIds']) for r in other], [('q3', ['q2', 'q3'])])
        raw = positive(body, ('q1', 'q5'))
        raw['omittedCues'] = [{'citationId': 'q3', 'reasonRef': other[0]['id']}]
        result, changes = project(raw, body)
        self.assertIn('From: Auteur Autre', result['gaps'][0])
        self.assertEqual(changes[0]['omissionPolicy']['selectedReasons'][0]['sourceSpans'][0]['text'], body.splitlines()[1])
        self.assertFalse(any(r['reasonCode'] == 'other-person-context' for r in rows(body, {})))

    def test_a_following_header_never_identifies_an_earlier_activity(self):
        body = 'On a fait des sauts.\nFrom: Auteur Autre <other@example.invalid>'
        self.assertFalse(any(r['reasonCode'] == 'other-person-context' for r in rows(body)))

    def test_a_new_unknown_quote_boundary_never_inherits_a_previous_named_speaker(self):
        for boundary in ('--- Original Message ---', 'De : ', 'Le 3 juin 2012'):
            body = 'From: Auteur Autre <other@example.invalid>\n' + boundary + '\nOn a fait des sauts.'
            with self.subTest(boundary=boundary):
                self.assertFalse(any(r['reasonCode'] == 'other-person-context' for r in rows(body)))

    def test_uncertain_personal_omissions_cannot_become_a_confident_negative(self):
        body = 'Mon voyage est terminé.'
        raw = negative(body, cue_codes={'q1': 'insufficient-event-context'});raw['emptyAssessment'] = 'no-life-event'
        with self.assertRaisesRegex(ValueError, 'remain uncertain'): project(raw, body)

    def test_empty_source_retains_real_absence_without_fabricated_citations(self):
        result, changes = project(negative(' ', 'no-readable-source'), ' ')
        self.assertEqual(result['classification'], 'uncertain')
        self.assertEqual(changes[0]['omissionPolicy']['selectedReasons'][0]['sourceSpans'], [])
        self.assertFalse(any(r['reasonCode'] == 'no-readable-source' for r in rows('Du texte.')))

    def test_dynamic_schema_binds_reason_references_to_their_cue_and_assessment(self):
        body = 'Je débute la boxe.\nNotre brochure décrit un voyage promotionnel.'
        schema = grounding.schema_for(body, grounding.OMISSION_CONTRACT, source_context=CONTEXT)
        self.assertEqual(len(schema['anyOf']), 2)
        choices = schema['anyOf'][0]['properties']['omittedCues']['items']['anyOf']
        for choice in choices:
            props = choice['properties'];key = props['citationId']['enum'][0]
            self.assertEqual(props['reasonRef']['enum'], [r['id'] for r in rows(body) if r['scope'] == 'cue' and r['citationId'] == key])
        self.assertNotIn('reasonCode', json.dumps(schema))

    def test_v8_inadequate_reason_stays_frozen_while_v9_rejects_it(self):
        self.assertEqual(hashed(grounding.SCHEMA_V8), '279ea576ee341ac498827a3f46121fdfa9b2ecddfcc14c5f78534b0503eabab2')
        body = "J'ai fait du snorkeling en vacances."
        old = fixtures.abstention(body, reason='administrative-context', omitted=[fixtures.omission('q1', 'administrative-context')])
        result, _ = normalize_representation(old, body, grounding.SELECTION_CONTRACT)
        self.assertEqual(result['classification'], 'no-life-event')
        with self.assertRaises(ValueError): project(old, body)


class OmissionPolicyWorkerTests(unittest.TestCase):
    def setUp(self):
        worker_fixtures.SourceLanguageWorkerTests.setUp(self)
        frozen = patch.object(worker, 'SCHEMA', grounding.SCHEMA_V9)
        frozen.start(); self.addCleanup(frozen.stop)
    mail = worker_fixtures.SourceLanguageWorkerTests.mail
    prepare = worker_fixtures.SourceLanguageWorkerTests.prepare
    run_worker = worker_fixtures.SourceLanguageWorkerTests.run_worker

    def test_native_owner_aliases_bind_quoted_speaker_choices_through_receipt_replay(self):
        owner = self.config['ownerAliases'][0]
        body = f'From: {owner}\nJe débute la boxe.\nFrom: Auteur Autre\nOn a fait des sauts.'
        self.mail('message01', body)
        def output(prompt, reply):
            options = [r for r in prompt['omissionReasonCatalog'] if r['reasonCode'] == 'other-person-context']
            self.assertEqual([(r['citationId'], r['contextCitationIds']) for r in options], [('q4', ['q3', 'q4'])])
            value = positive(body, ('q2',), context={'ownerAliases': [owner]})
            value['omittedCues'] = [{'citationId': 'q4', 'reasonRef': options[0]['id']}]
            reply['response'] = json.dumps(value);return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client)['newlyReviewedPages'], 1)
        objective, manifest = self.prepare();file = next((objective/'page-reviews').glob('*.json'))
        row = worker.read_receipt(file, manifest)
        self.assertEqual(row['resultProcessing']['changes'][0]['selectionReview']['omissions'][0]['sourceSpans'][0]['text'], 'From: Auteur Autre')
        self.assertEqual(self.run_worker(client)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        changed = copy.deepcopy(manifest);changed['config']['ownerAliases'] = ['Auteur Autre']
        with self.assertRaises(ValueError):worker.read_receipt(file, changed)

    def test_catalog_owner_context_and_exact_reason_proof_replay_without_another_call(self):
        body = 'Objet : copies PDF\nBonne soirée !';self.mail('message01', body)
        def output(prompt, reply):
            self.assertEqual(prompt['groundingContract'], grounding.OMISSION_CONTRACT)
            ref = next(r['id'] for r in prompt['omissionReasonCatalog'] if r['reasonCode'] == 'administrative-context')
            value = negative(body, 'administrative-context');value['abstention']['reasonRef'] = ref
            reply['response'] = json.dumps(value);return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client)['newlyReviewedPages'], 1)
        self.assertEqual(self.run_worker(client)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        objective, manifest = self.prepare();file = next((objective/'page-reviews').glob('*.json'))
        row = worker.read_receipt(file, manifest)
        row['resultProcessing']['changes'][0]['omissionPolicy']['selectedReasons'][0]['contextCitationIds'] = ['q999']
        save(file, row)
        with self.assertRaisesRegex(ValueError, 'retained native result'): worker.read_receipt(file, manifest)

    def test_incoherent_free_reason_is_retained_as_rejection_without_retry(self):
        body = "J'ai fait du snorkeling en vacances.";self.mail('message01', body)
        def output(prompt, reply):
            reply['response'] = json.dumps(fixtures.abstention(body, reason='administrative-context', omitted=[fixtures.omission('q1', 'administrative-context')]))
            return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['newlyRejectedPages'], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        objective, _ = self.prepare();self.assertEqual(load(objective/'findings.json'), [])


if __name__ == '__main__':
    unittest.main()
