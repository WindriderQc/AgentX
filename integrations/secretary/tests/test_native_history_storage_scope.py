"""Synthetic storage observations only: no provider, archive or model calls."""
from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from history_coverage import content_hash
from native_history_decisions import digest
from native_history_message_scope import CONTRACT as MESSAGE_CONTRACT
from native_history_restoration_scope import REVIEW_CONTRACT
from native_history_storage_scope import capture, CONTRACT, STORAGE_CONTRACT, STORAGE_SCOPE, MAX_RESPONSE
from retention_plan import NATIVE_GAPS


class NativeStorageScopeTests(unittest.TestCase):
    def setUp(self):
        self.saved, self.scopes, self.restored_members, self.pins, self.calls = [], [], [], [], []
        self.at = '2026-01-01T12:00:00.000Z'
        for n in range(2):
            ref = {'system': 'gmail', 'messageId': f'1234567890abcde{n}',
                   'threadId': '1234567890abcdef', 'sourceSha256': 'a' * 64}
            self.saved.append({**ref, 'schema': 'agentx.secretary-retention-disposition/v2'})
            pin = {'entryId': str(n + 1) * 24, 'entryRevision': n, 'fingerprint': 'b' * 64, 'sourceBinding': 'exact'}
            self.scopes.append({'reference': ref, 'members': [pin], 'observationId': str(uuid.uuid4()),
                                'observedAt': self.at, 'fingerprint': digest({
                                    'contract': MESSAGE_CONTRACT, 'reference': ref, 'entries': [pin]})})
            graph = {'contract': 'secretary.archive-review-packet/v1', 'evidenceHash': '1' * 64,
                     'reviewSha256': '2' * 64, 'pagesSha256': '3' * 64, 'valueLanesSha256': '4' * 64,
                     'filesSha256': '5' * 64, 'counts': {'files': 7, 'bytes': 1000, 'pages': 1,
                     'attachments': 0, 'compoundMembers': 0}}
            content = {key: ref[key] for key in ('messageId', 'threadId', 'sourceSha256')}
            content.update(raw={'sha256': ref['sourceSha256'], 'bytes': 50}, attachments=[], metadataSha256='6' * 64,
                           partsDecoded=1, attachmentsDecoded=0, reviewPacket=graph)
            restored = {'sourceFilesSha256': '5' * 64, 'restoredFilesSha256': '5' * 64, 'filesCopied': 7,
                        'bytesCopied': 1000, 'temporaryCopyRemoved': True}
            copies = [{'copy': name, 'status': 'available', 'machineIdSha256': machine * 64,
                       'archiveIdSha256': 'e' * 64, 'content': deepcopy(content), 'restoration': deepcopy(restored)}
                      for name, machine in (('primary', 'c'), ('mirror', 'd'))]
            proof = {'contract': 'agentx.history-preservation/v3', 'reference': ref,
                     'scope': 'selected-original-attachments-mime-review-packet-and-temporary-disk-restore',
                     'status': 'verified_scope', 'blockers': [], 'copies': copies}
            check = {'entryId': pin['entryId'], 'requestId': str(uuid.uuid4()), 'snapshotHash': digest(proof), 'source': ref}
            self.restored_members.append({**check, 'snapshot': proof})
            self.pins.append({**check, 'entryRevision': n, 'basisHash': 'f' * 64, 'privacyHash': '9' * 64})
        self.review = {'authority': 'agentx.core', 'contract': REVIEW_CONTRACT, 'status': 'observed_match',
                       'snapshot': {'contract': REVIEW_CONTRACT, 'sourceSetSha256': digest(self.refs()),
                                    'members': self.restored_members, 'pins': self.pins},
                       'consistency': 'retained-restoration-rechecks-with-final-core-fence',
                       'coverage': 'complete-selected-review-packet-source-set', 'atomicBatch': False,
                       'semanticAcceptance': False, 'authenticatedPerson': None, 'executionAllowed': False,
                       'cleanupStatus': 'blocked', 'nativeValidationGaps': list(NATIVE_GAPS),
                       'observationId': str(uuid.uuid4()), 'initialObservationId': str(uuid.uuid4()),
                       'observedAt': self.at, 'initialObservedAt': self.at,
                       'savedDispositionsSha256': content_hash(self.saved)}
        self.rehash_review()
        self.topology = [[self.storage('1'), self.storage('2')] for _ in self.saved]

    def refs(self):
        return [scope['reference'] for scope in self.scopes]

    def storage(self, disk=None):
        return {'contract': STORAGE_CONTRACT, 'scope': STORAGE_SCOPE,
                'status': 'observed_local_devices' if disk else 'unqualified', 'files': 7, 'filesSha256': '5' * 64,
                'physicalDiskIdsSha256': [disk * 64] if disk else [],
                'blockers': [] if disk else ['unsupported_storage_topology'], 'physicalIndependenceAccepted': False}

    def rehash_review(self):
        for member, pin in zip(self.restored_members, self.pins):
            member['snapshotHash'] = pin['snapshotHash'] = digest(member['snapshot'])
        self.review['fingerprint'] = digest(self.review['snapshot'])

    def response(self, request):
        body = json.loads(request.data)
        members = []
        for retained, topology in zip(self.restored_members, self.topology):
            copies = [{**{key: deepcopy(value) for key, value in copy.items() if key != 'status'},
                       'storage': deepcopy(storage)} for copy, storage in zip(retained['snapshot']['copies'], topology)]
            blockers = []
            if any(copy['storage']['status'] == 'unqualified' for copy in copies): blockers.append('storage_topology_unqualified')
            if copies[0]['machineIdSha256'] == copies[1]['machineIdSha256']: blockers.append('same_native_machine')
            if digest(copies[0]['content']) != digest(copies[1]['content']): blockers.append('native_copy_content_mismatch')
            if set(copies[0]['storage']['physicalDiskIdsSha256']) & set(copies[1]['storage']['physicalDiskIdsSha256']):
                blockers.append('kernel_device_identity_overlap')
            members.append({'reference': retained['source'], 'copies': copies,
                            'coverage': {'state': 'held' if blockers else 'distinct_kernel_devices_observed', 'blockers': blockers}})
        held = sum(member['coverage']['state'] == 'held' for member in members)
        snapshot = {'contract': CONTRACT, 'sources': self.refs(), 'sourceSetSha256': digest(self.refs()),
                    'coreScopes': [{'reference': scope['reference'], 'members': scope['members']} for scope in self.scopes],
                    'members': members, 'coverage': {'counts': {'messages': len(members),
                    'distinctKernelDeviceMessages': len(members) - held, 'heldMessages': held},
                    'blockers': ['selected_storage_evidence_held'] if held else []}}
        return {'ok': True, 'data': {'authority': 'agentx.core', 'contract': CONTRACT,
                'observationId': body['observationId'], 'observedAt': self.at, 'snapshot': snapshot,
                'fingerprint': digest(snapshot), 'status': 'observed_match' if 'expected' in body else 'observed',
                'consistency': 'two-complete-storage-passes-with-final-core-fence', 'atomicBatch': False,
                'reviewOnly': True, 'physicalIndependenceAccepted': False, 'semanticAcceptance': False,
                'authenticatedPerson': None, 'approvalBound': False, 'mailboxEffects': 0, 'executionAllowed': False,
                'cleanupStatus': 'blocked', 'nativeValidationGaps': list(NATIVE_GAPS)}}

    def opener(self, mutate=None, *, rehash=True):
        def open_(request, timeout):
            self.calls.append(request)
            self.assertEqual(timeout, 1200)
            self.assertEqual(request.full_url, 'http://core.invalid/api/secretary/history/storage-scope')
            self.assertEqual(request.method, 'POST')
            self.assertEqual(request.get_header('X-service-caller'), 'secretary-retention-review')
            self.assertEqual(set(json.loads(request.data)), {'sources', 'observationId'} | ({'expected'} if len(self.calls) == 2 else set()))
            value = self.response(request)
            if mutate: mutate(value['data'], len(self.calls))
            if rehash: value['data']['fingerprint'] = digest(value['data']['snapshot'])
            return io.BytesIO(json.dumps(value).encode())
        return open_

    def observed(self, mutate=None, *, rehash=True, scopes=None, review=None):
        return capture('http://core.invalid', self.saved, self.scopes if scopes is None else scopes,
                       self.review if review is None else review, opener=self.opener(mutate, rehash=rehash))

    def test_distinct_devices_two_fresh_reads_keep_all_authority_gaps(self):
        result = self.observed(scopes=list(reversed(self.scopes)))
        self.assertEqual(len(self.calls), 2)
        self.assertNotEqual(result['observationId'], result['initialObservationId'])
        self.assertEqual(json.loads(self.calls[1].data)['expected'], result['fingerprint'])
        self.assertEqual(result['savedDispositionsSha256'], content_hash(self.saved))
        self.assertEqual(result['snapshot']['coverage']['counts'], {'messages': 2, 'distinctKernelDeviceMessages': 2, 'heldMessages': 0})
        self.assertFalse(result['physicalIndependenceAccepted']); self.assertFalse(result['executionAllowed'])
        self.assertFalse(result['approvalBound']); self.assertFalse(result['semanticAcceptance'])
        self.assertEqual(result['mailboxEffects'], 0); self.assertEqual(result['cleanupStatus'], 'blocked')
        self.assertEqual(result['nativeValidationGaps'], list(NATIVE_GAPS))

    def test_shared_and_unqualified_devices_are_valid_held_observations(self):
        self.topology[0][1] = self.storage('1'); self.topology[1][0] = self.storage()
        result = self.observed()['snapshot']
        self.assertEqual(result['coverage'], {'counts': {'messages': 2, 'distinctKernelDeviceMessages': 0, 'heldMessages': 2},
                                             'blockers': ['selected_storage_evidence_held']})
        self.assertEqual(result['members'][0]['coverage']['blockers'], ['kernel_device_identity_overlap'])
        self.assertEqual(result['members'][1]['coverage']['blockers'], ['storage_topology_unqualified'])

    def test_expected_copy_differences_hold_in_order_without_accepting_physical_independence(self):
        for member in self.restored_members:
            member['snapshot']['copies'][1]['machineIdSha256'] = 'c' * 64
            member['snapshot']['copies'][1]['content']['metadataSha256'] = '8' * 64
        self.rehash_review()
        self.topology[0][1] = self.storage('1'); self.topology[1][1] = self.storage()
        result = self.observed()
        self.assertEqual(result['snapshot']['members'][0]['coverage']['blockers'],
                         ['same_native_machine', 'native_copy_content_mismatch', 'kernel_device_identity_overlap'])
        self.assertEqual(result['snapshot']['members'][1]['coverage']['blockers'],
                         ['storage_topology_unqualified', 'same_native_machine', 'native_copy_content_mismatch'])
        self.assertFalse(result['physicalIndependenceAccepted'])

    def test_scope_selection_omissions_duplicates_wrong_refs_and_fingerprint_refuse_before_http(self):
        bad = [[], self.scopes[:1], self.scopes + self.scopes[:1], [self.scopes[0], self.scopes[0]]]
        for change in (lambda s: s.update(fingerprint='0' * 64),
                       lambda s: s['reference'].update(sourceSha256='0' * 64),
                       lambda s: s.update(unknown='private'), lambda s: s.update(observedAt='yesterday'),
                       lambda s: s.update(observationId='wrong')):
            scopes = deepcopy(self.scopes); change(scopes[0]); bad.append(scopes)
        for scopes in bad:
            with self.subTest(scopes=scopes), self.assertRaises(ValueError): self.observed(scopes=scopes)
        self.assertEqual(self.calls, [])

    def test_scope_pins_validate_types_bounds_order_and_shared_consistency_even_with_matching_hash(self):
        for mutate in (lambda p: p.update(entryRevision=True), lambda p: p.update(entryRevision=0.0),
                       lambda p: p.update(entryRevision=-1), lambda p: p.update(entryRevision=9007199254740992),
                       lambda p: p.update(sourceBinding='related'), lambda p: p.update(entryId='bad'),
                       lambda p: p.update(fingerprint='bad'), lambda p: p.update(unknown=False)):
            scopes = deepcopy(self.scopes); mutate(scopes[0]['members'][0]); scope = scopes[0]
            scope['fingerprint'] = digest({'contract': MESSAGE_CONTRACT, 'reference': scope['reference'], 'entries': scope['members']})
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(scopes=scopes)
        scopes = deepcopy(self.scopes); scopes[1]['members'][0]['entryId'] = scopes[0]['members'][0]['entryId']
        scope = scopes[1]; scope['fingerprint'] = digest({'contract': MESSAGE_CONTRACT, 'reference': scope['reference'], 'entries': scope['members']})
        with self.assertRaisesRegex(ValueError, 'shared'): self.observed(scopes=scopes)
        self.assertEqual(self.calls, [])

    def test_retained_proof_missing_sources_changed_hashes_and_mismatched_core_pins_refuse_before_http(self):
        mutations = [lambda r: r['snapshot']['members'].pop(), lambda r: r['snapshot']['pins'].pop(),
                     lambda r: r.update(fingerprint='0' * 64), lambda r: r.update(savedDispositionsSha256='0' * 64),
                     lambda r: r.update(contract='old'), lambda r: r.update(nativeValidationGaps=[]),
                     lambda r: r.update(authenticatedPerson='unverified'), lambda r: r.update(status='changed'),
                     lambda r: r['snapshot']['pins'][0].update(entryRevision=True),
                     lambda r: r['snapshot']['pins'][0].update(entryRevision=99),
                     lambda r: r['snapshot']['pins'][0].update(basisHash='bad'),
                     lambda r: r['snapshot']['members'][0].update(snapshotHash='0' * 64),
                     lambda r: r['snapshot']['members'].reverse(),
                     lambda r: r['snapshot']['members'][0]['snapshot'].update(contract='agentx.history-preservation/v2')]
        for mutate in mutations:
            review = deepcopy(self.review); mutate(review)
            if review['fingerprint'] != '0' * 64: review['fingerprint'] = digest(review['snapshot'])
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(review=review)
        self.assertEqual(self.calls, [])

    def test_retained_v9_counts_and_types_cannot_hide_behind_recomputed_hashes(self):
        mutations = [lambda c: c['content']['reviewPacket']['counts'].update(files=True),
                     lambda c: c['content']['reviewPacket']['counts'].update(pages=0),
                     lambda c: c['content']['reviewPacket']['counts'].update(compoundMembers=129),
                     lambda c: c['content']['raw'].update(bytes=True), lambda c: c['content'].update(partsDecoded=1.0),
                     lambda c: c['restoration'].update(temporaryCopyRemoved=1),
                     lambda c: c['restoration'].update(filesCopied=7.0), lambda c: c.update(status='unavailable')]
        for mutate in mutations:
            self.setUp(); mutate(self.restored_members[0]['snapshot']['copies'][0]); self.rehash_review()
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed()
            self.assertEqual(self.calls, [])

    def test_response_exact_envelope_and_authority_flags_are_required(self):
        wrong = {'authority': 'other', 'contract': 'old', 'status': 'observed_match', 'consistency': 'old',
                 'observationId': str(uuid.uuid4()), 'atomicBatch': 0, 'reviewOnly': 1,
                 'physicalIndependenceAccepted': True, 'semanticAcceptance': True, 'authenticatedPerson': 'caller',
                 'approvalBound': True, 'mailboxEffects': False, 'executionAllowed': True,
                 'cleanupStatus': 'ready', 'nativeValidationGaps': []}
        for key, value in wrong.items():
            self.calls = []
            with self.subTest(key=key), self.assertRaises(ValueError): self.observed(lambda d, _: d.update({key: value}))
        for key in list(self.response(type('Request', (), {'data': b'{"observationId":"nonce"}'})())['data']):
            self.calls = []
            with self.subTest(missing=key), self.assertRaises(ValueError): self.observed(lambda d, _: d.pop(key), rehash=False)
        self.calls = []
        with self.assertRaises(ValueError): self.observed(lambda d, _: d.update(privatePath='synthetic'))

    def test_complete_sources_members_and_core_pin_set_required_even_with_recomputed_fingerprint(self):
        mutations = [lambda s: s['sources'].pop(), lambda s: s['sources'].reverse(),
                     lambda s: s.update(sourceSetSha256='0' * 64), lambda s: s['coreScopes'].pop(),
                     lambda s: s['coreScopes'][0]['members'][0].update(entryRevision=99),
                     lambda s: s['coreScopes'][0]['members'][0].update(entryRevision=False),
                     lambda s: s['members'].pop(), lambda s: s['members'].reverse(),
                     lambda s: s['members'][0]['copies'].pop(), lambda s: s.update(extra=False)]
        for mutate in mutations:
            self.calls = []
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(lambda d, _: mutate(d['snapshot']))

    def test_valid_looking_new_copy_metadata_cannot_replace_verified_v9_copy(self):
        mutations = [lambda c: c.update(machineIdSha256='f' * 64), lambda c: c.update(archiveIdSha256='f' * 64),
                     lambda c: c['content'].update(metadataSha256='f' * 64),
                     lambda c: c['content']['reviewPacket'].update(evidenceHash='f' * 64),
                     lambda c: c['restoration'].update(bytesCopied=1001),
                     lambda c: c.update(copy='mirror')]
        for mutate in mutations:
            self.calls = []
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(lambda d, _: mutate(d['snapshot']['members'][0]['copies'][0]))

    def test_content_and_restore_types_and_members_are_strict(self):
        mutations = [lambda c: c.update(status='available'), lambda c: c.update(content={}),
                     lambda c: c['content']['raw'].update(bytes=50.0), lambda c: c['content'].update(attachmentsDecoded=True),
                     lambda c: c['content']['reviewPacket']['counts'].update(bytes=True),
                     lambda c: c['content']['reviewPacket']['counts'].update(attachments=1),
                     lambda c: c['restoration'].update(temporaryCopyRemoved=1),
                     lambda c: c['restoration'].update(sourceFilesSha256='0' * 64),
                     lambda c: c['restoration'].update(extra='private')]
        for mutate in mutations:
            self.calls = []
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(lambda d, _: mutate(d['snapshot']['members'][0]['copies'][0]))

    def test_storage_schema_bounds_status_and_generic_blockers_are_strict(self):
        mutations = [lambda s: s.update(contract='old'), lambda s: s.update(scope='whole-archive'),
                     lambda s: s.update(status='accepted'), lambda s: s.update(files=True), lambda s: s.update(files=8),
                     lambda s: s.update(filesSha256='0' * 64), lambda s: s.update(physicalIndependenceAccepted=0),
                     lambda s: s.update(physicalDiskIdsSha256=[]), lambda s: s.update(physicalDiskIdsSha256=['bad']),
                     lambda s: s.update(physicalDiskIdsSha256=['1' * 64, '1' * 64]),
                     lambda s: s.update(physicalDiskIdsSha256=['2' * 64, '1' * 64]),
                     lambda s: s.update(physicalDiskIdsSha256=[f'{n:064x}' for n in range(33)]),
                     lambda s: s.update(blockers=['/synthetic/private/path']), lambda s: s.update(blockers=['UPPER']),
                     lambda s: s.update(blockers=['x' * 101]),
                     lambda s: s.update(status='unqualified', physicalDiskIdsSha256=[], blockers=['z_code', 'a_code']), lambda s: s.update(blockers=['code'] * 2),
                     lambda s: s.update(blockers=[f'code_{n}' for n in range(17)]),
                     lambda s: s.update(status='unqualified'),
                     lambda s: s.update(status='unqualified', physicalDiskIdsSha256=[]),
                     lambda s: s.update(hostPath='private')]
        for mutate in mutations:
            self.calls = []
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(lambda d, _: mutate(d['snapshot']['members'][0]['copies'][0]['storage']))

    def test_member_and_aggregate_coverage_are_recomputed_including_boolean_counts(self):
        mutations = [lambda s: s['members'][0]['coverage'].update(state='held'),
                     lambda s: s['members'][0]['coverage'].update(blockers=['same_native_machine']),
                     lambda s: s['members'][0]['coverage'].update(extra=False),
                     lambda s: s['coverage']['counts'].update(messages=True),
                     lambda s: s['coverage']['counts'].update(messages=2.0),
                     lambda s: s['coverage']['counts'].update(distinctKernelDeviceMessages=1),
                     lambda s: s['coverage']['counts'].update(heldMessages=1),
                     lambda s: s['coverage'].update(blockers=['selected_storage_evidence_held'])]
        for mutate in mutations:
            self.calls = []
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(lambda d, _: mutate(d['snapshot']))

    def test_held_blockers_must_have_canonical_order(self):
        for member in self.restored_members:
            member['snapshot']['copies'][1]['machineIdSha256'] = 'c' * 64
        self.rehash_review(); self.topology[0][1] = self.storage('1')
        with self.assertRaises(ValueError): self.observed(lambda d, _: d['snapshot']['members'][0]['coverage']['blockers'].reverse())

    def test_snapshot_drift_wrong_fingerprint_and_wrong_second_status_refuse(self):
        with self.assertRaisesRegex(ValueError, 'fingerprint'): self.observed(lambda d, _: d.update(fingerprint='0' * 64), rehash=False)
        self.calls = []
        def drift(data, count):
            if count == 2: data['snapshot']['members'][0]['copies'][0]['storage']['physicalDiskIdsSha256'] = ['3' * 64]
        with self.assertRaisesRegex(ValueError, 'fingerprint'): self.observed(drift)
        self.calls = []
        with self.assertRaises(ValueError): self.observed(lambda d, n: d.update(status='observed') if n == 2 else None)

    def test_nonce_dates_and_date_regression_refuse_without_retries(self):
        for at in ('yesterday', '2026-01-01', '2026-02-30T12:00:00.000Z', '2026-01-01T12:00:00Z', 0):
            self.calls = []
            with self.subTest(at=at), self.assertRaises(ValueError): self.observed(lambda d, _: d.update(observedAt=at))
            self.assertEqual(len(self.calls), 1)
        self.calls = []
        with self.assertRaisesRegex(ValueError, 'ordered'): self.observed(lambda d, n: d.update(observedAt='2025-01-01T12:00:00.000Z') if n == 2 else None)
        self.calls = []
        with patch('native_history_storage_scope.uuid.uuid4', return_value=uuid.UUID('00000000-0000-4000-8000-000000000001')):
            with self.assertRaisesRegex(ValueError, 'fresh'): self.observed()

    def test_duplicate_keys_nonfinite_malformed_and_size_limit_refuse(self):
        cases = [b'{"ok":true,"ok":false}', b'{"ok":true,"data":{"count":NaN}}', b'{"data":Infinity}',
                 b'bad-json', b'\xff', b'x' * (MAX_RESPONSE + 1)]
        for raw in cases:
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                capture('http://core.invalid', self.saved, self.scopes, self.review,
                        opener=lambda *a, **kw: io.BytesIO(raw))

    def test_transport_error_is_private_and_never_retried(self):
        calls = []
        def offline(*args, **kwargs):
            calls.append(args); raise urllib.error.URLError('Synthetic private host detail')
        with self.assertRaisesRegex(ValueError, 'unavailable') as caught:
            capture('http://core.invalid', self.saved, self.scopes, self.review, opener=offline)
        self.assertNotIn('private host', str(caught.exception)); self.assertEqual(len(calls), 1)

    def test_complete_attachment_metadata_and_bounded_multiple_devices_are_accepted(self):
        for member in self.restored_members:
            for copy in member['snapshot']['copies']:
                copy['content']['attachments'] = [{'partId': '1.2', 'sha256': '7' * 64, 'bytes': 20}]
                copy['content']['partsDecoded'] = 2; copy['content']['attachmentsDecoded'] = 1
                copy['content']['reviewPacket']['counts']['attachments'] = 1
        self.rehash_review()
        self.topology[0][0]['physicalDiskIdsSha256'] = [f'{n:064x}' for n in range(32)]
        self.topology[0][1]['physicalDiskIdsSha256'] = ['f' * 64]
        result = self.observed()
        self.assertEqual(result['snapshot']['coverage']['counts']['distinctKernelDeviceMessages'], 2)

    def test_duplicate_attachment_ids_bad_types_and_unbounded_metadata_are_refused(self):
        mutations = [lambda c: c['content'].update(attachments=[{'partId': 'x', 'sha256': '7' * 64, 'bytes': True}],
                                                                  attachmentsDecoded=1),
                     lambda c: c['content'].update(partsDecoded=4097),
                     lambda c: c['content']['raw'].update(bytes=16 * 1024 * 1024 + 1),
                     lambda c: c['content']['reviewPacket']['counts'].update(bytes=16 * 1024 * 1024 + 1),
                     lambda c: c['content']['reviewPacket']['counts'].update(pages=129),
                     lambda c: c['content']['reviewPacket']['counts'].update(attachments=129),
                     lambda c: c['content']['reviewPacket']['counts'].update(compoundMembers=True)]
        for mutate in mutations:
            self.setUp(); mutate(self.restored_members[0]['snapshot']['copies'][0]); self.rehash_review()
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed()
            self.assertEqual(self.calls, [])
        for member in self.restored_members:
            for copy in member['snapshot']['copies']:
                copy['content']['attachments'] = [{'partId': 'x', 'sha256': '7' * 64, 'bytes': 20}] * 2
                copy['content']['partsDecoded'] = 2; copy['content']['attachmentsDecoded'] = 2
                copy['content']['reviewPacket']['counts']['attachments'] = 2
        self.rehash_review()
        with self.assertRaises(ValueError): self.observed()

    def test_response_capacity_boundary_and_bounded_read_are_exact(self):
        calls = []
        def padded(request, timeout):
            calls.append(request)
            raw = json.dumps(self.response(request)).encode()
            self.assertLess(len(raw), MAX_RESPONSE)
            class Bounded(io.BytesIO):
                def read(inner, size=-1):
                    self.assertEqual(size, MAX_RESPONSE + 1)
                    return super().read(size)
            return Bounded(raw + b' ' * (MAX_RESPONSE - len(raw)))
        result = capture('http://core.invalid', self.saved, self.scopes, self.review, opener=padded)
        self.assertEqual(len(calls), 2); self.assertEqual(result['status'], 'observed_match')

    def test_saved_dispositions_cannot_change_during_observation(self):
        def changed(data, count):
            if count == 2: self.saved[0]['findings'] = {'changed': True}
        with self.assertRaisesRegex(ValueError, 'saved dispositions changed'): self.observed(changed)

    def test_inputs_remain_unchanged(self):
        before = deepcopy((self.saved, self.scopes, self.review)); self.observed()
        self.assertEqual((self.saved, self.scopes, self.review), before)


if __name__ == '__main__': unittest.main()
