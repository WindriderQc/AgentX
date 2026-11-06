"""Undated useful facts remain selectable; negative decisions need source evidence."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_grounding as grounding
import objective_useful_selection as selection
import objective_review as worker
from evidence_store import load, save
from objective_schema import normalize_representation, validate
from review_receipts import hashed
import test_objective_source_observations as fixtures
import test_objective_dispositions as disposition_fixtures


def wire_v8(value, body):
    """Fake model decisions; an unaccounted cue stays invalid, never auto-filled."""
    value = copy.deepcopy(value)
    value['omittedCues'] = [{'citationId': key, 'reasonCode': 'non-biographical-context',
                            'contextCitationIds': [key]} for key in value.pop('omittedCueIds')]
    value['abstention'] = None
    if not value['moments']:
        ids = [s['id'] for s in grounding.catalog(body)]
        value['abstention'] = {'reasonCode': 'non-biographical-context' if ids else 'no-readable-source',
                               'citationIds': ids[:1]}
        if not ids:
            value['emptyAssessment'] = 'uncertain'
    return value


def response(body, ids=('q1',), **extra):
    return wire_v8(fixtures.response(body, ids, **extra), body)


def abstention(body, reason='non-biographical-context', ids=('q1',), omitted=()):
    return {'emptyAssessment': 'uncertain' if reason in selection.UNCERTAIN else 'no-life-event',
            'moments': [], 'gaps': [], 'summaryCitationIds': [],
            'omittedCues': list(omitted), 'abstention': {'reasonCode': reason, 'citationIds': list(ids)}}


def omission(key, reason='non-biographical-context', context=None):
    return {'citationId': key, 'reasonCode': reason, 'contextCitationIds': context or [key]}


def project(value, body):
    result, changes = normalize_representation(value, body, grounding.SELECTION_CONTRACT)
    validate(result, body)
    return result, changes


class UsefulSelectionTests(unittest.TestCase):
    def test_nonprofessional_first_person_cues_need_no_absolute_date_or_place_dictionary(self):
        for body, kind in [('Je débute la boxe sur une île.', 'leisure'),
                           ('On va faire du trecking après-demain.', 'travel'),
                           ('Mon déménagement est terminé.', 'home'),
                           ('Je prévois de monter une petite structure.', 'plan'),
                           ('I am on a hiking trip.', 'travel'),
                           ('Nous avons terminé notre formation.', 'study')]:
            with self.subTest(body=body):
                rows = selection.cues(grounding.catalog(body))
                self.assertEqual(len(rows), 1)
                self.assertIn(kind, rows[0]['kinds'])
                self.assertEqual(rows[0]['text'], body)
                self.assertEqual(rows[0]['qualification'], 'reading-cue-only-not-an-event')
        for body in ('Objet : PDF annuel. Bonne soirée.', 'Votre voyage à prix réduit !',
                     'Is the trip on Monday?', 'Ton épaule est-elle guérie ?'):
            self.assertEqual(selection.cues(grounding.catalog(body)), [])

    def test_undated_travel_and_plans_are_retained_as_exact_source_facts(self):
        body = 'Je débute la boxe dans une autre région.\nOn va faire du trekking après-demain.'
        raw = response(body, ('q1', 'q2'), category='travel')
        before = copy.deepcopy(raw)
        result, changes = project(raw, body)
        self.assertEqual(raw, before)
        self.assertIsNone(result['moments'][0]['startDate'])
        self.assertIn('après-demain', result['moments'][0]['description'])
        self.assertEqual([r['disposition'] for r in changes[0]['selectionReview']['cues']],
                         ['cited-observation', 'cited-observation'])

    def test_silent_travel_abstention_refuses_even_with_a_global_negative_reason(self):
        body = 'Je débute la boxe.\nOn va faire une randonnée demain.'
        with self.assertRaisesRegex(ValueError, 'potentially useful source cue'):
            project(abstention(body), body)

    def test_a_lexical_cue_can_be_omitted_with_evidence_without_inventing_an_event(self):
        body = 'Notre brochure décrit un voyage promotionnel.'
        raw = abstention(body, omitted=[omission('q1')])
        result, changes = project(raw, body)
        self.assertEqual(result['moments'], [])
        self.assertIn(body, result['summary'])
        self.assertIn('proposé à relire', result['summary'])
        self.assertEqual(changes[0]['selectionReview']['cues'][0]['disposition'], 'reasoned-omission')
        self.assertEqual(changes[0]['selectionReview']['omissions'][0]['sourceSpans'][0]['text'], body)

    def test_partial_omission_needs_its_own_context_and_cannot_overlap_a_retained_cue(self):
        body = 'Je débute la boxe.\nNotre brochure décrit un voyage promotionnel.\nUn simple contexte.'
        raw = response(body);raw['omittedCues'] = [omission('q2', context=['q3'])]
        with self.assertRaisesRegex(ValueError, 'include the cue'): project(raw, body)
        raw['omittedCues'] = [omission('q2')]
        result, changes = project(raw, body)
        self.assertEqual(len(result['moments']), 1)
        self.assertIn('voyage promotionnel', result['gaps'][0])
        self.assertEqual(changes[0]['selectionReview']['omissions'][0]['citationId'], 'q2')
        raw['omittedCues'] = [omission('q1'), omission('q2')]
        with self.assertRaisesRegex(ValueError, 'both cited and omitted'): project(raw, body)

    def test_unknown_duplicate_or_uncited_omission_reasons_fail_closed(self):
        body = 'Je débute la boxe.\nOn va faire une randonnée.'
        for rows in ([omission('q999')], [omission('q1'), omission('q1')],
                     [omission('q1', reason='unknown-date'), omission('q2')],
                     [omission('q1', context=['q999']), omission('q2')]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                project(abstention(body, omitted=rows), body)

    def test_administrative_abstention_is_cited_even_when_no_reading_cue_exists(self):
        body = 'Objet : copies PDF\nBonne soirée.'
        raw = abstention(body, reason='administrative-context')
        result, changes = project(raw, body)
        self.assertEqual(result['classification'], 'no-life-event')
        self.assertEqual(result['moments'], [])
        self.assertIn('échange administratif', result['summary'])
        self.assertIn('Objet : copies PDF', result['summary'])
        self.assertEqual(changes[0]['selectionReview']['abstention']['sourceSpans'][0]['id'], 'q1')
        for bad in (None, {'reasonCode': 'administrative-context', 'citationIds': []},
                    {'reasonCode': 'administrative-context', 'citationIds': ['q999']},
                    {'reasonCode': 'administrative-context', 'citationIds': ['q1'], 'text': 'Un faux motif libre.'}):
            raw = abstention(body);raw['abstention'] = bad
            with self.assertRaises(ValueError): project(raw, body)

    def test_ambiguous_abstention_remains_uncertain_instead_of_claiming_no_event(self):
        body = 'Un départ serait envisagé, acteur non identifié.'
        raw = abstention(body, reason='ambiguous-actor')
        result, _ = project(raw, body)
        self.assertEqual(result['classification'], 'uncertain')
        raw['emptyAssessment'] = 'no-life-event'
        with self.assertRaisesRegex(ValueError, 'remain uncertain'): project(raw, body)

    def test_empty_text_has_no_fabricated_evidence_and_readable_text_cannot_be_absent(self):
        result, _ = project(abstention(' ', reason='no-readable-source', ids=()), ' ')
        self.assertEqual(result['classification'], 'uncertain')
        self.assertEqual(result['moments'], [])
        with self.assertRaisesRegex(ValueError, 'cannot be justified as absent'):
            project(abstention('Du texte lisible.', reason='no-readable-source', ids=()), 'Du texte lisible.')
        schema = grounding.schema_for(' ', grounding.SELECTION_CONTRACT)
        self.assertEqual(len(schema['anyOf']), 1)
        branch = schema['anyOf'][0]['properties']
        self.assertEqual(branch['moments']['maxItems'], 0)
        self.assertEqual(branch['abstention']['properties']['citationIds']['maxItems'], 0)
        self.assertNotIn('no-source-span', json.dumps(schema))

    def test_long_negative_evidence_is_never_cut_before_negation_or_condition(self):
        body = 'Le document ' + 'descriptif ' * 260 + 'ne décrit pas un événement personnel.'
        result, changes = project(abstention(body), body)
        self.assertLessEqual(len(result['summary']), 2000)
        self.assertIn(body, result['gaps'][0])
        self.assertFalse(changes[0]['selectionReview']['abstentionExcerptsRenderedInSummary'])

    def test_nonempty_selection_cannot_also_declare_global_abstention(self):
        body = 'Mon déménagement est terminé.'
        raw = response(body);raw['abstention'] = {'reasonCode': 'non-biographical-context', 'citationIds': ['q1']}
        with self.assertRaisesRegex(ValueError, 'cannot also declare abstention'): project(raw, body)

    def test_v7_schema_and_unjustified_native_abstention_stay_frozen(self):
        self.assertEqual(hashed(grounding.SCHEMA_V7), '3a7551bbc02b8aad5c76f9414939f348888d80943e2cb2eb7a12cc8a3dc76899')
        self.assertEqual(grounding.contract_for({'responseSchemaSha256': hashed(grounding.SCHEMA_V7)}), grounding.SOURCE_CONTRACT)
        body = 'Je débute la boxe.'
        old = {'emptyAssessment': 'no-life-event', 'moments': [], 'gaps': [], 'summaryCitationIds': [], 'omittedCueIds': []}
        result, changes = normalize_representation(old, body, grounding.SOURCE_CONTRACT)
        self.assertEqual(result['summary'], 'Aucun événement proposé dans ce passage.')
        self.assertNotIn('selectionReview', changes[0])
        with self.assertRaises(ValueError): project(old, body)


class UsefulSelectionWorkerTests(unittest.TestCase):
    def setUp(self):
        fixtures.fixtures.fixtures.SourceLanguageWorkerTests.setUp(self)
        frozen = patch.object(worker, 'SCHEMA', grounding.SCHEMA_V8)
        frozen.start(); self.addCleanup(frozen.stop)
    mail = fixtures.fixtures.fixtures.SourceLanguageWorkerTests.mail
    prepare = fixtures.fixtures.fixtures.SourceLanguageWorkerTests.prepare
    run_worker = fixtures.fixtures.fixtures.SourceLanguageWorkerTests.run_worker

    def test_payload_cues_and_negative_reason_replay_without_model_retry(self):
        body = 'Notre brochure décrit un voyage promotionnel.'
        self.mail('message01', body)
        def output(prompt, reply):
            self.assertEqual(prompt['groundingContract'], grounding.SELECTION_CONTRACT)
            self.assertIn('travel', prompt['selectionCues'][0]['kinds'])
            reply['response'] = json.dumps(abstention(body, omitted=[omission('q1')]))
            return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client)['newlyReviewedPages'], 1)
        objective, manifest = self.prepare();file = next((objective/'page-reviews').glob('*.json'))
        row = worker.read_receipt(file, manifest)
        self.assertEqual(row['resultProcessing']['changes'][0]['selectionReview']['abstention']['reasonCode'], 'non-biographical-context')
        self.assertEqual(self.run_worker(client)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        row['resultProcessing']['changes'][0]['selectionReview']['abstention']['reasonCode'] = 'administrative-context'
        save(file, row)
        with self.assertRaisesRegex(ValueError, 'retained native result'): worker.read_receipt(file, manifest)

    def test_silent_abstention_is_retained_as_rejection_without_another_call(self):
        body = 'On va faire une randonnée après-demain.'
        self.mail('message01', body)
        def output(prompt, reply):
            reply['response'] = json.dumps(abstention(body))
            return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['newlyRejectedPages'], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        objective, _ = self.prepare();self.assertEqual(load(objective/'findings.json'), [])


if __name__ == '__main__':
    unittest.main()
