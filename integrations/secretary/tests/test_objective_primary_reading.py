"""Synthetic v17 reading boundaries, without real mail, attachments or models."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_grounding as grounding
import objective_primary_reading as primary
import objective_source_repetition as repeats
import objective_selection_schema as wire
import objective_review as worker
from objective_schema import normalize_representation, validate, INSTRUCTIONS
from evidence_store import load, save
from review_receipts import hashed
import test_objective_source_selection as v15
import test_objective_date_selection as v16
import test_objective_actor_context as actors
import test_objective_input_scope as scoped
import test_objective_dispositions as rejected

OWNER = 'Owner Example <owner@example.test>'
OTHER = 'Riley Sample <riley@example.test>'
REQUEST = 'I request cancellation of my membership. Please end access on 9 October.'
REPLY = 'I confirm your membership cancellation for 9 October.'


def fact(anchor, **kwargs):
    m = v15.fact(anchor, **kwargs)
    m['primaryObservation'] = {'citationId': m.pop('anchorCitationId'),
                               'qualificationIds': m.pop('qualificationIds')}
    for side in ('start', 'end'):
        assert m.pop(side + 'DateRef') is None
        m[side + 'DateSelection'] = None
    return m


def raw(body, facts=None, context=None, documents=None):
    ctx = {**v15.SENT, **(context or {})}
    facts = facts or []
    decisions = {r['id']: {'retained': True} if any(m['primaryObservation']['citationId'] == r['id'] for m in facts)
                 else {'reasonRef': r['omissionChoices'][0]['id']}
                 for r in primary.catalog(grounding.catalog(body), ctx)}
    reasons = [r for r in primary.omission_catalog(grounding.catalog(body), ctx) if r.get('scope') == 'passage']
    reason = next((r for r in reasons if r['reasonCode'] == 'selected-copy-context'), reasons[0] if reasons else None)
    outcome = 'uncertain' if reason and reason['reasonCode'] in primary.SELECTOR.selection.UNCERTAIN else 'no-life-event'
    return {'readingContract': primary.CONTRACT, 'retainedMoments': facts, 'cueDecisions': decisions,
            'documentDecisions': documents or {r['id']: 'omit' for r in primary.SELECTOR.documents(ctx)},
            'emptyAssessment': outcome, 'abstention': None if facts else {'reasonRef': reason['id']}, 'gaps': []}


def response(payload, invalid=False):
    """Native test client only; never adapts production output."""
    value = v16.response(payload, invalid)
    value['readingContract'] = primary.CONTRACT
    for m in value['retainedMoments']:
        m['primaryObservation'] = {'citationId': m.pop('anchorCitationId'),
                                   'qualificationIds': m.pop('qualificationIds')}
    return value


def context(body, peer=REQUEST, *, direction='received'):
    ctx = actors.context(body, direction=direction, sender=OTHER if direction == 'received' else OWNER,
                         owner_aliases=['Owner Example'])
    def member(key, text, sender):
        return {'sourceKey': 'gmail:' + key, 'messageId': key, 'sourceSha256': hashlib.sha256(key.encode()).hexdigest(),
            'headers': {'from': sender}, 'chronologyKnown': True,
            'representation': {'mimeType': 'text/plain', 'partIndex': 1,
                               'textSha256': hashlib.sha256(text.encode()).hexdigest()}, 'untrustedContent': text}
    own = member('reply001', body, OTHER)
    ctx['primarySource'] = {'identity': {'system': 'gmail', 'messageId': own['messageId'],
                                       'sourceSha256': own['sourceSha256']}, 'headers': own['headers']}
    ctx['selectedInputContext'] = {'contract': scoped.scoped.CONTRACT, 'attachmentContentsIncluded': False,
        'members': [member('request001', peer, OWNER), own]}
    return ctx


def project(value, body, ctx=None):
    ctx = {**v15.SENT, **(ctx or {}), 'end': len(body), 'totalChars': len(body)}
    before = copy.deepcopy(value)
    result, changes = normalize_representation(value, body, primary.CONTRACT, ctx)
    assert before == value
    validate(result, body)
    return result, changes


class PrimaryReadingTests(unittest.TestCase):
    def test_primary_qualification_is_bound_in_generation_not_repaired(self):
        body = 'I manage the registration data.\nIf I get a reply, I can help.'
        value = raw(body, [fact('q1')])
        result, changes = project(value, body)
        self.assertEqual(len(result['moments']), 1)
        self.assertFalse(result['moments'][0]['relationHints'])
        self.assertEqual(changes[0]['primaryReading']['nativePrimaryObservations'][0]['qualificationIds'], [])
        invalid = copy.deepcopy(value)
        invalid['retainedMoments'][0]['primaryObservation']['qualificationIds'] = ['u1']
        schema = grounding.schema_for(body, primary.CONTRACT, v15.SENT)
        self.assertFalse(wire.matches(invalid, schema))
        with self.assertRaisesRegex(ValueError, 'frozen page schema'):project(invalid, body)

    def test_a_genuine_primary_condition_and_context_condition_remain_selectable(self):
        body = 'If I get approval, I plan a workshop.\nAnother observation.'
        value = raw(body, [fact('q1', status='planned')])
        value['retainedMoments'][0]['primaryObservation']['qualificationIds'] = ['u1']
        result, _ = project(value, body)
        self.assertTrue(result['moments'][0]['relationHints'])
        body = 'I manage the registration data.\nIf I get approval, I can help.'
        value = raw(body, [fact('q1')])
        value['retainedMoments'][0]['contextObservations'] = [{'citationId': 'q2', 'qualificationIds': ['u1']}]
        result, _ = project(value, body)
        self.assertIn('q2', result['moments'][0]['relationHints'][0])

    def test_quoted_selected_request_is_context_only_but_confirmation_is_retained(self):
        body = REPLY + '\nFrom: ' + OWNER + '\nI request cancellation of my membership.\nPlease end access on 9 October.'
        ctx = context(body)
        rows = repeats.catalog(grounding.catalog(body), ctx)
        self.assertEqual({r['citationId'] for r in rows}, {'q3', 'q4'})
        self.assertEqual([r['id'] for r in primary.catalog(grounding.catalog(body), ctx)], ['q1'])
        value = raw(body, [fact('q1', subject='thirdparty')], ctx)
        value['retainedMoments'][0]['contextObservations'] = [{'citationId': 'q3', 'qualificationIds': []}]
        result, changes = project(value, body, ctx)
        self.assertEqual(len(result['moments']), 1)
        self.assertIn('I request cancellation', result['moments'][0]['description'])
        proof = changes[0]['primaryReading']['quotedSourceRepeatCatalog']
        self.assertEqual(proof, rows)
        match = proof[0]['selectedSourceMatches'][0]
        self.assertEqual(REQUEST[match['start']:match['end']], match['text'])
        self.assertFalse(proof[0]['identityVerified']);self.assertFalse(proof[0]['eventEquivalenceVerified'])
        invalid = copy.deepcopy(value);invalid['retainedMoments'].append(fact('q3', subject='unknown', status='planned'))
        with self.assertRaises(ValueError):project(invalid, body, ctx)

    def test_whitespace_and_quote_prefixes_only_never_paraphrase_or_negation(self):
        body = REPLY + '\nFrom: ' + OWNER + '\n> I request cancellation of my membership.'
        ctx = context(body, peer='I request\t cancellation of my membership.')
        self.assertEqual(len(repeats.catalog(grounding.catalog(body), ctx)), 1)
        for different in ('I do not request cancellation of my membership.',
                          'I request renewal of my membership.', 'I REQUEST cancellation of my membership.'):
            self.assertFalse(repeats.catalog(grounding.catalog(body), context(body, peer=different)))
        self.assertFalse(repeats.catalog(grounding.catalog(body), context(body, peer='xI request cancellation of my membership.')))
        self.assertEqual(len(repeats.catalog(grounding.catalog(body), context(
            body, peer='xI request cancellation of my membership. I request cancellation of my membership.'))), 1)

    def test_unmatched_quotes_and_unsupported_peer_order_keep_old_capability(self):
        body = REPLY + '\nFrom: ' + OWNER + '\nMy trip is planned.'
        ctx = context(body)
        self.assertFalse(repeats.catalog(grounding.catalog(body), ctx))
        value = raw(body, [fact('q1', subject='thirdparty'), fact('q3', subject='unknown', status='planned', category='travel')], ctx)
        result, _ = project(value, body, ctx)
        self.assertEqual(len(result['moments']), 2)
        repeated = REPLY + '\nFrom: ' + OWNER + '\n' + REQUEST
        for kind in ('missing', 'later', 'unknown', 'quoted-peer', 'wrong-pin', 'authored-current'):
            ctx = context(repeated)
            if kind == 'missing':ctx.pop('selectedInputContext')
            elif kind == 'later':ctx['selectedInputContext']['members'].reverse()
            elif kind == 'unknown':ctx['selectedInputContext']['members'][0]['chronologyKnown'] = False
            elif kind == 'quoted-peer':ctx = context(repeated, peer='From: ' + OWNER + '\n' + REQUEST)
            elif kind == 'wrong-pin':ctx['selectedInputContext']['members'][0]['representation']['textSha256'] = '0' * 64
            else:ctx['actorSourceSegments'] = [{**ctx['actorSourceSegments'][0], 'start': 0, 'end': len(repeated), 'relation': 'authored'}]
            with self.subTest(kind=kind):self.assertFalse(repeats.catalog(grounding.catalog(repeated), ctx))
        different_speaker = REPLY + '\nFrom: Morgan Other <morgan@example.test>\n' + REQUEST
        self.assertFalse(repeats.catalog(grounding.catalog(different_speaker), context(different_speaker)))
        ctx = context(repeated)
        ctx['selectedInputContext']['members'][-1]['representation']['textSha256'] = '0' * 64
        self.assertFalse(repeats.catalog(grounding.catalog(repeated), ctx))

    def test_page_with_only_selected_quote_can_abstain_without_a_new_event(self):
        body = 'From: ' + OWNER + '\n' + REQUEST
        ctx = context(body)
        value = raw(body, context=ctx)
        self.assertEqual(value['abstention']['reasonRef'], 'copy-context')
        result, changes = project(value, body, ctx)
        self.assertFalse(result['moments'])
        self.assertTrue(changes[0]['primaryReading']['quotedSourceRepeatCatalog'])

    def test_same_words_with_a_conflicting_explicit_quote_date_are_not_suppressed(self):
        body = REPLY + '\nFrom: ' + OWNER + '\nDate: Thu, 2 Oct 2031 12:00:00 +0000\n' + REQUEST
        ctx = context(body)
        ctx['selectedInputContext']['members'][0]['headers']['date'] = 'Wed, 1 Oct 2031 12:00:00 +0000'
        self.assertFalse(repeats.catalog(grounding.catalog(body), ctx))
        ctx['selectedInputContext']['members'][0]['headers']['date'] = 'Thu, 2 Oct 2031 12:00 +0000'
        self.assertTrue(repeats.catalog(grounding.catalog(body), ctx))

    def test_repeated_work_request_remains_context_for_its_later_transmission(self):
        request = 'Please send my work contract.'
        body = 'Voici la copie de votre contrat de travail.\nFrom: ' + OWNER + '\n' + request
        ctx = context(body, peer=request)
        value = raw(body, [fact('q1', subject='thirdparty', kind='work-correspondence', category='work')], ctx)
        value['retainedMoments'][0]['subjectName'] = 'Riley Sample'
        value['retainedMoments'][0]['contextObservations'] = [{'citationId': 'q3', 'qualificationIds': []}]
        result, _ = project(value, body, ctx)
        self.assertEqual(len(result['moments']), 1)
        self.assertIn(request, result['moments'][0]['quotes'])
        self.assertNotIn('q3', value['cueDecisions'])

    def test_document_metadata_and_explicit_date_observation_are_preserved(self):
        body = 'Riley Sample\nInstructeur\n555-012-9876'
        value = raw(body, context=v15.META, documents={'a1': 'retain-reference'})
        result, changes = project(value, body, v15.META)
        self.assertFalse(result['moments'])
        self.assertFalse(changes[0]['sourceSelection']['documentReferences'][0]['contentRead'])
        body = 'Mon déménagement est terminé.\nLa remise des clés a eu lieu le 8 juillet 2020.'
        value = raw(body, [fact('q1', category='home')])
        v16.choose(value, body, citation='q2')
        result, _ = project(value, body)
        self.assertEqual(result['moments'][0]['startDate'], '2020-07-08')

    def test_legacy_v16_schema_prompt_and_local_rejection_stay_frozen(self):
        self.assertEqual(hashed(grounding.SCHEMA_V16), '98d09e37139c961e4ed7bb634b3f661349ebc0428431635f16f454261d8e240c')
        self.assertEqual(grounding.instructions(INSTRUCTIONS, v16.dates.CONTRACT),
                         INSTRUCTIONS.split('Use the source-span grounding contract ', 1)[0] + v16.dates.POLICY)
        body = 'I manage the registration data.\nIf I get a reply, I can help.'
        value = v16.raw(body, [v15.fact('q1')]);value['retainedMoments'][0]['qualificationIds'] = ['u1']
        with self.assertRaisesRegex(ValueError, 'qualification belongs only'):v16.project(value, body)
        self.assertNotEqual(hashed(grounding.CURRENT_SCHEMA), hashed(grounding.SCHEMA_V16))
        self.assertEqual(hashed(grounding.CURRENT_SCHEMA), '4c63bebd300a8a637a62a05dd7397cf4194fc8e30bb277932538148e7dd5affe')

    def test_unknown_primary_and_legacy_field_bypasses_fail_closed(self):
        body = 'I manage the registration data.'
        value = raw(body, [fact('q1')])
        for change in ('unknown', 'legacy-fields', 'wrong-contract'):
            bad = copy.deepcopy(value)
            if change == 'unknown':bad['retainedMoments'][0]['primaryObservation']['citationId'] = 'q99'
            elif change == 'legacy-fields':bad['retainedMoments'][0]['qualificationIds'] = []
            else:bad['readingContract'] = v16.dates.CONTRACT
            with self.subTest(change=change), self.assertRaises(ValueError):project(bad, body)

    def test_schema_does_not_copy_fact_context_for_every_qualified_anchor(self):
        sizes = []
        for n in (8, 32):
            body = '\n'.join('If I get permission, a workshop number ' + str(i) + ' is possible.' for i in range(n))
            sizes.append(len(json.dumps(grounding.schema_for(body, primary.CONTRACT, v15.SENT))))
        self.assertLess(sizes[1], 6 * sizes[0])


class PrimaryReadingWorkerTests(unittest.TestCase):
    setUp = scoped.InputScopeTests.setUp
    mail = scoped.InputScopeTests.mail
    prepare = scoped.InputScopeTests.prepare
    no_attachment_reads = scoped.InputScopeTests.no_attachment_reads

    def test_selected_pair_reaches_native_generation_with_context_only_copy(self):
        self.mail('request01', REQUEST, stamp=1000)
        self.mail('response01', REPLY + '\nFrom: ' + OWNER + '\n' + REQUEST, stamp=2000)
        self.groups = [[p['sourceKey'] for p in self.pins]]
        objective, manifest = self.prepare()
        class Client(scoped.CapturingClient):
            def extract(client, system, prompt, **kwargs):
                payload = json.loads(prompt)
                client.calls.append(kwargs.get('request_id'));client.payloads.append(payload)
                reply = payload['source']['id'] == 'response01'
                m = fact('q1', status='reported' if reply else 'planned')
                if reply:m['contextObservations'] = [{'citationId': 'q3', 'qualificationIds': []}]
                return {'readingContract': primary.CONTRACT, 'retainedMoments': [m],
                        'cueDecisions': {r['id']: {'retained': True} for r in payload['selectionCues']},
                        'documentDecisions': {}, 'emptyAssessment': 'no-life-event', 'abstention': None, 'gaps': []}
        client = Client()
        with self.no_attachment_reads():
            result = worker.run(self.root, objective, manifest, client, queue_id=scoped.QUEUE,
                                dispatch_id=scoped.DISPATCH, max_pages=6, max_seconds=10)
        self.assertEqual(result['newlyReviewedPages'], 2)
        self.assertEqual(len(client.calls), 2)
        reply = next(p for p in client.payloads if p['source']['id'] == 'response01')
        self.assertEqual([r['citationId'] for r in reply['quotedSourceRepeatCatalog']], ['q3'])
        self.assertEqual([r['id'] for r in reply['selectionCues']], ['q1'])
        receipts = [worker.read_receipt(p, manifest) for p in (objective / 'page-reviews').glob('*.json')]
        self.assertEqual(sum(len(r['result']['moments']) for r in receipts), 2)

    def test_frozen_packet_reaches_receipt_and_cannot_be_tampered_or_replayed(self):
        self.mail('message01', 'Mon déménagement est terminé.', filename='sealed.docx')
        objective, manifest = self.prepare()
        client = scoped.CapturingClient()
        with self.no_attachment_reads():
            result = worker.run(self.root, objective, manifest, client, queue_id=scoped.QUEUE,
                                dispatch_id=scoped.DISPATCH, max_pages=2, max_seconds=10)
            again = worker.run(self.root, objective, manifest, client, queue_id=scoped.QUEUE,
                               dispatch_id=scoped.DISPATCH, max_pages=2, max_seconds=10)
        self.assertEqual(result['newlyReviewedPages'], 1);self.assertEqual(again['inferenceCalls'], 0)
        self.assertEqual(len(client.calls), 1)
        self.assertIn('quotedSourceRepeatCatalog', client.payloads[0])
        path = next((objective / 'page-reviews').glob('*.json'))
        receipt = worker.read_receipt(path, manifest)
        self.assertEqual(receipt['sourceRecord']['nativeRef']['selectedInputContext'], client.payloads[0]['inputContext'])
        missing_attribution = copy.deepcopy(manifest);missing_attribution.pop('attributionContract')
        with self.assertRaises(ValueError):worker.read_receipt(path, missing_attribution)
        receipt['sourceRecord']['nativeRef']['selectedInputContext']['members'][0]['untrustedContent'] = 'tampered'
        save(path, receipt)
        with self.assertRaises(ValueError):worker.read_receipt(path, manifest)

    def test_invalid_primary_qualification_retains_one_rejection_without_retry(self):
        body = 'I manage registration data.\nIf I get approval, I can help.'
        self.mail('message01', body)
        objective, manifest = self.prepare()
        def invalid(payload, reply):
            value = raw(payload['untrustedContent'], [fact('q1')])
            value['retainedMoments'][0]['primaryObservation']['qualificationIds'] = ['u1']
            reply['response'] = json.dumps(value);return reply
        client, calls = rejected.DispositionTests.client(self, output=invalid)
        with self.no_attachment_reads():
            result = worker.run(self.root, objective, manifest, client, queue_id=scoped.QUEUE,
                dispatch_id=scoped.DISPATCH, max_pages=2, max_seconds=10, retain_rejected_pages=True)
            again = worker.run(self.root, objective, manifest, client, queue_id=scoped.QUEUE,
                dispatch_id=scoped.DISPATCH, max_pages=2, max_seconds=10, retain_rejected_pages=True)
        self.assertEqual(result['newlyRejectedPages'], 1)
        self.assertEqual(again['inferenceCalls'], 0);self.assertEqual(len(calls), 1)
        self.assertFalse(list((objective / 'page-reviews').glob('*.json')))
