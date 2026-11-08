"""Required source facts cannot borrow unrelated professional metadata."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_grounding as grounding
import objective_review as worker
from evidence_store import load, save
from objective_schema import normalize_representation, validate
from review_receipts import hashed
import test_objective_cue_decisions as previous
import test_objective_dispositions as disposition_fixtures
import test_objective_source_language as worker_fixtures

SENT = previous.SENT


def wire_v12(value, body):
    """Fake wire conversion of supplied selections; never fill a missing cue."""
    value = copy.deepcopy(value)
    result = {k: value[k] for k in ('emptyAssessment', 'gaps', 'abstention')}
    result.update(additionalMoments=[], cueDecisions={})
    for key, choice in value['cueDecisions'].items():
        if 'reasonRef' in choice:
            result['cueDecisions'][key] = choice
    for index, old in enumerate(value['moments']):
        selected = [(key, r) for key, choice in value['cueDecisions'].items()
                    for r in choice.get('retentions', []) if r['momentIndex'] == index]
        for key, ref in selected or [(None, None)]:
            moment = copy.deepcopy(old);moment.pop('factTypeCitationIds')
            title = moment.pop('titleCitationId');anchor = key or title
            moment['anchorCitationId'] = anchor
            moment['qualificationIds'] = ref['qualificationIds'] if ref else next(
                (o['qualificationIds'] for o in moment['contextObservations'] if o['citationId'] == anchor), [])
            moment['contextObservations'] = [o for o in moment['contextObservations'] if o['citationId'] != anchor]
            if key:
                result['cueDecisions'].setdefault(key, {'retainedMoments': []})['retainedMoments'].append(moment)
            else:
                result['additionalMoments'].append(moment)
    return result


def moment(anchor, *, kind='life-event', category='daily', status='reported'):
    return {'factType': kind, 'category': category, 'subject': 'owner', 'subjectName': 'Personne Exemple',
            'occurrenceStatus': status, 'claimType': 'direct', 'startDateRef': None, 'endDateRef': None,
            'anchorCitationId': anchor, 'qualificationIds': [], 'contextObservations': []}


def raw(cue_facts=None, additional=None):
    return {'emptyAssessment': 'no-life-event', 'additionalMoments': additional or [], 'gaps': [],
            'abstention': None, 'cueDecisions': {k: {'retainedMoments': v} for k, v in (cue_facts or {}).items()}}


def project(value, body, context=SENT):
    result, changes = normalize_representation(value, body, grounding.CONTRACT,
        {'end': len(body), 'totalChars': len(body), **context})
    validate(result, body)
    return result, changes


class AnchoredFactTests(unittest.TestCase):
    def test_completed_move_has_its_own_home_metadata_and_no_communication_date_choice(self):
        body = 'Mon déménagement étant terminé, je serai disponible plus tard.'
        ctx = {**SENT, 'mailDate': '2020-03-09T12:00:00Z'}
        schema = grounding.schema_for(body, source_context=ctx)
        self.assertEqual(len(schema['anyOf']), 1)
        cue = schema['anyOf'][0]['properties']['cueDecisions']['properties']['q1']
        branch = cue['properties']['retainedMoments']['items']['anyOf'][0]['properties']
        self.assertEqual(branch['factType']['enum'], ['life-event'])
        self.assertEqual(branch['category']['enum'], ['home'])
        self.assertEqual(branch['occurrenceStatus']['enum'], ['reported'])
        self.assertEqual(branch['anchorCitationId']['enum'], ['q1'])
        self.assertEqual(branch['startDateRef']['enum'], [None])
        self.assertNotIn('factTypeCitationIds', branch)
        result, changes = project(raw({'q1': [moment('q1', category='home')]}), body, ctx)
        self.assertIsNone(result['moments'][0]['startDate']);self.assertIsNone(result['moments'][0]['endDate'])
        self.assertIn(body, result['summary'])
        self.assertEqual(changes[0]['anchoredFacts']['locallyInventedMoments'], 0)

    def test_home_completion_cannot_be_assigned_professional_or_planned_metadata(self):
        body = 'Mon déménagement est terminé, le travail reprendra plus tard.'
        for kind, category, status in [('work-activity', 'work', 'reported'),
                                       ('life-event', 'work', 'reported'), ('life-event', 'home', 'planned')]:
            with self.subTest(kind=kind, category=category, status=status), self.assertRaisesRegex(ValueError, 'completed home'):
                project(raw({'q1': [moment('q1', kind=kind, category=category, status=status)]}), body)

    def test_completed_work_followed_by_a_home_mention_is_not_a_completed_home_assertion(self):
        body = 'Mon travail est terminé après mon déménagement.'
        self.assertEqual(grounding.anchored_facts.completed_home_ids(grounding.catalog(body), SENT), set())

    def test_move_work_activity_and_correspondence_keep_independent_types_and_dates(self):
        body = "Voici ma version du code.\nJ'ai passé trois heures sur le planificateur.\nMon déménagement est terminé."
        value = raw({'q3': [moment('q3', category='home')]}, [
            moment('q1', kind='work-correspondence', category='work'),
            moment('q2', kind='work-activity', category='work')])
        before = copy.deepcopy(value);result, changes = project(value, body)
        self.assertEqual(value, before);self.assertEqual(len(result['moments']), 3)
        self.assertEqual([r['factTypeCitationIds'] for r in changes[0]['anchoredFacts']['bindings']], [['q1'], ['q2'], []])
        self.assertEqual([m['category'] for m in result['moments']], ['work', 'work', 'home'])
        self.assertEqual(changes[0]['retainedSummary']['citationIds'], ['q1', 'q2', 'q3'])
        self.assertFalse(changes[0]['derivedCueBindings']['isNativeWireResult'])

    def test_type_must_be_supported_by_the_primary_excerpt_even_with_another_valid_context_excerpt(self):
        body = "J'ai passé trois heures sur le planificateur.\nVoici ma version du code."
        value = raw(additional=[moment('q1', kind='work-correspondence', category='work')])
        value['additionalMoments'][0]['contextObservations'] = [{'citationId': 'q2', 'qualificationIds': []}]
        with self.assertRaisesRegex(ValueError, 'own primary source anchor'): project(value, body)
        schema = grounding.schema_for(body, source_context=SENT)
        branches = schema['anyOf'][0]['properties']['additionalMoments']['items']['anyOf']
        correspondence = next(b for b in branches if b['properties']['factType']['enum'] == ['work-correspondence'])
        self.assertEqual(correspondence['properties']['anchorCitationId']['enum'], ['q2'])

    def test_independent_type_evidence_title_selectors_and_borrowed_indices_are_rejected(self):
        body = 'Mon déménagement est terminé.'
        for key, value in [('factTypeCitationIds', ['q1']), ('titleCitationId', 'q1'), ('momentIndex', 0)]:
            native = moment('q1', category='home');native[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'independent type evidence'):
                project(raw({'q1': [native]}), body)
        value = raw();value['cueDecisions']['q1'] = {'retentions': [{'momentIndex': 0, 'qualificationIds': []}]}
        with self.assertRaisesRegex(ValueError, 'own bounded native facts'): project(value, body)

    def test_snorkeling_boxing_and_future_hike_have_explicit_primary_observations_and_aligned_summaries(self):
        body = "J'ai fait du snorkeling.\nJe débute la boxe.\nOn va faire une randonnée... Attention si on se perd !"
        value = raw({'q1': [moment('q1', category='travel')], 'q2': [moment('q2', category='travel')],
                     'q3': [moment('q3', category='travel', status='planned')]})
        result, changes = project(value, body)
        self.assertEqual([m['occurrenceStatus'] for m in result['moments']], ['reported', 'reported', 'planned'])
        self.assertEqual(changes[0]['retainedSummary']['citationIds'], ['q1', 'q2', 'q3'])
        self.assertTrue(all(m['startDate'] is None and not m['ongoing'] for m in result['moments']))
        for line in body.splitlines():self.assertIn(line, result['summary'])

    def test_a_complete_plan_cannot_become_a_reported_realization(self):
        body = 'On va faire une randonnée... Attention si on se perd !'
        with self.assertRaisesRegex(ValueError, 'future plan'):
            project(raw({'q1': [moment('q1', category='travel')]}), body)

    def test_json_property_order_cannot_change_facts_or_the_three_excerpt_summary(self):
        body = '\n'.join(["J'ai fait du snorkeling.", 'Je débute la boxe.',
                          'Mon voyage est terminé.', 'Je pratique l’escalade.'])
        value = raw({key: [moment(key, category='travel')] for key in ('q1', 'q2', 'q3', 'q4')})
        reversed_value = copy.deepcopy(value)
        reversed_value['cueDecisions'] = dict(reversed(list(value['cueDecisions'].items())))
        first, proof = project(value, body);second, reversed_proof = project(reversed_value, body)
        self.assertEqual(first, second);self.assertEqual(proof, reversed_proof)
        self.assertEqual(proof[0]['retainedSummary']['citationIds'], ['q1', 'q2', 'q3'])

    def test_no_missing_or_extra_cue_or_cross_cue_anchor_can_be_repaired(self):
        body = "J'ai fait du snorkeling.\nJe débute la boxe."
        for value in [raw({'q2': [moment('q2')]}), raw({'q1': [moment('q2')], 'q2': [moment('q2')]}),
                      raw({'q1': [moment('q1')], 'q2': [moment('q2')], 'q9': [moment('q9')]})]:
            before = copy.deepcopy(value)
            with self.assertRaises(ValueError):project(value, body)
            self.assertEqual(value, before)

    def test_additional_facts_cannot_bypass_a_cue_or_repeat_their_primary_observation(self):
        body = 'Mon déménagement est terminé.\nUn autre extrait.'
        with self.assertRaisesRegex(ValueError, 'cannot bypass'):
            project(raw({'q1': [moment('q1', category='home')]}, [moment('q1')]), body)
        value = raw({'q1': [moment('q1', category='home')]}, [moment('q2')])
        value['additionalMoments'][0]['contextObservations'] = [{'citationId': 'q2', 'qualificationIds': []}]
        with self.assertRaisesRegex(ValueError, 'cannot repeat'): project(value, body)

    def test_local_reservation_remains_on_its_anchor_and_cannot_migrate(self):
        body = 'Je débute la boxe.\nJe ferai peut-être une randonnée.'
        value = raw({'q1': [moment('q1')], 'q2': [moment('q2', status='planned')]})
        ref = grounding.source_observations.qualification_catalog(grounding.catalog(body))[0]['id']
        value['cueDecisions']['q2']['retainedMoments'][0]['qualificationIds'] = [ref]
        result, _ = project(value, body)
        self.assertEqual(result['moments'][0]['relationHints'], []);self.assertTrue(result['moments'][1]['relationHints'])
        value['cueDecisions']['q1']['retainedMoments'][0]['qualificationIds'] = [ref]
        with self.assertRaisesRegex(ValueError, 'only to its own'): project(value, body)

    def test_empty_administrative_and_unknown_actor_decisions_keep_cited_abstention(self):
        import test_objective_explicit_selection as v10
        import test_objective_omission_policy as omissions
        for body, code, context, cue_codes in [('Objet : copies PDF', 'administrative-context', SENT, {}),
                ('Mon voyage est terminé.', 'insufficient-event-context', {**SENT, 'direction': 'received'}, {'q1': 'ambiguous-actor'})]:
            value = wire_v12(previous.wire_v11(v10.wire_v10(omissions.negative(body, code, cue_codes=cue_codes, context=context)), body), body)
            result, _ = project(value, body, context)
            self.assertEqual(result['moments'], []);self.assertIn('Motif', result['summary'])

    def test_v11_retention_shape_is_a_separate_frozen_contract(self):
        self.assertEqual(hashed(grounding.SCHEMA_V11), 'aa4739efe3398d24d6fb88715f4437bff5b2f52ff04ef6289fac248fb471acb4')
        body = 'Mon déménagement est terminé.'
        value = previous.positive(body)
        result, changes = previous.project(value, body)
        self.assertEqual(changes[0]['contract'], grounding.CUE_CONTRACT)
        self.assertEqual(grounding.contract_for({'responseSchemaSha256': hashed(grounding.SCHEMA_V11)}), grounding.CUE_CONTRACT)
        with self.assertRaises(ValueError):project(value, body)


class AnchoredFactWorkerTests(unittest.TestCase):
    setUp = worker_fixtures.SourceLanguageWorkerTests.setUp
    mail = worker_fixtures.SourceLanguageWorkerTests.mail
    prepare = worker_fixtures.SourceLanguageWorkerTests.prepare
    run_worker = worker_fixtures.SourceLanguageWorkerTests.run_worker

    def test_native_home_metadata_and_anchor_proof_replay_and_detect_tampering_without_new_calls(self):
        body = 'Mon déménagement est terminé.';self.mail('message01', body)
        def output(prompt, reply):
            self.assertEqual(prompt['groundingContract'], grounding.CONTRACT)
            reply['response'] = json.dumps(raw({'q1': [moment('q1', category='home')]}));return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client)['newlyReviewedPages'], 1)
        self.assertEqual(self.run_worker(client)['inferenceCalls'], 0);self.assertEqual(len(calls), 1)
        objective, manifest = self.prepare();path = next((objective / 'page-reviews').glob('*.json'));row = worker.read_receipt(path, manifest)
        row['resultProcessing']['changes'][0]['anchoredFacts']['bindings'][0]['factTypeCitationIds'] = ['q999'];save(path, row)
        with self.assertRaisesRegex(ValueError, 'retained native result'):worker.read_receipt(path, manifest)

    def test_wrong_home_metadata_is_retained_rejected_and_never_repaired_or_reissued(self):
        body = 'Mon déménagement est terminé.';self.mail('message01', body)
        def output(prompt, reply):
            reply['response'] = json.dumps(raw({'q1': [moment('q1', category='work')]}));return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['newlyRejectedPages'], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['inferenceCalls'], 0);self.assertEqual(len(calls), 1)
        objective, _ = self.prepare();self.assertEqual(load(objective / 'findings.json'), [])


if __name__ == '__main__': unittest.main()
