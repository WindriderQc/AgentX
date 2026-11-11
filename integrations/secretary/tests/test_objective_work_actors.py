"""Work selection must be explicit; unknown speakers never become owners."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_grounding as grounding
import objective_review as worker
from objective_schema import normalize_representation, validate
from evidence_store import load, save
from review_receipts import hashed
import test_objective_claim_typing as v13
import test_objective_anchored_facts as v12
import test_objective_dispositions as fixtures
import test_objective_source_language as workers

SENT = v13.SENT


def moment(anchor, *, kind='life-event', subject='owner', name='Personne Exemple', category='work', status='reported'):
    m = v13.moment(anchor, category=category, status=status)
    m.update(factType=kind, subject=subject, subjectName=name)
    return m


def raw(*, cues=None, work=None, additional=None):
    value = v12.raw(cues, additional)
    value['professionalDecisions'] = {k: {'retainedMoments': v} for k, v in (work or {}).items()}
    return value


def project(value, body, context=SENT):
    r, changes = normalize_representation(value, body, grounding.CONTRACT,
        {'end': len(body), 'totalChars': len(body), **context})
    validate(r, body)
    return r, changes


def wire_v14(value, body, context=None):
    """Fake model choices from existing fixtures; no production output repair."""
    value = copy.deepcopy(value);spans = grounding.catalog(body)
    rows = grounding.work_actors.work_catalog(spans, context)
    value['professionalDecisions'] = {}
    for row in rows:
        facts = [m for m in value['additionalMoments'] if m['anchorCitationId'] == row['citationId']]
        value['additionalMoments'] = [m for m in value['additionalMoments'] if m not in facts]
        if facts:
            value['professionalDecisions'][row['citationId']] = {'retainedMoments': facts}
        elif row['omissionChoices']:
            value['professionalDecisions'][row['citationId']] = {'reasonRef': row['omissionChoices'][0]['id']}
    actor_rows = {r['citationId']: r for r in grounding.work_actors.actors(spans, context)}
    native = list(grounding.claim_typing._moments(value)) + [('', m) for c in value['professionalDecisions'].values() for m in c.get('retainedMoments', [])]
    for _, m in native:
        if m['subject'] not in actor_rows[m['anchorCitationId']]['allowedSubjects']:
            m.update(subject='unknown', subjectName='')
        if m['subject'] == 'unknown':m['subjectName'] = ''
    return value


class WorkActorTests(unittest.TestCase):
    def test_two_work_reports_need_own_decisions_and_keep_local_warning(self):
        body = "De : Personne Exemple\nVoici ma dernière version du code. Il est possible que j'aie oublié un détail.\nJ'ai passé deux heures sur le projet.\nMon déménagement est terminé."
        rows = grounding.work_actors.work_catalog(grounding.catalog(body), SENT)
        self.assertEqual([r['citationId'] for r in rows], ['q2', 'q3'])
        self.assertTrue(all(not r['omissionChoices'] and r['directDeclaration'] for r in rows))
        value = raw(cues={'q4': [moment('q4', category='home')]}, work={
            'q2': [moment('q2', kind='work-correspondence')], 'q3': [moment('q3', kind='work-activity')]})
        value['professionalDecisions']['q2']['retainedMoments'][0]['qualificationIds'] = ['u1']
        before = copy.deepcopy(value);r, changes = project(value, body)
        self.assertEqual(value, before);self.assertEqual(len(r['moments']), 3)
        self.assertEqual([m['category'] for m in r['moments']], ['work', 'work', 'home'])
        self.assertTrue(all(m['claimType'] == 'direct' for m in r['moments']))
        self.assertTrue(all(m['startDate'] is None for m in r['moments']))
        self.assertIn('oublié', r['moments'][0]['relationHints'][0])
        self.assertFalse(r['moments'][1]['relationHints'])
        self.assertEqual(changes[0]['retainedSummary']['citationIds'], ['q2', 'q3', 'q4'])
        self.assertEqual(changes[0]['workActorSelection']['nativeProfessionalDecisions'], value['professionalDecisions'])

    def test_missing_work_decision_and_optional_bypass_fail_without_repair(self):
        body = "J'ai passé deux heures sur le projet."
        for value in (raw(), raw(additional=[moment('q1', kind='work-activity')])):
            before = copy.deepcopy(value)
            with self.assertRaisesRegex(ValueError, 'exactly one decision'):project(value, body)
            self.assertEqual(value, before)
        value = raw(work={'q1': [moment('q1', kind='work-activity')]}, additional=[moment('q1')])
        with self.assertRaisesRegex(ValueError, 'bypass professional'):project(value, body)

    def test_complete_work_cannot_be_omitted_or_borrow_another_anchor_or_type(self):
        body = "J'ai passé deux heures sur le projet."
        for change in ({'reasonRef': 'w1-1'}, {'retainedMoments': [moment('q2', kind='work-activity')]},
                       {'retainedMoments': [moment('q1', kind='life-event')]}, None):
            value = raw();value['professionalDecisions']['q1'] = change
            with self.subTest(change=change), self.assertRaises(ValueError):project(value, body)

    def test_reported_work_cannot_be_relabeled_as_a_future_project(self):
        body = "J'ai passé deux heures sur le projet. Je finirai demain."
        value = raw(work={'q1': [moment('q1', kind='work-activity', status='planned')]})
        with self.assertRaisesRegex(ValueError, 'Professional facts retain'):project(value, body)

    def test_malformed_native_references_fail_as_validation_errors(self):
        body = 'Je débute la boxe.'
        for field, bad in (('additionalMoments', None), ('additionalMoments', [None]),
                           ('cueDecisions', {'bad': {}}), ('cueDecisions', {'q1': None}),
                           ('cueDecisions', {'q1': {'reasonRef': []}})):
            value = raw(cues={'q1': [moment('q1')]});value[field] = bad
            with self.subTest(field=field, bad=bad), self.assertRaises(ValueError):project(value, body)

    def test_malformed_retained_cue_cannot_escape_as_an_uncertain_worker_crash(self):
        body = 'Mon voyage...'
        for choice in ({'retainedMoments': None}, {'retainedMoments': []},
                       {'retainedMoments': True}, {'retainedMoments': 'q1'},
                       {'retainedMoments': None, 'reasonRef': 'r1'}):
            value = raw();value['cueDecisions']['q1'] = choice;before = copy.deepcopy(value)
            with self.subTest(choice=choice), self.assertRaises(ValueError):project(value, body)
            self.assertEqual(value, before)

    def test_mixed_unresolved_travel_keeps_direct_statements_with_unknown_actors(self):
        body, value = v13.travel();value['professionalDecisions'] = {}
        for c in value['cueDecisions'].values():
            c['retainedMoments'][0].update(subject='unknown', subjectName='')
        context = {**SENT, 'direction': 'unknown'}
        r, changes = project(value, body, context)
        self.assertEqual([m['subject'] for m in r['moments']], ['unknown'] * 3)
        self.assertEqual([m['claimType'] for m in r['moments']], ['direct'] * 3)
        self.assertEqual([m['occurrenceStatus'] for m in r['moments']], ['reported', 'reported', 'planned'])
        self.assertTrue(all('Identité' in m['uncertainty'] for m in r['moments']))
        self.assertTrue(all(not b['identityVerified'] for b in changes[0]['workActorSelection']['actorBindings']))

    def test_unknown_speaker_cannot_be_owner_or_receive_a_name_from_later_header(self):
        for body in ('Je débute la boxe.', 'Je débute la boxe.\nFrom: Personne Exemple'):
            for subject, name in (('owner', 'Personne Exemple'), ('unknown', 'Personne Exemple'), ('thirdparty', 'Autre')):
                value = raw(cues={'q1': [moment('q1', subject=subject, name=name, category='travel')]})
                with self.subTest(body=body, subject=subject), self.assertRaisesRegex(ValueError, 'Unresolved source actors'):
                    project(value, body, {**SENT, 'direction': 'unknown'})

    def test_quoted_other_speaker_cannot_become_owner(self):
        body = 'From: Autre Auteur\nJe débute la boxe.'
        value = raw(cues={'q2': [moment('q2', category='travel')]})
        with self.assertRaisesRegex(ValueError, 'Unresolved source actors'):project(value, body)
        value['cueDecisions']['q2']['retainedMoments'][0].update(subject='thirdparty', subjectName='Autre Auteur')
        r, _ = project(value, body);self.assertEqual(r['moments'][0]['subject'], 'thirdparty')

    def test_unresolved_complete_travel_cannot_disappear_as_ambiguous_actor(self):
        body = 'Je débute la boxe.';ctx = {**SENT, 'direction': 'unknown'}
        reasons = grounding.claim_typing.declarations.catalog(grounding.catalog(body), ctx)
        reason = next(r['id'] for r in reasons if r['scope'] == 'cue' and r['reasonCode'] == 'ambiguous-actor')
        value = raw();value['cueDecisions']['q1'] = {'reasonRef': reason}
        with self.assertRaisesRegex(ValueError, 'retain an unknown actor'):project(value, body, ctx)

    def test_other_person_work_omission_has_its_own_literal_reason_and_visible_gap(self):
        body = 'From: Autre Auteur\nVoici ma version du code.'
        value = raw();value['professionalDecisions']['q2'] = {'reasonRef': 'w1-1'}
        # A separate retained fact keeps the positive base branch meaningful.
        body += '\nMon voyage...';value['cueDecisions']['q3'] = {'retainedMoments': [moment('q3', subject='unknown', name='', category='travel')]}
        r, changes = project(value, body)
        omitted = changes[0]['selectionReview']['omissions'][0]
        self.assertEqual(omitted['citationId'], 'q2');self.assertEqual(omitted['reasonCode'], 'other-person-context')
        self.assertIn('version du code', r['gaps'][-1]);self.assertNotIn('q2', changes[0]['retainedSummary']['citationIds'])

    def test_unknown_work_can_be_retained_without_owner_or_personal_confirmation(self):
        body = "I spent two hours on the project."
        value = raw(work={'q1': [moment('q1', kind='work-activity', subject='unknown', name='')]})
        r, changes = project(value, body, {**SENT, 'direction': 'unknown'})
        self.assertEqual(r['moments'][0]['subject'], 'unknown')
        self.assertFalse(changes[0]['workActorSelection']['ownerConfirmation'])

    def test_frozen_v13_does_not_gain_actor_or_professional_requirements(self):
        self.assertEqual(hashed(grounding.SCHEMA_V13), '29db9a46ecc79323187d35e3bab7fe951722fe3449d55d5c48479e839da59c1d')
        body, old = v13.travel();before = copy.deepcopy(old)
        r, changes = v13.project(old, body, {**SENT, 'direction': 'unknown'})
        self.assertEqual(old, before);self.assertEqual([m['subject'] for m in r['moments']], ['owner'] * 3)
        self.assertNotIn('workActorSelection', changes[0])
        self.assertEqual(grounding.contract_for({'responseSchemaSha256': hashed(grounding.SCHEMA_V13)}), grounding.CLAIM_CONTRACT)


class WorkActorWorkerTests(unittest.TestCase):
    setUp = workers.SourceLanguageWorkerTests.setUp
    mail = workers.SourceLanguageWorkerTests.mail
    prepare = workers.SourceLanguageWorkerTests.prepare
    run_worker = workers.SourceLanguageWorkerTests.run_worker

    def test_native_work_and_actor_choices_replay_and_tampering_fails(self):
        body = "J'ai passé deux heures sur le projet.";self.mail('message01', body)
        def output(prompt, reply):
            self.assertEqual(prompt['professionalCueCatalog'][0]['citationId'], 'q1')
            value = raw(work={'q1': [moment('q1', kind='work-activity', subject='unknown', name='')]})
            reply['response'] = json.dumps(value);return reply
        client, calls = fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client)['newlyReviewedPages'], 1)
        self.assertEqual(self.run_worker(client)['inferenceCalls'], 0);self.assertEqual(len(calls), 1)
        objective, manifest = self.prepare();p = next((objective/'page-reviews').glob('*.json'));row = worker.read_receipt(p, manifest)
        row['resultProcessing']['changes'][0]['workActorSelection']['actorBindings'][0]['identityVerified'] = True;save(p, row)
        with self.assertRaisesRegex(ValueError, 'retained native result'):worker.read_receipt(p, manifest)

    def test_unknown_actor_owner_output_is_rejected_without_retry_or_repair(self):
        body = '---------- Message transféré ----------\nJe débute la boxe.';self.mail('message01', body)
        def output(prompt, reply):
            reply['response'] = json.dumps(raw(cues={'q2': [moment('q2', category='travel')]}));return reply
        client, calls = fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['newlyRejectedPages'], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['inferenceCalls'], 0);self.assertEqual(len(calls), 1)

    def test_null_retention_is_preserved_as_a_rejection_without_another_model_call(self):
        self.mail('message01', 'Mon voyage...')
        def output(prompt, reply):
            value = raw();value['cueDecisions']['q1'] = {'retainedMoments': None}
            reply['response'] = json.dumps(value);return reply
        client, calls = fixtures.DispositionTests.client(self, output)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['newlyRejectedPages'], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':unittest.main()
