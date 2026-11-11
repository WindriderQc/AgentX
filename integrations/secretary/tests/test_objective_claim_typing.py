"""Literal reports and plans are separate from personal confirmation."""
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
from objective_schema import normalize_representation, validate
from review_receipts import hashed
import test_objective_anchored_facts as previous
import test_objective_dispositions as disposition_fixtures
import test_objective_source_language as worker_fixtures

SENT = previous.SENT


def wire_v13(value):
    """Translate supplied choices exactly; never promote an old hypothesis."""
    value = copy.deepcopy(value)
    for _, moment in grounding.claim_typing._moments(value):
        choice = moment.pop('claimType')
        moment['sourceClaimType'] = {'direct': 'direct-source', 'hypothesis': 'interpretation'}[choice]
    return value


def moment(anchor, *, category='travel', status='reported', source='direct-source'):
    value = previous.moment(anchor, category=category, status=status)
    value.pop('claimType');value['sourceClaimType'] = source
    return value


def project(value, body, context=SENT):
    result, changes = normalize_representation(value, body, grounding.CLAIM_CONTRACT,
        {'end': len(body), 'totalChars': len(body), **context})
    validate(result, body)
    return result, changes


def travel():
    body = "J'ai fait du snorkeling.\nJe débute la boxe.\nOn va faire une randonnée... Attention si on se perd !"
    value = previous.raw({'q1': [moment('q1')], 'q2': [moment('q2')],
                          'q3': [moment('q3', status='planned')]})
    return body, value


