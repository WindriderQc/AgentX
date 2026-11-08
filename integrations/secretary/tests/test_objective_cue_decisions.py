"""The native model must explicitly retain or omit every useful cue."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_cue_decisions as decisions
import objective_grounding as grounding
import objective_review as worker
from evidence_store import load, save
from objective_schema import normalize_representation, validate
from review_receipts import hashed
import test_objective_explicit_selection as previous
import test_objective_omission_policy as omission_fixtures
import test_objective_dispositions as disposition_fixtures
import test_objective_source_language as worker_fixtures

SENT = previous.SENT


def wire_v11(value, body):
    """Translate selections only; never fill a missing cue or invent a moment."""
    value = copy.deepcopy(value)
    cues = {s['id'] for s in grounding.useful_selection.cues(grounding.catalog(body))}
    selected = {}
    for index, moment in enumerate(value['moments']):
        context = []
        for row in moment.pop('observations'):
            if row['citationId'] in cues:
                selected.setdefault(row['citationId'], {'retentions': []})['retentions'].append(
                    {'momentIndex': index, 'qualificationIds': row['qualificationIds']})
            else:
                context.append(row)
        moment['contextObservations'] = context
    for row in value.pop('omittedCues'):
        selected[row['citationId']] = {'reasonRef': row['reasonRef']}
    value['cueDecisions'] = selected
    return value


def positive(body, ids=('q1',), context=SENT):
    return wire_v11(previous.positive(body, ids, context), body)


def project(value, body, context=SENT):
    result, changes = normalize_representation(value, body, grounding.CUE_CONTRACT,
        {'end': len(body), 'totalChars': len(body), **context})
    validate(result, body)
    return result, changes


class CueDecisionTests(unittest.TestCase):
    def test_schema_requires_each_cue_and_protects_complete_personal_activities(self):
        body = "J'ai pratiqué le snorkeling.\nJe débute la boxe.\nObjet : copies PDF"
        schema = grounding.schema_for(body, grounding.CUE_CONTRACT, source_context=SENT)
        self.assertEqual(len(schema['anyOf']), 1)
        props = schema['anyOf'][0]['properties']
        self.assertEqual(props['cueDecisions']['required'], ['q1', 'q2'])
        self.assertFalse(props['cueDecisions']['additionalProperties'])
        for row in props['cueDecisions']['properties'].values():
            self.assertEqual(row['required'], ['retentions'])
        self.assertNotIn('omittedCues', props)
        for moment in props['moments']['items']['anyOf']:
            self.assertNotIn('observations', moment['properties'])
            self.assertEqual(moment['properties']['contextObservations']['items']['anyOf'][0]
                ['properties']['citationId']['enum'], ['q3'])

    def test_all_retained_decisions_bind_actual_moments_and_exact_source_excerpts(self):
        body = "J'ai pratiqué le snorkeling.\r\nJe débute la boxe."
        raw = positive(body, ('q1', 'q2')); before = copy.deepcopy(raw)
        result, changes = project(raw, body)
        self.assertEqual(raw, before)
        self.assertEqual(len(result['moments']), 1)
        self.assertEqual(result['moments'][0]['quotes'], body.split('\r\n'))
        self.assertEqual(changes[0]['cueDecisions']['requiredCitationIds'], ['q1', 'q2'])
        self.assertEqual(changes[0]['cueDecisions']['locallyCreatedMoments'], 0)
        self.assertIsNone(result['moments'][0]['startDate'])
        self.assertFalse(result['moments'][0]['ongoing'])

    def test_missing_and_extra_decisions_reject_without_salvaging_other_moments(self):
        body = "J'ai fait du snorkeling.\nJe débute la boxe."
        for raw in (positive(body, ('q2',)), positive(body, ('q1', 'q2'))):
            if len(raw['cueDecisions']) == 2:
                raw['cueDecisions']['q999'] = {'retentions': []}
            before = copy.deepcopy(raw)
            with self.assertRaisesRegex(ValueError, 'exactly one explicit decision'):
                project(raw, body)
            self.assertEqual(raw, before)

    def test_decision_cannot_invent_a_moment_or_duplicate_its_assignment(self):
        body = 'Mon déménagement est terminé.'
        for index in (-1, 1, 999, True, '0', None):
            raw = positive(body);raw['cueDecisions']['q1']['retentions'][0]['momentIndex'] = index
            with self.subTest(index=index), self.assertRaisesRegex(ValueError, 'existing moment'):
                project(raw, body)
        raw = positive(body);raw['cueDecisions']['q1']['retentions'] *= 2
        with self.assertRaisesRegex(ValueError, 'distinct existing moment'): project(raw, body)

    def test_context_observations_cannot_duplicate_or_bypass_a_cue_decision(self):
        body = 'Mon déménagement est terminé.\nUn contexte complémentaire.'
        raw = positive(body)
        raw['moments'][0]['contextObservations'] = [{'citationId': 'q1', 'qualificationIds': []}]
        with self.assertRaisesRegex(ValueError, 'cannot bypass'): project(raw, body)
        raw = positive(body);raw['moments'][0]['observations'] = []
        with self.assertRaisesRegex(ValueError, 'parallel observation'): project(raw, body)

    def test_noncues_can_support_a_fact_without_becoming_a_lexical_event(self):
        body = 'Un fait explicitement choisi dans la source.'
        raw = positive(body)
        self.assertEqual(raw['cueDecisions'], {})
        result, _ = project(raw, body)
        self.assertEqual(result['moments'][0]['quotes'], [body])

    def test_completed_move_and_summary_use_only_explicitly_retained_observations(self):
        body = 'Mon déménagement étant terminé, je serai disponible plus tard.'
        result, changes = project(positive(body), body)
        self.assertIsNone(result['moments'][0]['startDate'])
        self.assertIsNone(result['moments'][0]['endDate'])
        self.assertIn(body, result['summary'])
        self.assertEqual(changes[0]['retainedSummary']['citationIds'], ['q1'])

    def test_separate_warning_does_not_allow_omitting_or_realizing_a_complete_plan(self):
        body = "Après-demain on va faire une randonnée... Attention à la chaleur si on se perd !"
        declarations = decisions.declarations(grounding.catalog(body), SENT)
        self.assertEqual(len(declarations), 1)
        self.assertEqual(declarations[0]['planSpan']['text'], 'Après-demain on va faire une randonnée')
        self.assertEqual(decisions.catalog(grounding.catalog(body), SENT), [])
        raw = positive(body);raw['moments'][0]['occurrenceStatus'] = 'planned'
        result, changes = project(raw, body)
        self.assertEqual(result['moments'][0]['occurrenceStatus'], 'planned')
        self.assertEqual(result['moments'][0]['quotes'], [body])
        self.assertIsNone(result['moments'][0]['startDate'])
        self.assertEqual(changes[0]['cueDecisions']['planDeclarations'][0]['citationId'], 'q1')
        raw['moments'][0]['occurrenceStatus'] = 'reported'
        with self.assertRaisesRegex(ValueError, 'future plan'): project(raw, body)

    def test_conditional_plans_questions_negation_and_promotions_keep_uncertain_options(self):
        for body in ('Si la météo est bonne, on va faire une randonnée.',
                     'On va faire une randonnée ?', 'Je ne vais pas faire cette randonnée.',
                     'Je prévois peut-être une randonnée.', 'Notre brochure : on va faire une randonnée.'):
            with self.subTest(body=body):
                self.assertFalse(decisions.declarations(grounding.catalog(body), SENT))
                self.assertTrue(decisions.catalog(grounding.catalog(body), SENT))

    def test_plan_context_does_not_cross_a_quote_or_borrow_a_following_header(self):
        for body in ('From: Auteur Autre\nOn va faire une randonnée.',
                     'On va faire une randonnée.\nFrom: Personne Exemple'):
            context = {**SENT, 'direction': 'received'}
            plan = decisions.declarations(grounding.catalog(body), context)[0]
            self.assertFalse(plan['ownerReadingContext'])
            self.assertTrue(decisions.catalog(grounding.catalog(body), context))

    def test_an_unrelated_later_topic_does_not_turn_a_vague_prefix_into_a_protected_plan(self):
        body = 'On va vérifier... Une randonnée serait possible.'
        self.assertTrue(grounding.useful_selection.cues(grounding.catalog(body)))
        self.assertEqual(decisions.declarations(grounding.catalog(body), SENT), [])

    def test_whole_passage_abstention_cannot_erase_an_explicit_plan(self):
        body = 'On va faire une randonnée... Attention si on se perd !'
        old = omission_fixtures.negative(body, cue_codes={'q1': 'ambiguous-actor'}, context=SENT)
        raw = wire_v11(previous.wire_v10(old), body)
        with self.assertRaisesRegex(ValueError, 'whole-passage abstention'): project(raw, body)

    def test_one_native_cue_can_support_multiple_explicitly_proposed_moments(self):
        body = "J'ai fait du snorkeling puis je débute la boxe."
        raw = positive(body);raw['moments'].append(copy.deepcopy(raw['moments'][0]))
        raw['cueDecisions']['q1']['retentions'].append({'momentIndex': 1, 'qualificationIds': []})
        result, changes = project(raw, body)
        self.assertEqual(len(result['moments']), 2)
        self.assertEqual([r['momentIndex'] for r in changes[0]['cueDecisions']['retainedBindings']], [0, 1])

    def test_an_omitted_cue_cannot_become_another_facts_title_or_summary(self):
        body = 'Je débute la boxe.\nNotre brochure décrit un voyage promotionnel.'
        raw = positive(body)
        reason = next(r for r in decisions.catalog(grounding.catalog(body), SENT)
                      if r['citationId'] == 'q2' and r['reasonCode'] == 'non-biographical-context')
        raw['cueDecisions']['q2'] = {'reasonRef': reason['id']}
        result, _ = project(raw, body)
        self.assertNotIn('brochure', result['summary'])
        raw['moments'][0]['titleCitationId'] = 'q2'
        with self.assertRaisesRegex(ValueError, 'own retained observations'): project(raw, body)

    def test_unknown_actor_omission_is_cited_but_cannot_borrow_another_cues_reason(self):
        body = 'Mon voyage est terminé.\nMon déménagement est terminé.'
        context = {'ownerAliases': SENT['ownerAliases'], 'direction': 'received', 'offset': 0}
        old = omission_fixtures.negative(body, cue_codes={'q1': 'ambiguous-actor', 'q2': 'ambiguous-actor'}, context=context)
        raw = wire_v11(previous.wire_v10(old), body)
        result, changes = project(raw, body, context)
        self.assertEqual(result['classification'], 'uncertain')
        self.assertEqual(len(changes[0]['selectionReview']['omissions']), 2)
        raw['cueDecisions']['q1'] = raw['cueDecisions']['q2']
        with self.assertRaisesRegex(ValueError, 'own supported reason'): project(raw, body, context)

    def test_empty_administrative_page_keeps_a_source_cited_abstention(self):
        body = 'Objet : copies PDF\nBonne soirée !'
        raw = wire_v11(previous.wire_v10(omission_fixtures.negative(body, 'administrative-context')), body)
        result, changes = project(raw, body)
        self.assertEqual(result['classification'], 'no-life-event')
        self.assertIn('Objet : copies PDF', result['summary'])
        self.assertEqual(changes[0]['cueDecisions']['requiredCitationIds'], [])

    def test_local_qualifications_cannot_migrate_between_decisions(self):
        body = 'Je débute la boxe.\nJe ferai peut-être une randonnée.'
        raw = positive(body, ('q1', 'q2'))
        ref = grounding.source_observations.qualification_catalog(grounding.catalog(body))[0]['id']
        raw['cueDecisions']['q1']['retentions'][0]['qualificationIds'] = [ref]
        with self.assertRaisesRegex(ValueError, 'only to its own'): project(raw, body)

    def test_v10_schema_and_silent_omission_rejection_stay_frozen(self):
        self.assertEqual(hashed(grounding.SCHEMA_V10), 'c097c5ae6fcebeb8d2756b5ddf0caf56b4de874b4aa4beac760995cf9a169a1d')
        body = "J'ai fait du snorkeling.\nJe débute la boxe."
        with self.assertRaisesRegex(ValueError, 'potentially useful source cue'):
            previous.project(previous.positive(body, ('q2',)), body)
        self.assertEqual(grounding.contract_for({'responseSchemaSha256': hashed(grounding.SCHEMA_V10)}),
                         grounding.EXPLICIT_CONTRACT)


class CueDecisionWorkerTests(unittest.TestCase):
    def setUp(self):
        worker_fixtures.SourceLanguageWorkerTests.setUp(self)
        frozen = patch.object(worker, "SCHEMA", grounding.SCHEMA_V11)
        frozen.start(); self.addCleanup(frozen.stop)
    mail = worker_fixtures.SourceLanguageWorkerTests.mail
    prepare = worker_fixtures.SourceLanguageWorkerTests.prepare
    run_worker = worker_fixtures.SourceLanguageWorkerTests.run_worker

    def test_explicit_native_decisions_replay_and_tamper_detection_needs_no_new_call(self):
        body = "J'ai fait du snorkeling.\nJe débute la boxe.";self.mail('message01', body)
        def output(prompt, reply):
            self.assertEqual(prompt['groundingContract'], grounding.CUE_CONTRACT)
            reply['response'] = json.dumps(positive(body, ('q1', 'q2')));return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client)['newlyReviewedPages'], 1)
        self.assertEqual(self.run_worker(client)['inferenceCalls'], 0);self.assertEqual(len(calls), 1)
        objective, manifest = self.prepare();path = next((objective / 'page-reviews').glob('*.json'))
        row = worker.read_receipt(path, manifest)
        row['resultProcessing']['changes'][0]['cueDecisions']['modelDecisions']['q1']['retentions'][0]['momentIndex'] = 9
        save(path, row)
        with self.assertRaisesRegex(ValueError, 'retained native result'): worker.read_receipt(path, manifest)

    def test_missing_decision_is_a_retained_rejection_without_repair_or_retry(self):
        body = "J'ai fait du snorkeling.\nJe débute la boxe.";self.mail('message01', body)
        def output(prompt, reply):
            reply['response'] = json.dumps(positive(body, ('q2',)));return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['newlyRejectedPages'], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        objective, _ = self.prepare();self.assertEqual(load(objective / 'findings.json'), [])


if __name__ == '__main__': unittest.main()
