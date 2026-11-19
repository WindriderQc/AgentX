"""Synthetic v15 regressions; no mail, document bytes, model or live service."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_grounding as grounding
import objective_review as worker
import objective_source_selection as selection
import objective_selection_schema as wire
from objective_schema import normalize_representation, validate
from review_receipts import hashed
from evidence_store import load, save
import test_objective_work_actors as v14
import test_objective_input_scope as scoped
import test_objective_actor_context as actors

SENT = {'ownerAliases': ['Owner Example'], 'direction': 'sent', 'offset': 0}
META = {'primarySource': {'identity': {'system': 'gmail', 'messageId': 'sample001',
        'threadId': 'thread001', 'sourceSha256': 'a' * 64},
        'headers': {'from': 'Riley Sample <riley@example.test>'},
        'attachmentMetadata': [{'partIndex': 3, 'filename': 'Navigation outline.docx',
                                'mimeType': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}]}}


def fact(anchor, *, category='daily', status='reported', subject='owner', kind='life-event'):
    return v14.moment(anchor, kind=kind, subject=subject, name='' if subject == 'unknown' else 'Owner Example',
                      category=category, status=status)


def raw(body, facts=None, context=None, documents=None):
    context = {**SENT, **(context or {}), 'end': len(body), 'totalChars': len(body)}
    rows = selection.catalog(grounding.catalog(body), context)
    decisions = {r['id']: {'retained': True} if any(m['anchorCitationId'] == r['id'] for m in facts or [])
                 else {'reasonRef': r['omissionChoices'][0]['id']} for r in rows}
    reason = next((r for r in selection.omission_catalog(grounding.catalog(body), context) if r.get('scope') == 'passage'), None)
    return {'retainedMoments': facts or [], 'cueDecisions': decisions,
            'documentDecisions': documents or {r['id']: 'omit' for r in selection.documents(context)},
            'emptyAssessment': 'uncertain', 'abstention': None if facts else {'reasonRef': reason['id']}, 'gaps': []}


def response(payload, invalid=False):
    """Native fake used by reader tests, never an adapter for production output."""
    body = payload['untrustedContent']
    facts = [fact(r['id'], category='home') for r in payload['citationCatalog'] if 'Mon déménagement' in r['text']]
    context = {**SENT, 'primarySource': {'identity': {}, 'attachmentMetadata': []}}
    value = raw(body, facts, context)
    value['documentDecisions'] = {r['id']: 'omit' for r in payload['attachmentMetadataCatalog']}
    if invalid and facts:
        value['retainedMoments'][0]['anchorCitationId'] = 'unknown-span'
    return value


def project(value, body, context=None):
    context = {**SENT, **(context or {}), 'end': len(body), 'totalChars': len(body)}
    result, changes = normalize_representation(value, body, selection.CONTRACT, context)
    validate(result, body)
    return result, changes


class SourceSelectionTests(unittest.TestCase):
    def test_confirmation_cannot_inherit_administrative_signature_abstention(self):
        body = 'Je confirme votre annulation pour le 28 juin.\nCordialement\nRiley Sample\nAdministratrice\n555-012-9876'
        spans = grounding.catalog(body);ctx = {**SENT, **META}
        rows = selection.catalog(spans, ctx)
        self.assertEqual([r['id'] for r in rows], ['q1'])
        self.assertFalse(rows[0]['omissionChoices'])
        self.assertNotIn('administrative-context', [r['reasonCode'] for r in selection.omission_catalog(spans, ctx)])
        value = raw(body, [fact('q1', status='planned')], ctx)
        value['retainedMoments'][0]['startDateRef'] = 'pdate1'
        before = copy.deepcopy(value);result, changes = project(value, body, ctx)
        self.assertEqual(value, before)
        m = result['moments'][0]
        self.assertIsNone(m['startDate']);self.assertEqual(m['startPrecision'], 'unknown')
        self.assertEqual(m['originalDate'], '28 juin.')
        self.assertIn('année inconnue', m['uncertainty'])
        self.assertEqual(changes[0]['sourceSelection']['partialDates'][0]['reference']['text'], '28 juin.')
        invalid = copy.deepcopy(value);invalid['retainedMoments'] = [];invalid['cueDecisions'] = {'q1': {'reasonRef': 'r1'}}
        invalid['abstention'] = {'reasonRef': 'r1'}
        with self.assertRaises(ValueError):project(invalid, body, ctx)

    def test_request_is_planned_and_partial_date_never_borrows_message_year(self):
        body = 'Je voudrais confirmer que juin est le dernier mois de mon abonnement, pour une fin au 28 juin.'
        value = raw(body, [fact('q1', status='planned')])
        value['retainedMoments'][0]['endDateRef'] = 'pdate1'
        result, _ = project(value, body, {'mailDate': '2021-03-04T10:00:00+00:00'})
        self.assertIsNone(result['moments'][0]['endDate'])
        self.assertEqual(result['moments'][0]['originalDate'], '28 juin.')
        value['retainedMoments'][0]['occurrenceStatus'] = 'reported'
        with self.assertRaises(ValueError):project(value, body)

    def test_signature_only_is_not_a_home_event_but_document_metadata_can_be_retained(self):
        body = 'Riley Sample\nInstructeur\n555-012-9876\nSuivez-nous'
        self.assertEqual(selection.excluded(grounding.catalog(body), META), {'q1', 'q2', 'q3', 'q4'})
        value = raw(body, context=META, documents={'a1': 'retain-reference'})
        result, changes = project(value, body, META)
        self.assertFalse(result['moments'])
        ref = changes[0]['sourceSelection']['documentReferences'][0]
        self.assertEqual(ref['filename'], 'Navigation outline.docx')
        self.assertFalse(ref['contentRead']);self.assertNotIn('start', ref);self.assertNotIn('citationId', ref)
        self.assertIn('métadonnées uniquement', result['gaps'][0])
        invalid = copy.deepcopy(value);invalid['retainedMoments'] = [fact('q1', category='home')];invalid['abstention'] = None
        with self.assertRaises(ValueError):project(invalid, body, META)
        for unknown in ('a99', 'q1'):
            invalid = copy.deepcopy(value);invalid['documentDecisions'] = {unknown: 'retain-reference'}
            with self.assertRaises(ValueError):project(invalid, body, META)

    def test_informal_data_activity_keeps_own_anchor_without_employment_or_team_inference(self):
        body = "Pas de souci, cest moi qui traite les donnés des inscriptions.\nFrom: Morgan Other <other@example.test>\nInscrivez-vous à la compétition."
        rows = selection.catalog(grounding.catalog(body), SENT)
        self.assertEqual(rows[0]['sourceActivity'], 'data-activity')
        self.assertFalse(rows[0]['omissionChoices'])
        value = raw(body, [fact('q1')])
        result, proof = project(value, body)
        self.assertEqual(result['moments'][0]['category'], 'daily')
        self.assertEqual(result['moments'][0]['claimType'], 'direct')
        self.assertEqual(result['moments'][0]['quotes'], [body.splitlines()[0]])
        self.assertFalse(proof[0]['sourceSelection']['ownerConfirmation'])
        invalid = copy.deepcopy(value);invalid['retainedMoments'][0]['factType'] = 'work-activity'
        with self.assertRaises(ValueError):project(invalid, body)
        invalid = copy.deepcopy(value);invalid['retainedMoments'] = []
        self.assertFalse(wire.matches(invalid, grounding.schema_for(body, selection.CONTRACT, SENT)))
        with self.assertRaises(ValueError):project(invalid, body)

    def test_all_omitted_requires_a_native_whole_passage_reason(self):
        body = 'From: Morgan Other\nJe prépare les données des inscriptions.'
        value = raw(body)
        self.assertTrue(wire.matches(value, grounding.schema_for(body, selection.CONTRACT, SENT)))
        result, changes = project(value, body)
        self.assertFalse(result['moments']);self.assertEqual(result['classification'], 'uncertain')
        self.assertTrue(changes[0]['sourceSelection']['omissions'])
        for bad in (None, {'reasonRef': value['cueDecisions']['q2']['reasonRef']}):
            invalid = copy.deepcopy(value);invalid['abstention'] = bad
            self.assertFalse(wire.matches(invalid, grounding.schema_for(body, selection.CONTRACT, SENT)))
            with self.assertRaises(ValueError):project(invalid, body)

    def test_retained_marker_cannot_borrow_another_facts_metadata(self):
        body = 'Mon voyage...\nAutre passage.'
        value = {'retainedMoments': [fact('q2', subject='unknown')], 'cueDecisions': {'q1': {'retained': True}},
                 'documentDecisions': {}, 'emptyAssessment': 'uncertain', 'abstention': None, 'gaps': []}
        with self.assertRaisesRegex(ValueError, 'own complete native'):project(value, body)

    def test_partial_dates_are_literal_and_do_not_accept_invalid_days_or_quoted_headers(self):
        body = 'Fin le 29 février.\nFin le 31 avril.\nDate: 28 juin\nFin le 28 juin 2022.\nFin le 28 juin 22.'
        rows = selection.partial_dates(grounding.catalog(body))
        self.assertEqual([r['text'] for r in rows], ['29 février.'])
        self.assertEqual(body[rows[0]['start']:rows[0]['end']], '29 février.')

    def test_unknown_actor_and_future_plan_keep_old_safety_bounds(self):
        body = 'Je débute la boxe.'
        ctx = {'direction': 'unknown'}
        good = raw(body, [fact('q1', category='travel', subject='unknown')], ctx)
        r, _ = project(good, body, ctx);self.assertEqual(r['moments'][0]['subject'], 'unknown')
        bad = copy.deepcopy(good);bad['retainedMoments'][0]['subject'] = 'owner'
        with self.assertRaises(ValueError):project(bad, body, ctx)

    def test_contract_copy_request_and_transmission_keep_their_own_actors_and_stage(self):
        request = 'Je souhaite recevoir une copie du contrat de mon poste.'
        value = raw(request, [fact('q1', status='planned')])
        r, _ = project(value, request)
        self.assertEqual(r['moments'][0]['subject'], 'owner')
        self.assertEqual(r['moments'][0]['occurrenceStatus'], 'planned')
        reply = 'Voici la copie de votre contrat de travail.'
        ctx = actors.context(reply, direction='received', sender='Riley Sample <riley@example.test>',
                             owner_aliases=['Owner Example'])
        value = raw(reply, [fact('q1', kind='work-correspondence', category='work', subject='thirdparty')], ctx)
        r, _ = project(value, reply, ctx)
        self.assertEqual(len(r['moments']), 1)
        self.assertEqual(r['moments'][0]['subject'], 'thirdparty')
        self.assertEqual(r['moments'][0]['occurrenceStatus'], 'reported')
        self.assertIsNone(r['moments'][0]['startDate'])

    def test_contact_in_an_actual_body_statement_is_not_a_signature(self):
        body = 'Votre abonnement a été annulé, contact : support@example.test'
        self.assertFalse(selection.excluded(grounding.catalog(body)))
        # A signatory can differ from the container sender; exclude the role
        # line without reconciling or asserting those identities.
        signature = 'Morgan Other — Instructeur'
        self.assertEqual(selection.excluded(grounding.catalog(signature), META), {'q1'})
        postscript = 'Cordialement\nMorgan Other\nPS : mon déménagement est terminé.'
        self.assertNotIn('q3', selection.excluded(grounding.catalog(postscript), META))
        for contact in ('https://example.test/is/confirmed', 'Web : https://example.test/is/a/guide',
                        'has.confirmed@example.test'):
            self.assertEqual(selection.excluded(grounding.catalog(contact), META), {'q1'})

    def test_v14_fingerprint_and_projection_remain_frozen(self):
        self.assertEqual(hashed(grounding.SCHEMA), 'b613321adff92920ce227f88c2f656743d1d97ac3f46c553b89dec006c8679e9')
        body = 'Mon voyage...';value = v14.raw(cues={'q1': [v14.moment('q1', category='travel')]})
        r, changes = v14.project(value, body)
        self.assertEqual(changes[0]['contract'], grounding.CONTRACT)
        self.assertNotIn('sourceSelection', changes[0])
        self.assertEqual(grounding.contract_for({'responseSchemaSha256': hashed(grounding.CURRENT_SCHEMA)}), selection.CONTRACT)

    def test_ordinary_lines_do_not_duplicate_the_full_context_schema_per_anchor(self):
        sizes = []
        for n in (8, 32):
            body = '\n'.join('Une information générale numéro ' + str(i) + '.' for i in range(n))
            schema = grounding.schema_for(body, selection.CONTRACT, SENT)
            sizes.append(len(json.dumps(schema)))
        self.assertLess(sizes[1], 6 * sizes[0])
        body = 'Une information générale.\nUne autre information.'
        value = raw(body, [fact('q1')]);value['retainedMoments'][0]['contextObservations'] = [
            {'citationId': 'q1', 'qualificationIds': []}]
        with self.assertRaises(ValueError):project(value, body)


class SourceSelectionWorkerTests(unittest.TestCase):
    setUp = scoped.InputScopeTests.setUp
    mail = scoped.InputScopeTests.mail
    prepare = scoped.InputScopeTests.prepare
    no_attachment_reads = scoped.InputScopeTests.no_attachment_reads
    def test_native_transport_receipts_metadata_replay_and_no_attachment_open(self):
        self.mail('message01', 'Riley Sample\nInstructeur\n555-012-9876', filename='navigation.docx')
        objective, manifest = self.prepare()
        self.assertEqual(grounding.contract_for(manifest), selection.CONTRACT)
        class Client(scoped.CapturingClient):
            def extract(client, system, prompt, **kwargs):
                client.calls.append(kwargs.get('request_id'))
                p = json.loads(prompt);client.payloads.append(p);client.systems.append(system)
                ctx = {'primarySource': {'identity': {}, 'headers': p['source']['headers'],
                                        'attachmentMetadata': p['source']['attachmentMetadata']}}
                return raw(p['untrustedContent'], context=ctx, documents={'a1': 'retain-reference'})
        client = Client()
        with self.no_attachment_reads():
            result = worker.run(self.root, objective, manifest, client, queue_id=scoped.QUEUE, dispatch_id=scoped.DISPATCH,
                                max_pages=2, max_seconds=10)
        self.assertEqual(result['newlyReviewedPages'], 1)
        self.assertIn(selection.CONTRACT, client.systems[0]);self.assertNotIn('Use the source-span grounding contract secretary.objective-grounding/v14', client.systems[0])
        self.assertEqual(client.payloads[0]['attachmentMetadataCatalog'][0]['filename'], 'navigation.docx')
        path = next((objective / 'page-reviews').glob('*.json'));receipt = worker.read_receipt(path, manifest)
        self.assertFalse(receipt['result']['moments'])
        self.assertEqual(receipt['resultProcessing']['changes'][0]['sourceSelection']['documentReferences'][0]['filename'], 'navigation.docx')
        with self.no_attachment_reads():
            again = worker.run(self.root, objective, manifest, client, queue_id=scoped.QUEUE, dispatch_id=scoped.DISPATCH,
                               max_pages=2, max_seconds=10)
        self.assertEqual(again['inferenceCalls'], 0);self.assertEqual(len(client.calls), 1)
        receipt['sourceRecord']['nativeRef']['primarySource']['attachmentMetadata'][0]['filename'] = 'tampered.docx'
        save(path, receipt)
        with self.assertRaises(ValueError):worker.read_receipt(path, manifest)

    def test_old_preparation_reopens_with_identical_manifest_without_new_default(self):
        self.mail('message01', 'Synthetic note.')
        with patch.object(worker, 'SCHEMA', grounding.SCHEMA):
            objective, old = self.prepare()
        digest = hashed(load(objective / 'manifest.json'))
        _, reopened = worker.prepare(self.root, worker.config_at(self.file))
        self.assertEqual(old, reopened);self.assertEqual(digest, hashed(load(objective / 'manifest.json')))
