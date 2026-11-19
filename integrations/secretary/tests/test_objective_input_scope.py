import copy
import email.message
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive_read
from evidence_store import load, save
import objective_attribution as attribution
import objective_input_scope as scoped
import objective_review as worker
from objective_schema import SCHEMA as LEGACY_SCHEMA
from objective_sources import inventory, materialize, pages
from test_objective_review import Client, QUEUE, DISPATCH, moment


class CapturingClient(Client):
    def __init__(self):
        super().__init__()
        self.payloads, self.systems = [], []

    def extract(self, system, prompt, **kwargs):
        self.payloads.append(json.loads(prompt))
        self.systems.append(system)
        return super().extract(system, prompt, **kwargs)


class InputScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {'id': 'input', 'version': 'v1', 'kind': 'life-timeline',
                       'ownerAliases': ['Owner Example'],
                       'selection': {'gmailMessageIds': [], 'outlookSha256': []}}
        self.file = self.root / 'objective.json'
        self.pins, self.groups = [], []

    def mail(self, mid, body, *, thread='thread001', filename=None, stamp=1000, rtf=False,
             rfc=None, subject=None):
        message = email.message.EmailMessage()
        message['From'] = 'Owner Example <owner@example.test>'
        message['To'] = 'Recipient Example <recipient@example.test>'
        message['Cc'] = 'copy@example.test'
        message['Date'] = 'Fri, 1 Aug 2014 10:00:00 +0000'
        message['Subject'] = subject or 'Synthetic source ' + mid
        message['Message-ID'] = rfc or '<' + mid + '@example.test>'
        message.set_content(body)
        message.add_alternative('<p>Unselected alternative must not be decoded.</p>', subtype='html')
        if filename:
            message.add_attachment(b'UNREAD SYNTHETIC DOCUMENT', maintype='application',
                                   subtype='octet-stream', filename=filename)
        if rtf:
            message.add_attachment(b'{\\rtf1 UNREAD SYNTHETIC RTF}', maintype='application',
                                   subtype='rtf', filename='unread.rtf')
        raw = message.as_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        path = 'raw/' + sha + '.eml'
        (self.root / 'raw').mkdir(exist_ok=True)
        (self.root / path).write_bytes(raw)
        receipt = {'messageId': mid, 'threadId': thread, 'sha256': sha, 'bytes': len(raw),
                   'path': path, 'internalDate': str(stamp), 'labelIds': ['SENT']}
        save(self.root / 'raw-receipts' / (mid + '.json'), receipt)
        self.config['selection']['gmailMessageIds'].append(mid)
        self.pins.append({'sourceKey': 'gmail:' + mid, 'sourceSha256': sha,
                          'partIndex': 2 if filename or rtf else 1, 'mimeType': 'text/plain',
                          'textSha256': hashlib.sha256((body + '\n').encode()).hexdigest()})
        return receipt

    def prepare(self):
        self.config['inputScope'] = {'contract': scoped.CONTRACT, 'sources': self.pins,
                                    'groups': self.groups or [[p['sourceKey']] for p in self.pins],
                                    'maxContextChars': 24000}
        save(self.file, self.config)
        return worker.prepare(self.root, worker.config_at(self.file))

    def no_attachment_reads(self):
        original = Path.open

        def guarded(path, *args, **kwargs):
            if Path(path).is_relative_to(self.root / 'files'):
                raise AssertionError('Attachment or existing extracted text was opened')
            return original(path, *args, **kwargs)

        return patch.object(Path, 'open', guarded)

    def test_selection_precedes_decode_and_never_opens_attachment_extractions(self):
        self.mail('message01', 'Selected plain note.', filename='plan.docx', rtf=True)
        save(self.root / 'threads/thread001/manifest.json', {'messages': [{'id': 'message01',
             'attachments': [{'filename': 'plan.docx', 'status': 'text_extracted', 'textPath': 'files/forbidden.txt'}]}]})
        _, manifest = self.prepare()
        source = manifest['sources'][0]
        original_text = archive_read._text
        seen = []

        def only_plain(part):
            seen.append(part.get_content_type())
            self.assertEqual(part.get_content_type(), 'text/plain')
            return original_text(part)

        with self.no_attachment_reads(), patch.object(archive_read, '_text', side_effect=only_plain), \
                patch.object(archive_read, 'read_rtf_part', side_effect=AssertionError('RTF attachment decoded')):
            current, units, gaps = materialize(self.root, source, input_scope_config=self.config['inputScope'])
        self.assertEqual(seen, ['text/plain'])
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]['content'], 'Selected plain note.\n')
        self.assertEqual([a['filename'] for a in current['attachmentMetadata']], ['plan.docx', 'unread.rtf'])
        self.assertEqual(gaps[0]['code'], 'attachment-content-excluded-by-input-scope')

    def test_six_messages_reach_native_worker_with_headers_metadata_and_bounded_pairs(self):
        for group, size in [('a', 2), ('b', 1), ('c', 1), ('d', 2)]:
            keys = []
            for n in range(size):
                mid = 'sample' + group + str(n + 1)
                self.mail(mid, 'Synthetic note ' + mid + '.', thread='thread-' + group,
                          filename='document-' + mid + '.docx' if group in ('b', 'd') else None,
                          stamp=1000 + n)
                keys.append('gmail:' + mid)
            self.groups.append(keys)
        save(self.root / 'threads/thread-d/manifest.json', {'messages': [{'id': 'sampled2', 'attachments': [
            {'filename': 'unread.docx', 'status': 'text_extracted', 'textPath': 'files/forbidden.txt'}]}]})
        objective, manifest = self.prepare()
        client = CapturingClient()
        with self.no_attachment_reads():
            result = worker.run(self.root, objective, manifest, client, max_pages=20,
                                queue_id=QUEUE, dispatch_id=DISPATCH)
        self.assertEqual(result['phase'], 'done')
        self.assertEqual(len(client.payloads), 6)
        self.assertEqual(len(client.calls), 6)
        for payload in client.payloads:
            key = scoped.key(payload['source'])
            expected = next(g for g in self.groups if key in g)
            context = payload['inputContext']
            self.assertEqual([m['sourceKey'] for m in context['members']], expected)
            self.assertEqual(set(payload['source']['headers']), {'from', 'to', 'cc', 'date', 'subject'})
            self.assertFalse(context['attachmentContentsIncluded'])
            for member in context['members']:
                self.assertEqual(member['representation']['mimeType'], 'text/plain')
                self.assertIn('Synthetic note', member['untrustedContent'])
                if member['messageId'][6] in ('b', 'd'):
                    self.assertTrue(member['attachmentMetadata'])
            self.assertNotIn('Unselected alternative', json.dumps(payload))
        self.assertTrue(all(scoped.POLICY in s for s in client.systems))
        calls = list(client.calls)
        with self.no_attachment_reads():
            again = worker.run(self.root, objective, manifest, client, max_pages=20,
                               queue_id=QUEUE, dispatch_id=DISPATCH)
        self.assertEqual(again['phase'], 'done')
        self.assertEqual(client.calls, calls)
        self.assertEqual(manifest['inputReadingContract'], scoped.CONTRACT)

    def test_same_primary_text_does_not_alias_different_attachment_envelopes(self):
        shared = {'rfc': '<shared@example.test>', 'subject': 'Same preserved mail'}
        self.mail('message01', 'Same signature.', filename='first-plan.docx', **shared)
        self.mail('message02', 'Same signature.', filename='different-plan.docx', **shared)
        objective, manifest = self.prepare()
        client = CapturingClient()
        with self.no_attachment_reads():
            result = worker.run(self.root, objective, manifest, client, max_pages=10,
                                queue_id=QUEUE, dispatch_id=DISPATCH)
        self.assertEqual(result['phase'], 'done')
        self.assertEqual(len(client.calls), 2)
        self.assertEqual([p['source']['attachmentMetadata'][0]['filename'] for p in client.payloads],
                         ['first-plan.docx', 'different-plan.docx'])
        self.assertFalse(list((objective / 'equivalence-index').glob('*.json')))
        self.assertFalse(list((objective / 'equivalences').glob('*.json')))

    def test_rejected_primary_copy_cannot_defer_a_different_scoped_envelope(self):
        shared = {'rfc': '<shared@example.test>', 'subject': 'Same preserved mail'}
        self.mail('message01', 'Same signature.', filename='first.docx', **shared)
        self.mail('message02', 'Same signature.', filename='second.docx', **shared)

        calls = []

        def opener(request, timeout):
            reply = {'data': {}}
            if request.full_url.endswith('/api/inference/generate'):
                calls.append(json.loads(request.data))
                value = {'summary': 'Invalid quote', 'classification': 'life-events', 'gaps': [],
                         'moments': [moment('Absent quote.')]}
                reply = {'response': json.dumps(value), 'done': True, 'done_reason': 'stop', 'eval_count': 200}
            response = MagicMock(status=200, headers={})
            response.read.return_value = json.dumps(reply).encode()
            response.__enter__.return_value = response
            return response

        with patch.object(worker, 'SCHEMA', LEGACY_SCHEMA):
            objective, manifest = self.prepare()
            client = worker.CoreClient('http://core.invalid', opener=opener, schema=worker.SCHEMA)
            worker.run(self.root, objective, manifest, client, max_pages=10,
                       queue_id=QUEUE, dispatch_id=DISPATCH, retain_rejected_pages=True)
            self.assertEqual(len(calls), 2)
            prompts = [json.loads(call['messages'][-1]['content']) for call in calls]
            self.assertEqual([p['inputContext']['members'][0]['attachmentMetadata'][0]['filename']
                              for p in prompts], ['first.docx', 'second.docx'])
            self.assertEqual(len(list((objective / 'page-dispositions').glob('*.json'))), 2)
            self.assertFalse(list((objective / 'rejected-copy-index').glob('*.json')))
            worker.run(self.root, objective, manifest, client, max_pages=10,
                       queue_id=QUEUE, dispatch_id=DISPATCH, retain_rejected_pages=True)
            self.assertEqual(len(calls), 2)

    def test_immutable_scope_changes_require_new_objective_version(self):
        self.mail('message01', 'A note.')
        _, manifest = self.prepare()
        self.config['inputScope']['maxContextChars'] += 1
        save(self.file, self.config)
        with self.assertRaisesRegex(ValueError, 'another intent'):
            worker.prepare(self.root, worker.config_at(self.file))
        self.assertEqual(load(self.root / 'objective-reviews/input/v1/manifest.json'), manifest)

    def test_bad_config_membership_pins_and_cross_thread_groups_refuse(self):
        self.mail('message01', 'First note.')
        self.mail('message02', 'Second note.', thread='another-thread')
        self.prepare()
        base = copy.deepcopy(self.config)
        cases = []
        wrong = copy.deepcopy(base); wrong['inputScope']['groups'] = [['gmail:message01']]; cases.append(wrong)
        wrong = copy.deepcopy(base); wrong['inputScope']['sources'][0]['partIndex'] = True; cases.append(wrong)
        wrong = copy.deepcopy(base); wrong['inputScope']['contract'] = 'unknown'; cases.append(wrong)
        wrong = copy.deepcopy(base); wrong['inputScope']['groups'] = [['gmail:message01', 'gmail:message02']]; cases.append(wrong)
        wrong = copy.deepcopy(base); wrong['inputScope']['sources'][0]['sourceSha256'] = '0' * 64; cases.append(wrong)
        wrong = copy.deepcopy(base); wrong['selection']['gmailMessageIds'].pop(); cases.append(wrong)
        for i, config in enumerate(cases):
            with self.subTest(case=i):
                config['version'] = 'invalid-' + str(i)
                save(self.file, config)
                with self.assertRaises(ValueError):
                    worker.prepare(self.root, worker.config_at(self.file))
                self.assertFalse((self.root / 'objective-reviews/input' / config['version'] / 'manifest.json').exists())

    def test_representation_mismatch_missing_peer_and_context_budget_refuse_before_extract(self):
        for mode in ['text-hash', 'part-index', 'part-type', 'peer-missing', 'context-budget']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                self.root = Path(tmp)
                self.file = self.root / 'objective.json'
                self.config['selection']['gmailMessageIds'] = []
                self.pins = []
                self.mail('message01', 'A longer synthetic note. ' * 30)
                peer = self.mail('message02', 'A different note. ' * 30, stamp=2000)
                self.groups = [['gmail:message01', 'gmail:message02']]
                if mode == 'text-hash': self.pins[0]['textSha256'] = '0' * 64
                if mode == 'part-index': self.pins[0]['partIndex'] = 999
                if mode == 'part-type': self.pins[0]['mimeType'] = 'text/html'
                objective, manifest = self.prepare()
                if mode == 'peer-missing': (self.root / peer['path']).unlink()
                if mode == 'context-budget':
                    # New version, so the declared bound is part of the frozen intent.
                    self.config['version'] = 'tiny'
                    self.config['inputScope']['maxContextChars'] = 1000
                    save(self.file, self.config)
                    objective, manifest = worker.prepare(self.root, worker.config_at(self.file))
                client = CapturingClient()
                with self.no_attachment_reads():
                    result = worker.run(self.root, objective, manifest, client, max_pages=10,
                                        queue_id=QUEUE, dispatch_id=DISPATCH)
                self.assertEqual(result['phase'], 'source-error')
                self.assertEqual(client.calls, [])

    def test_selected_text_can_never_be_an_attachment(self):
        self.mail('message01', 'A note.', filename='hidden.docx')
        self.pins[0]['partIndex'] = 4
        objective, manifest = self.prepare()
        client = CapturingClient()
        with self.no_attachment_reads():
            result = worker.run(self.root, objective, manifest, client, max_pages=10,
                                queue_id=QUEUE, dispatch_id=DISPATCH)
        self.assertEqual(result['phase'], 'source-error')
        self.assertEqual(client.calls, [])

    def test_frozen_context_and_receipt_tampering_refuse(self):
        self.mail('message01', 'A note.', filename='plan.docx')
        objective, manifest = self.prepare()
        client = CapturingClient()
        worker.run(self.root, objective, manifest, client, max_pages=10, queue_id=QUEUE, dispatch_id=DISPATCH)
        file = next((objective / 'page-reviews').glob('*.json'))
        row = load(file); row['sourceRecord']['nativeRef']['inputContextSha256'] = '0' * 64; save(file, row)
        with self.assertRaisesRegex(ValueError, 'frozen context'):
            worker.read_receipt(file, manifest)

    def test_unknown_chronology_and_unicode_text_are_preserved(self):
        body = 'Été inconnu, caractère 😀 et texte exact.'
        self.mail('message01', body, stamp=0)
        objective, manifest = self.prepare()
        current, units, _ = materialize(self.root, manifest['sources'][0], input_scope_config=self.config['inputScope'])
        plan = list(pages(current, units, manifest['objectiveSha256']))
        attribution.bind_pages(self.root, objective, manifest, current, units, plan)
        payload = {}
        scoped.add_payload(payload, plan[0], manifest)
        member = payload['inputContext']['members'][0]
        self.assertEqual(member['untrustedContent'], body + '\n')
        self.assertFalse(member['chronologyKnown'])
        plan[0]['inputContext']['members'][0]['headers']['to'] = 'forged@example.test'
        with self.assertRaisesRegex(ValueError, 'frozen selected input'):
            scoped.add_payload({}, plan[0], manifest)

    def test_rehashed_cached_metadata_does_not_replace_original_envelope(self):
        self.mail('message01', 'A note.', filename='original.docx')
        objective, manifest = self.prepare()
        current, units, _ = materialize(self.root, manifest['sources'][0], input_scope_config=self.config['inputScope'])
        plan = list(pages(current, units, manifest['objectiveSha256']))
        attribution.bind_pages(self.root, objective, manifest, current, units, plan)
        index = next((objective / 'attribution-index').glob('*.json'))
        evidence = load(objective / 'attribution-evidence' / (load(index)['evidenceSha256'] + '.json'))
        evidence['messages'][0]['attachmentMetadata'][0]['filename'] = 'forged.docx'
        evidence['own']['attachmentMetadata'][0]['filename'] = 'forged.docx'
        digest = worker.hashed(evidence)
        save(objective / 'attribution-evidence' / (digest + '.json'), evidence)
        save(index, {'evidenceSha256': digest})
        with self.assertRaisesRegex(ValueError, 'current frozen sources'):
            attribution.bind_pages(self.root, objective, manifest, current, units, plan)

    def test_peer_context_does_not_expand_primary_citation_authority_or_retry(self):
        self.mail('message01', 'Own note.')
        self.mail('message02', 'Peer-only note.', stamp=2000)
        self.groups = [['gmail:message01', 'gmail:message02']]

        class ForgingClient(CapturingClient):
            def extract(self, system, prompt, **kwargs):
                self.calls.append(kwargs.get('request_id'))
                return {'summary': 'Unsupported primary citation', 'classification': 'life-events', 'gaps': [],
                        'moments': [moment('Peer-only note.')]}

        with patch.object(worker, 'SCHEMA', LEGACY_SCHEMA):
            objective, manifest = self.prepare()
            client = ForgingClient()
            first = worker.run(self.root, objective, manifest, client, max_pages=10,
                               queue_id=QUEUE, dispatch_id=DISPATCH)
            second = worker.run(self.root, objective, manifest, client, max_pages=10,
                                queue_id=QUEUE, dispatch_id=DISPATCH)
        self.assertEqual(first['phase'], 'validation-error')
        self.assertEqual(second['phase'], 'validation-error')
        self.assertEqual(len(client.calls), 1)

    def test_legacy_config_retains_old_input_identity(self):
        self.mail('message01', 'A note.')
        save(self.file, self.config)
        objective, manifest = worker.prepare(self.root, worker.config_at(self.file))
        self.assertNotIn('inputReadingContract', manifest)
        self.assertNotIn('inputScope', manifest['config'])
        client = CapturingClient()
        result = worker.run(self.root, objective, manifest, client, max_pages=10,
                            queue_id=QUEUE, dispatch_id=DISPATCH)
        self.assertEqual(result['phase'], 'done')
        self.assertTrue(all('inputContext' not in p for p in client.payloads))
        self.assertTrue(all(scoped.POLICY not in s for s in client.systems))


if __name__ == '__main__':
    unittest.main()