class SourceClaimTypingTests(unittest.TestCase):
    def test_all_three_explicit_travel_declarations_require_a_direct_source_choice(self):
        body, value = travel();schema = grounding.schema_for(body, grounding.CLAIM_CONTRACT, source_context=SENT)
        props = schema['anyOf'][0]['properties']['cueDecisions']['properties']
        for key in ('q1', 'q2', 'q3'):
            fields = props[key]['properties']['retainedMoments']['items']['anyOf'][0]['properties']
            self.assertEqual(fields['sourceClaimType']['enum'], ['direct-source'])
            self.assertNotIn('claimType', fields)
        before = copy.deepcopy(value);result, changes = project(value, body)
        self.assertEqual(value, before)
        self.assertEqual([m['claimType'] for m in result['moments']], ['direct'] * 3)
        self.assertEqual([m['occurrenceStatus'] for m in result['moments']], ['reported', 'reported', 'planned'])
        self.assertTrue(all(m['startDate'] is None and m['endDate'] is None and not m['ongoing'] for m in result['moments']))
        self.assertFalse(changes[0]['claimTyping']['ownerConfirmation'])
        self.assertEqual(changes[0]['retainedSummary']['citationIds'], ['q1', 'q2', 'q3'])

    def test_unknown_dates_or_pending_review_cannot_relabel_a_complete_statement(self):
        body, value = travel()
        for key in ('q1', 'q2', 'q3'):
            native = copy.deepcopy(value);native['cueDecisions'][key]['retainedMoments'][0]['sourceClaimType'] = 'interpretation'
            before = copy.deepcopy(native)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'unknown dates or pending owner review'):
                project(native, body)
            self.assertEqual(native, before)

    def test_mixed_page_with_unresolved_container_actor_still_has_three_literal_declarations(self):
        body, value = travel();context = {**SENT, 'direction': 'unknown'}
        rows = grounding.claim_typing.catalog(grounding.catalog(body), context)
        self.assertEqual([r['citationId'] for r in rows], ['q1', 'q2', 'q3'])
        self.assertTrue(all(not r['ownerReadingContext'] for r in rows))
        for choice in value['cueDecisions'].values():
            choice['retainedMoments'][0]['subject'] = 'unknown'
        result, _ = project(value, body, context)
        self.assertEqual([m['claimType'] for m in result['moments']], ['direct'] * 3)
        self.assertEqual([m['subject'] for m in result['moments']], ['unknown'] * 3)

    def test_the_separate_conditional_warning_stays_local_and_does_not_confirm_a_plan(self):
        body, value = travel()
        ref = grounding.source_observations.qualification_catalog(grounding.catalog(body))[0]['id']
        value['cueDecisions']['q3']['retainedMoments'][0]['qualificationIds'] = [ref]
        result, changes = project(value, body)
        self.assertEqual([m['relationHints'] for m in result['moments'][:2]], [[], []])
        self.assertEqual(result['moments'][2]['occurrenceStatus'], 'planned')
        self.assertIn('si on se perd', result['moments'][2]['relationHints'][0])
        fact = changes[0]['factPolicy']['facts'][2]
        self.assertEqual(fact['sourceQualifications'][0]['citationId'], 'q3')
        self.assertTrue(changes[0]['claimTyping']['localReservationsPreserved'])

    def test_questions_possibilities_conditions_negations_and_promotions_keep_interpretation_choices(self):
        for body in ('Si la météo est bonne, on va faire une randonnée.',
                     'On va faire une randonnée ?', 'Je ferai peut-être une randonnée.',
                     'Je ne suis pas en voyage.', 'Notre brochure : je suis en voyage.'):
            with self.subTest(body=body):
                self.assertEqual(grounding.claim_typing.catalog(grounding.catalog(body), SENT), [])
                schema = grounding.schema_for(body, grounding.CLAIM_CONTRACT, source_context=SENT)
                cue = schema['anyOf'][0]['properties']['cueDecisions']['properties']['q1']
                retain = cue.get('anyOf', [cue])[0]
                fields = retain['properties']['retainedMoments']['items']['anyOf'][0]['properties']
                self.assertIn('interpretation', fields['sourceClaimType']['enum'])

    def test_unknown_speaker_or_continuation_does_not_gain_a_verified_actor(self):
        body = 'Mon voyage...'
        for context in ({**SENT, 'direction': 'received'},
                        {**SENT, 'offset': 200, 'end': 200 + len(body), 'totalChars': 400}):
            value = previous.raw({'q1': [moment('q1', source='interpretation')]})
            value['cueDecisions']['q1']['retainedMoments'][0]['subject'] = 'unknown'
            with self.subTest(context=context):
                result, changes = project(value, body, context)
                self.assertEqual(result['moments'][0]['subject'], 'unknown')
                self.assertEqual(result['moments'][0]['claimType'], 'hypothesis')
                self.assertFalse(changes[0]['claimTyping']['selections'][0]['explicitDeclarationCue'])

    def test_quoted_or_unresolved_speakers_keep_literal_typing_without_an_owner_identity(self):
        for body, key in [('From: Auteur Autre\nJe débute la boxe.', 'q2'),
                          ('Je débute la boxe.\nFrom: Personne Exemple', 'q1')]:
            context = {**SENT, 'direction': 'received'}
            with self.subTest(body=body):
                rows = grounding.claim_typing.catalog(grounding.catalog(body), context)
                self.assertEqual(rows[0]['citationId'], key)
                self.assertFalse(rows[0]['ownerReadingContext'])
                value = previous.raw({key: [moment(key)]})
                value['cueDecisions'][key]['retainedMoments'][0]['subject'] = 'unknown'
                result, changes = project(value, body, context)
                self.assertEqual(result['moments'][0]['subject'], 'unknown')
                self.assertEqual(result['moments'][0]['claimType'], 'direct')
                self.assertFalse(changes[0]['claimTyping']['ownerConfirmation'])

    def test_a_direct_source_choice_preserves_an_unknown_actor_and_unconfirmed_dates(self):
        body = 'Je débute la boxe.';value = previous.raw({'q1': [moment('q1')]})
        value['cueDecisions']['q1']['retainedMoments'][0]['subject'] = 'unknown'
        result, changes = project(value, body)
        self.assertEqual(result['moments'][0]['subject'], 'unknown')
        self.assertEqual(result['moments'][0]['claimType'], 'direct')
        self.assertIsNone(result['moments'][0]['startDate'])
        self.assertEqual(changes[0]['claimTyping']['typingScope'], 'source-wording-not-world-or-owner-confirmation')

    def test_literal_source_possibility_keeps_its_reservation_even_when_direct(self):
        body = 'Je ferai peut-être une randonnée.'
        value = previous.raw({'q1': [moment('q1', status='planned')]})
        ref = grounding.source_observations.qualification_catalog(grounding.catalog(body))[0]['id']
        value['cueDecisions']['q1']['retainedMoments'][0]['qualificationIds'] = [ref]
        result, _ = project(value, body)
        self.assertEqual(result['moments'][0]['claimType'], 'direct')
        self.assertIn('peut-être', result['moments'][0]['relationHints'][0])
        self.assertEqual(result['moments'][0]['occurrenceStatus'], 'planned')

    def test_invalid_confirmation_modes_and_parallel_legacy_labels_fail_closed(self):
        body = 'Je débute la boxe.'
        for mode in ('confirmed', 'owner-confirmed', 'direct', None, True):
            value = previous.raw({'q1': [moment('q1', source=mode)]})
            with self.subTest(mode=mode), self.assertRaises(ValueError):project(value, body)
        value = previous.raw({'q1': [moment('q1')]});value['cueDecisions']['q1']['retainedMoments'][0]['claimType'] = 'direct'
        with self.assertRaisesRegex(ValueError, 'independent legacy confidence'):project(value, body)

    def test_completed_home_metadata_and_summary_do_not_regress(self):
        body = 'Mon déménagement étant terminé, je serai disponible plus tard.'
        result, changes = project(previous.raw({'q1': [moment('q1', category='home')]}), body)
        home = result['moments'][0]
        self.assertEqual((home['category'], home['occurrenceStatus'], home['claimType']), ('home', 'reported', 'direct'))
        self.assertIsNone(home['startDate']);self.assertIsNone(home['endDate'])
        self.assertIn(body, result['summary'])
        native = changes[0]['anchoredFacts']['nativeCueDecisions']['q1']['retainedMoments'][0]
        self.assertEqual(native['sourceClaimType'], 'direct-source');self.assertNotIn('claimType', native)

    def test_additional_fact_keeps_its_native_reading_choice_and_primary_type_evidence(self):
        body = 'Voici la dernière version du code.'
        native = previous.moment('q1', kind='work-correspondence', category='work')
        value = wire_v13(previous.raw(additional=[native]));value['additionalMoments'][0]['sourceClaimType'] = 'interpretation'
        result, changes = project(value, body)
        self.assertEqual(result['moments'][0]['claimType'], 'hypothesis')
        self.assertEqual(changes[0]['anchoredFacts']['bindings'][0]['factTypeCitationIds'], ['q1'])
        self.assertEqual(changes[0]['claimTyping']['selections'][0]['path'], 'additionalMoments/0')

    def test_administrative_abstention_is_unmodified_and_has_no_confirmation(self):
        import test_objective_omission_policy as omissions
        import test_objective_explicit_selection as v10
        import test_objective_cue_decisions as v11
        body = 'Objet : copies PDF'
        value = wire_v13(previous.wire_v12(v11.wire_v11(v10.wire_v10(omissions.negative(body, 'administrative-context')), body), body))
        result, changes = project(value, body)
        self.assertEqual(result['moments'], []);self.assertIn('copies PDF', result['summary'])
        self.assertEqual(changes[0]['claimTyping']['selections'], [])

    def test_frozen_v12_hypotheses_are_neither_upgraded_nor_accepted_as_new_wire(self):
        self.assertEqual(hashed(grounding.SCHEMA_V12), 'e10a9117bd7445106e1709e04d0a124d1d32bcee83f96ace55dde5dc8918fad7')
        body = 'Je débute la boxe.';old = previous.raw({'q1': [previous.moment('q1')]})
        old['cueDecisions']['q1']['retainedMoments'][0]['claimType'] = 'hypothesis';before = copy.deepcopy(old)
        result, changes = previous.project(old, body)
        self.assertEqual(result['moments'][0]['claimType'], 'hypothesis')
        self.assertEqual(changes[0]['contract'], grounding.ANCHORED_CONTRACT)
        self.assertEqual(grounding.contract_for({'responseSchemaSha256': hashed(grounding.SCHEMA_V12)}), grounding.ANCHORED_CONTRACT)
        with self.assertRaises(ValueError):project(old, body)
        self.assertEqual(old, before)


