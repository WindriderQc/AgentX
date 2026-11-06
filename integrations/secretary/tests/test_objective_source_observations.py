"""Source wording retains relative time; reservations cannot move across facts."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_grounding as grounding
import objective_review as worker
import objective_source_observations as source
from objective_schema import normalize_representation, validate
from evidence_store import load, save
from review_receipts import hashed
import test_objective_claim_proofs as fixtures
import test_objective_dispositions as disposition_fixtures


def wire_v7(value):
    """Convert synthetic v5/v6 test selections; never repair an invalid ID."""
    value = copy.deepcopy(value)
    for moment in value['moments']:
        moment.pop('title'); moment.pop('ongoing'); moment.pop('hypotheses')
        ids = list(dict.fromkeys(key for row in moment['observations'] for key in row['citationIds']))
        moment['titleCitationId'] = ids[0] if ids else 'unknown-span'
        moment['observations'] = [{'citationId': key, 'qualificationIds': []} for key in ids]
    return value


def response(body, ids=('q1',), qualifications=None, **extra):
    value = wire_v7(fixtures.response(body))
    value['moments'][0].update(titleCitationId=ids[0], observations=[
        {'citationId': key, 'qualificationIds': (qualifications or {}).get(key, [])} for key in ids], **extra)
    return value


def project(value, body, context=None):
    result, changes = normalize_representation(value, body, grounding.CONTRACT, context)
    validate(result, body)
    return result, changes


class SourceObservationTests(unittest.TestCase):
    def test_relative_days_and_future_expectations_are_copied_without_paraphrase(self):
        for body in ('Après-demain nous ferons une promenade.',
                     'Tomorrow we will visit a friend.',
                     'Avant-hier nous sommes rentrés.',
                     "Mon installation est terminée ; je vais avoir davantage de temps."):
            with self.subTest(body=body):
                raw = response(body); before = copy.deepcopy(raw)
                result, changes = project(raw, body, fixtures.context(body, mailDate='2020-05-05T12:00:00Z'))
                moment = result['moments'][0]
                self.assertIn('« ' + body + ' »', moment['description'])
                self.assertIn(body, moment['title'])
                self.assertEqual(moment['quotes'], [body])
                self.assertIsNone(moment['startDate'])
                self.assertEqual(raw, before)
                self.assertEqual(changes[0]['claims'][0]['text'], body)

    def test_backend_cannot_supply_its_own_temporal_wording_or_ongoing_flag(self):
        body = 'Après-demain je partirai.'
        for location, key, value in [('observation', 'text', 'Je partirai demain.'),
                                     ('moment', 'title', 'Départ demain'),
                                     ('moment', 'ongoing', True),
                                     ('moment', 'hypotheses', ['u1'])]:
            raw = response(body)
            target = raw['moments'][0]['observations'][0] if location == 'observation' else raw['moments'][0]
            target[key] = value
            with self.assertRaises(ValueError): project(raw, body)

    def test_historical_present_does_not_assert_current_continuation(self):
        body = 'Maintenant je visite une autre région.'
        result, changes = project(response(body), body, fixtures.context(body, mailDate='2010-05-05T12:00:00Z'))
        moment = result['moments'][0]
        self.assertFalse(moment['ongoing'])
        self.assertIn(body, moment['description'])
        self.assertIn('aucune continuité actuelle', moment['uncertainty'])
        self.assertEqual(changes[0]['factPolicy']['facts'][0]['ongoingPolicy'], 'no-current-continuation-inferred')

    def test_future_help_condition_stays_in_its_parenthetical_source_context(self):
        body = ("J'ai consacré deux heures au projet.\nJ'avais ajouté cinq heures pour ce projet ; "
                'il restera du temps disponible. (Ou si je peux aider autrement.)')
        raw = response(body, ('q1', 'q2'), {'q2': ['u1']}, factType='work-activity', category='work',
                       factTypeCitationIds=['q1', 'q2'])
        result, changes = project(raw, body)
        moment = result['moments'][0]
        self.assertIn("J'ai consacré deux heures", moment['description'])
        self.assertIn("J'avais ajouté cinq heures", moment['description'])
        self.assertEqual(len(moment['relationHints']), 1)
        hint = moment['relationHints'][0]
        self.assertIn('extrait q2 uniquement', hint)
        self.assertIn('« (Ou si je peux aider autrement.) »', hint)
        self.assertNotIn('deux heures', hint)
        self.assertNotIn('cinq heures', hint)
        self.assertNotIn('Questions, conditions ou possibilités citées à vérifier', moment['uncertainty'])
        binding = changes[0]['factPolicy']['facts'][0]['sourceQualifications'][0]
        self.assertEqual(binding['scope'], source.SCOPE)
        reservation = binding['reservationSpan']
        self.assertEqual(body[reservation['start']:reservation['end']], reservation['text'])
        self.assertEqual(reservation['text'], '(Ou si je peux aider autrement.)')

    def test_a_reservation_cannot_move_to_a_different_observation(self):
        body = "J'ai terminé le projet.\nJe peux revenir si le budget est accepté."
        raw = response(body, ('q1', 'q2'), {'q1': ['u1']}, factType='work-activity', category='work',
                       factTypeCitationIds=['q1'])
        with self.assertRaisesRegex(ValueError, 'only to its own cited excerpt'): project(raw, body)
        raw['moments'][0]['observations'][0]['qualificationIds'] = ['u999']
        with self.assertRaisesRegex(ValueError, 'known reference'): project(raw, body)

    def test_titles_cannot_borrow_unselected_text_and_observations_cannot_duplicate(self):
        body = 'Une installation est terminée.\nNous partirons demain.'
        raw = response(body);raw['moments'][0]['titleCitationId'] = 'q2'
        with self.assertRaisesRegex(ValueError, 'own observation'): project(raw, body)
        raw = response(body);raw['moments'][0]['observations'] *= 2
        with self.assertRaisesRegex(ValueError, 'distinct source spans'): project(raw, body)

    def test_long_title_and_rationale_never_cut_off_a_temporal_reservation(self):
        body = 'Une lecture ' + 'exacte ' * 1250 + 'ne constitue pas encore un accord ; nous en reparlerons demain.'
        result, changes = project(response(body), body)
        moment = result['moments'][0]
        self.assertIn('voir les extraits complets', moment['title'])
        self.assertEqual(moment['quotes'], [body])
        self.assertIn(body, moment['description'])
        self.assertLessEqual(len(moment['rationale']), 8000)
        self.assertEqual(changes[0]['factPolicy']['facts'][0]['rationaleDisplay'], 'description-reference')

    def test_multiple_conditions_or_unbounded_parentheticals_keep_the_complete_line(self):
        for body in ('Si le bureau est ouvert, nous passerons (ou si nous pouvons demain).',
                     'Nous réserverons si le budget est accepté.',
                     '(Si nous partons (avec eux), nous appellerons.)'):
            row = next(r for r in source.qualification_catalog(grounding.catalog(body)) if r['basis'] == 'condition')
            self.assertEqual(row['reservationSpan']['text'], body)

    def test_schema_binds_qualification_choices_and_removes_generated_wording(self):
        body = 'Une activité est terminée.\nNous appellerons si on se perd.'
        schema = grounding.schema_for(body)
        for branch in schema['properties']['moments']['items']['anyOf']:
            props = branch['properties']
            for name in ('title', 'ongoing', 'hypotheses'):self.assertNotIn(name, props)
            alternatives = props['observations']['items']['anyOf']
            for row in alternatives:
                fields = row['properties']
                self.assertNotIn('text', fields)
                if fields['citationId']['enum'] == ['q2']:
                    self.assertEqual(fields['qualificationIds']['items']['enum'], ['u1'])
                else:self.assertEqual(fields['qualificationIds']['maxItems'], 0)
        empty = grounding.schema_for(' \n ')
        self.assertEqual(empty['properties']['moments']['maxItems'], 0)

    def test_frozen_v6_still_projects_its_own_generated_wording(self):
        self.assertEqual(hashed(grounding.SCHEMA_V6), '0874ba97eed8d0ae295e179903bebf3c385a2ad43544722027056b05e97bf3c6')
        self.assertEqual(grounding.contract_for({'responseSchemaSha256': hashed(grounding.SCHEMA_V6)}), grounding.CONDITIONAL_CONTRACT)
        body = 'Après-demain nous partirons.'
        old = fixtures.response(body)
        old['moments'][0]['observations'][0]['text'] = 'Une ancienne paraphrase conservée.'
        result, changes = normalize_representation(old, body, grounding.CONDITIONAL_CONTRACT)
        self.assertEqual(result['moments'][0]['description'], 'Une ancienne paraphrase conservée.')
        self.assertEqual(changes[0]['contract'], grounding.CONDITIONAL_CONTRACT)
        with self.assertRaises(ValueError): project(old, body)


class SourceObservationWorkerTests(unittest.TestCase):
    setUp = fixtures.fixtures.SourceLanguageWorkerTests.setUp
    mail = fixtures.fixtures.SourceLanguageWorkerTests.mail
    prepare = fixtures.fixtures.SourceLanguageWorkerTests.prepare
    run_worker = fixtures.fixtures.SourceLanguageWorkerTests.run_worker

    def test_native_source_selections_and_scopes_replay_without_another_model_call(self):
        body = "J'ai terminé ce projet.\nJe peux aider au projet. (Ou si je peux aider autrement.)"
        self.mail('message01', body)
        def output(prompt, reply):
            self.assertEqual(prompt['groundingContract'], grounding.CONTRACT)
            self.assertEqual(prompt['uncertaintyCatalog'][0]['reservationSpan']['text'], '(Ou si je peux aider autrement.)')
            reply['response'] = json.dumps(response(body, ('q1', 'q2'), {'q2': ['u1']},
                factType='work-activity', category='work', factTypeCitationIds=['q1']))
            return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client)['newlyReviewedPages'], 1)
        objective, manifest = self.prepare();file = next((objective/'page-reviews').glob('*.json'))
        row = worker.read_receipt(file, manifest)
        self.assertEqual(row['resultProcessing']['changes'][0]['contract'], grounding.CONTRACT)
        self.assertFalse(load(objective/'findings.json')[0]['userConfirmed'])
        self.assertEqual(self.run_worker(client)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        row['resultProcessing']['changes'][0]['factPolicy']['facts'][0]['sourceQualifications'][0]['citationId'] = 'q1'
        save(file, row)
        with self.assertRaisesRegex(ValueError, 'retained native result'): worker.read_receipt(file, manifest)

    def test_wrong_excerpt_scope_is_retained_as_rejection_without_retry(self):
        body = "J'ai terminé ce projet.\nNous reviendrons si le bureau est ouvert."
        self.mail('message01', body)
        def output(prompt, reply):
            reply['response'] = json.dumps(response(body, ('q1', 'q2'), {'q1': ['u1']},
                factType='work-activity', category='work', factTypeCitationIds=['q1']))
            return reply
        client, calls = disposition_fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['newlyRejectedPages'], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        objective, _ = self.prepare();self.assertEqual(load(objective/'findings.json'), [])


if __name__ == '__main__':
    unittest.main()
