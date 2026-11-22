"""Synthetic evidence-scoped dates; no archive, model or live service."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_date_evidence as legacy_dates
import objective_date_selection as dates
import objective_grounding as grounding
import objective_review as worker
import objective_selection_schema as wire
from objective_schema import normalize_representation, validate, INSTRUCTIONS
from evidence_store import save, load
from review_receipts import hashed
import test_objective_source_selection as v15
import test_objective_input_scope as scoped
import test_objective_dispositions as rejected


def native(value):
    value = copy.deepcopy(value)
    for moment in value['retainedMoments']:
        for side in ('start', 'end'):
            assert moment.pop(side + 'DateRef') is None
            moment[side + 'DateSelection'] = None
    return value


def response(payload, invalid=False):
    return native(v15.response(payload, invalid))


def raw(body, facts=None, context=None, documents=None):
    return native(v15.raw(body, facts, context, documents))


def choose(value, body, *, side='start', citation='q1', context=None, index=0, qualification_ids=None):
    row = next(r for r in dates.catalog(grounding.catalog(body), context) if r['citationId'] == citation)
    value['retainedMoments'][index][side + 'DateSelection'] = {'reference': row['id'], 'observation':
        None if row['kind'] == 'communication' else {'citationId': citation, 'qualificationIds': qualification_ids or []}}
    return row


def project(value, body, context=None):
    context = {**v15.SENT, **(context or {}), 'end': len(body), 'totalChars': len(body)}
    result, changes = normalize_representation(value, body, dates.CONTRACT, context)
    validate(result, body)
    return result, changes


class DateSelectionTests(unittest.TestCase):
    def test_french_and_english_headers_are_communication_only(self):
        for header in ("Date d'envoi", 'Date d’envoi', 'Envoyé le', 'Envoyé', 'Date', 'Sent on', 'Sent'):
            with self.subTest(header=header):
                body = '> > ' + header + ' : 8 juillet 2020 12:31'
                row = dates.catalog(grounding.catalog(body))[0]
                self.assertEqual(row['kind'], 'communication')
                self.assertEqual(row['value'], '2020-07-08')
                self.assertEqual(body[row['start']:row['end']], row['text'])
        body = "La date d'envoi est le 8 juillet 2020."
        self.assertEqual(dates.catalog(grounding.catalog(body))[0]['kind'], 'event-expression')
        self.assertFalse(dates.catalog(grounding.catalog("Date d’envoi : 8 juillet")))

    def test_confirmation_and_quoted_request_cannot_borrow_header_date(self):
        body = ("Je confirme votre annulation pour le 28 juin.\n"
                "From: Owner Example <owner@example.test>\n"
                "Date d'envoi : 8 juillet 2020 12:31\n"
                "Je souhaite la fin de mon abonnement au 28 juin.")
        ctx = {'direction': 'unknown'}
        value = raw(body, [v15.fact('q1', subject='unknown'),
                          v15.fact('q4', subject='unknown', status='planned')], ctx)
        before = copy.deepcopy(value)
        bad = copy.deepcopy(value);choose(bad, body, citation='q3', index=1)
        schema = grounding.schema_for(body, dates.CONTRACT, {**v15.SENT, **ctx})
        self.assertFalse(wire.matches(bad, schema))
        with self.assertRaisesRegex(ValueError, 'frozen page schema'):project(bad, body, ctx)
        result, _ = project(value, body, ctx)
        self.assertEqual(len(result['moments']), 2)
        self.assertEqual(value, before)
        self.assertTrue(all(m['startDate'] is None for m in result['moments']))

    def test_event_date_is_selected_with_its_own_body_observation(self):
        body = 'Mon déménagement est terminé.\nLa remise des clés a eu lieu le 8 juillet 2020.'
        value = raw(body, [v15.fact('q1', category='home')])
        row = choose(value, body, citation='q2')
        before = copy.deepcopy(value)
        result, changes = project(value, body)
        self.assertEqual(value, before)
        self.assertEqual(result['moments'][0]['startDate'], '2020-07-08')
        self.assertIn(body.splitlines()[1], result['moments'][0]['quotes'])
        proof = changes[0]['dateSelection']
        self.assertEqual(proof['nativeSelections'][0]['observation']['citationId'], 'q2')
        self.assertEqual(proof['dateCatalog'][0], row)
        self.assertEqual(changes[0]['contract'], dates.CONTRACT)
        self.assertEqual(changes[0]['sourceSelection']['contract'], dates.CONTRACT)
        for obs in (None, {'citationId': 'q1', 'qualificationIds': []},
                    {'citationId': 'q99', 'qualificationIds': []}):
            invalid = copy.deepcopy(value)
            invalid['retainedMoments'][0]['startDateSelection']['observation'] = obs
            self.assertFalse(wire.matches(invalid, grounding.schema_for(body, dates.CONTRACT, v15.SENT)))
            with self.assertRaises(ValueError):project(invalid, body)

    def test_same_anchor_date_and_selected_context_do_not_duplicate_observations(self):
        body = 'Mon déménagement est terminé le 8 juillet 2020.'
        value = raw(body, [v15.fact('q1', category='home')]);choose(value, body)
        value['retainedMoments'][0]['endDateSelection'] = copy.deepcopy(value['retainedMoments'][0]['startDateSelection'])
        result, _ = project(value, body)
        self.assertEqual(result['moments'][0]['originalDate'], '8 juillet 2020')
        self.assertEqual(len(result['moments'][0]['quotes']), 1)

    def test_communication_date_allowed_only_for_start_of_supported_work_fact(self):
        body = "Voici mon CV pour le contact professionnel.\nDate d’envoi : 8 juillet 2020 12:31"
        value = raw(body, [v15.fact('q1', category='work', kind='career-contact')])
        choose(value, body, citation='q2')
        result, _ = project(value, body)
        self.assertEqual(result['moments'][0]['startDate'], '2020-07-08')
        self.assertIn('date une communication', result['moments'][0]['uncertainty'])
        invalid = copy.deepcopy(value)
        invalid['retainedMoments'][0]['endDateSelection'] = invalid['retainedMoments'][0]['startDateSelection']
        with self.assertRaises(ValueError):project(invalid, body)
        invalid = copy.deepcopy(value);invalid['retainedMoments'][0]['factType'] = 'life-event'
        with self.assertRaises(ValueError):project(invalid, body)
        ctx = {'mailDate': '2020-07-08T12:31:00+00:00'}
        value['retainedMoments'][0]['startDateSelection'] = {'reference': 'm0', 'observation': None}
        result, _ = project(value, body, ctx)
        self.assertEqual(result['moments'][0]['startDate'], '2020-07-08')

    def test_partial_dates_keep_unknown_year_and_primary_anchor_scope(self):
        body = 'Je confirme votre annulation pour le 28 juin.\nAutre information.'
        value = raw(body, [v15.fact('q1')]);choose(value, body)
        result, _ = project(value, body, {'mailDate': '2020-07-08T12:31:00+00:00'})
        self.assertIsNone(result['moments'][0]['startDate'])
        self.assertEqual(result['moments'][0]['startPrecision'], 'unknown')
        self.assertEqual(result['moments'][0]['originalDate'], '28 juin.')
        invalid = copy.deepcopy(value);invalid['retainedMoments'][0]['anchorCitationId'] = 'q2'
        with self.assertRaises(ValueError):project(invalid, body)

    def test_qualifications_are_local_and_cannot_be_overwritten_by_a_date(self):
        body = 'Mon déménagement est terminé.\nLa remise des clés sera peut-être le 8 juillet 2020.'
        value = raw(body, [v15.fact('q1', category='home')])
        row = grounding.source_observations.qualification_catalog(grounding.catalog(body))[0]
        choose(value, body, citation='q2', qualification_ids=[row['id']])
        result, _ = project(value, body)
        self.assertTrue(result['moments'][0]['relationHints'])
        value['retainedMoments'][0]['contextObservations'] = [{'citationId': 'q2', 'qualificationIds': []}]
        with self.assertRaisesRegex(ValueError, 'consistent excerpt qualifications'):project(value, body)

    def test_document_only_abstention_and_registration_preserve_v15_bounds(self):
        body = 'Riley Sample\nInstructeur\n555-012-9876'
        value = raw(body, context=v15.META, documents={'a1': 'retain-reference'})
        result, changes = project(value, body, v15.META)
        self.assertFalse(result['moments'])
        self.assertFalse(changes[0]['sourceSelection']['documentReferences'][0]['contentRead'])
        body = 'Cest moi qui traite les donnés des inscriptions.'
        value = raw(body, [v15.fact('q1')]);result, _ = project(value, body)
        self.assertEqual(result['moments'][0]['category'], 'daily')
        self.assertEqual(result['moments'][0]['claimType'], 'direct')

    def test_frozen_v15_catalog_schema_prompt_and_rejection(self):
        self.assertEqual(hashed(grounding.SCHEMA_V15), '2bbbf6396f4814191b63dc76d5413059e7a38c2178874a79585e3e4561bf626c')
        self.assertEqual(hashed(grounding.SCHEMA), 'b613321adff92920ce227f88c2f656743d1d97ac3f46c553b89dec006c8679e9')
        self.assertEqual(grounding.instructions(INSTRUCTIONS, v15.selection.CONTRACT),
                         INSTRUCTIONS.split('Use the source-span grounding contract ', 1)[0] + v15.selection.POLICY)
        body = "Mon déménagement est terminé.\nDate d'envoi : 8 juillet 2020 12:31"
        rows = legacy_dates.catalog(grounding.catalog(body))
        self.assertEqual(rows[0]['kind'], 'event-expression')
        value = v15.raw(body, [v15.fact('q1', category='home')])
        value['retainedMoments'][0]['startDateRef'] = rows[0]['id']
        with self.assertRaisesRegex(ValueError, "event's own observations"):v15.project(value, body)
        self.assertNotEqual(hashed(grounding.SCHEMA_V16), hashed(grounding.SCHEMA_V15))
        self.assertEqual(hashed(grounding.SCHEMA_V16), '98d09e37139c961e4ed7bb634b3f661349ebc0428431635f16f454261d8e240c')
        self.assertEqual(grounding.contract_for({'responseSchemaSha256': hashed(grounding.SCHEMA_V16)}), dates.CONTRACT)

    def test_schema_growth_stays_bounded_for_ordinary_lines(self):
        sizes = []
        for n in (8, 32):
            body = '\n'.join('Une information générale numéro ' + str(i) + '.' for i in range(n))
            sizes.append(len(json.dumps(grounding.schema_for(body, dates.CONTRACT, v15.SENT))))
        self.assertLess(sizes[1], 6 * sizes[0])


class DateSelectionWorkerTests(unittest.TestCase):
    setUp = scoped.InputScopeTests.setUp
    mail = scoped.InputScopeTests.mail
    def prepare(self):
        self.config.setdefault("groundingContract", dates.CONTRACT)
        return scoped.InputScopeTests.prepare(self)
    no_attachment_reads = scoped.InputScopeTests.no_attachment_reads

    def test_invalid_header_selection_is_retained_without_partial_salvage_or_retry(self):
        body = "Mon déménagement est terminé.\nDate d’envoi : 8 juillet 2020 12:31"
        self.mail('message01', body)
        objective, manifest = self.prepare()

        def invalid(payload, reply):
            value = response(payload)
            choose(value, payload['untrustedContent'], citation='q2')
            reply['response'] = json.dumps(value)
            return reply

        client, calls = rejected.DispositionTests.client(self, output=invalid)
        with self.no_attachment_reads():
            first = worker.run(self.root, objective, manifest, client, queue_id=scoped.QUEUE,
                dispatch_id=scoped.DISPATCH, max_pages=2, max_seconds=10, retain_rejected_pages=True)
        self.assertEqual(first['newlyRejectedPages'], 1)
        self.assertEqual(first['newlyReviewedPages'], 0)
        retained = next((objective / 'page-dispositions').glob('*.json')).read_bytes()
        original = next((objective / 'review-attempts').glob('*/result.json')).read_bytes()
        with self.no_attachment_reads():
            again = worker.run(self.root, objective, manifest, client, queue_id=scoped.QUEUE,
                dispatch_id=scoped.DISPATCH, max_pages=2, max_seconds=10, retain_rejected_pages=True)
        self.assertEqual(again['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        self.assertFalse(list((objective / 'page-reviews').glob('*.json')))
        self.assertEqual(next((objective / 'review-attempts').glob('*/result.json')).read_bytes(), original)
        self.assertEqual(next((objective / 'page-dispositions').glob('*.json')).read_bytes(), retained)

    def test_native_v16_transport_header_catalog_receipts_and_replay(self):
        body = "Mon déménagement est terminé.\nDate d’envoi : 8 juillet 2020 12:31"
        self.mail('message01', body, filename='sealed.docx')
        objective, manifest = self.prepare()
        self.assertEqual(grounding.contract_for(manifest), dates.CONTRACT)
        client = scoped.CapturingClient()
        with self.no_attachment_reads():
            first = worker.run(self.root, objective, manifest, client, queue_id=scoped.QUEUE,
                               dispatch_id=scoped.DISPATCH, max_pages=2, max_seconds=10)
            again = worker.run(self.root, objective, manifest, client, queue_id=scoped.QUEUE,
                               dispatch_id=scoped.DISPATCH, max_pages=2, max_seconds=10)
        self.assertEqual(first['newlyReviewedPages'], 1)
        self.assertEqual(again['inferenceCalls'], 0)
        self.assertEqual(len(client.calls), 1)
        self.assertIn(dates.CONTRACT, client.systems[0])
        row = next(r for r in client.payloads[0]['dateCatalog'] if r['citationId'] == 'q2')
        self.assertEqual(row['kind'], 'communication')
        path = next((objective / 'page-reviews').glob('*.json'))
        receipt = worker.read_receipt(path, manifest)
        self.assertIn('primarySource', receipt['sourceRecord']['nativeRef'])
        self.assertEqual(receipt['resultProcessing']['changes'][0]['dateSelection']['contract'], dates.CONTRACT)
        receipt['sourceRecord']['nativeRef'].pop('primarySource');save(path, receipt)
        with self.assertRaises(ValueError):worker.read_receipt(path, manifest)

    def test_explicit_v15_preparation_and_reopen_remain_frozen(self):
        self.config['groundingContract'] = v15.selection.CONTRACT
        self.mail('message01', 'Synthetic note.')
        objective, manifest = self.prepare()
        self.assertEqual(grounding.contract_for(manifest), v15.selection.CONTRACT)
        before = hashed(load(objective / 'manifest.json'))
        _, reopened = self.prepare()
        self.assertEqual(manifest, reopened)
        self.assertEqual(before, hashed(load(objective / 'manifest.json')))