class SourceClaimTypingWorkerTests(unittest.TestCase):
    def setUp(self):
        worker_fixtures.SourceLanguageWorkerTests.setUp(self)
        frozen = patch.object(worker, "SCHEMA", grounding.SCHEMA_V13)
        frozen.start();self.addCleanup(frozen.stop)
    mail = worker_fixtures.SourceLanguageWorkerTests.mail
    prepare = worker_fixtures.SourceLanguageWorkerTests.prepare
    run_worker = worker_fixtures.SourceLanguageWorkerTests.run_worker

    def test_native_typing_replays_exactly_and_tampering_cannot_change_personal_confirmation(self):
        body = 'Je débute la boxe.';self.mail('message01', body)
        def output(prompt, reply):
            self.assertEqual(prompt['groundingContract'], grounding.CLAIM_CONTRACT)
            self.assertEqual(prompt['sourceClaimCatalog'][0]['citationId'], 'q1')
            self.assertFalse(prompt['sourceClaimCatalog'][0]['ownerConfirmation'])
            reply['response'] = json.dumps(previous.raw({'q1': [moment('q1')]}));return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client)['newlyReviewedPages'], 1)
        self.assertEqual(self.run_worker(client)['inferenceCalls'], 0);self.assertEqual(len(calls), 1)
        objective, manifest = self.prepare();path = next((objective / 'page-reviews').glob('*.json'));row = worker.read_receipt(path, manifest)
        row['resultProcessing']['changes'][0]['claimTyping']['ownerConfirmation'] = True;save(path, row)
        with self.assertRaisesRegex(ValueError, 'retained native result'):worker.read_receipt(path, manifest)

    def test_overcautious_new_native_choice_is_a_rejection_without_repair_or_retry(self):
        body = 'Je débute la boxe.';self.mail('message01', body)
        def output(prompt, reply):
            reply['response'] = json.dumps(previous.raw({'q1': [moment('q1', source='interpretation')]}));return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['newlyRejectedPages'], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['inferenceCalls'], 0);self.assertEqual(len(calls), 1)
        objective, _ = self.prepare();self.assertEqual(load(objective / 'findings.json'), [])


if __name__ == '__main__':unittest.main()
