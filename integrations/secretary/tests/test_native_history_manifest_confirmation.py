"""Current human receipt binding and v13 composition; synthetic CPU fixtures."""
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
from datetime import timedelta
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_store import load, save
from native_history_decisions import digest
from native_history_manifest_confirmation import (
    capture, components, validate_observation, CONTRACT, CONFIRMATION_CONTRACT, CONSISTENCY, MAX_RESPONSE,
)
from native_history_review_manifest import expected_snapshot as manifest_snapshot
from retention_plan import NATIVE_GAPS
from retention_reconcile import reconcile, main
import test_native_history_core_restoration as fixtures

REQUEST_ID = '00000000-0000-4000-8000-000000000099'


class ManifestConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.core = fixtures.CoreRestorationClientTests()
        self.core.setUp(); self.addCleanup(self.core.doCleanups)
        self.fx = self.core.fx
        self.saved, self.checks, self.before = self.fx.saved, self.fx.checks, self.fx.fx.before
        manifest = self.fx.snapshot()
        self.manifest = {'snapshot': manifest, 'fingerprint': digest(manifest)}
        self.restored = self.core.response({'observationId': 'synthetic'})
        self.calls, self.current_calls = [], 0

    def response(self, body):
        _, snapshot = components(self.saved, self.checks, self.before, self.manifest, self.restored)
        snapshot['requestId'] = REQUEST_ID
        snapshot['confirmation'] = {'contract': CONFIRMATION_CONTRACT, 'requestId': REQUEST_ID,
            'inputSha256': snapshot['inputSha256'], **snapshot['current'],
            'preparedAt': '2026-01-01T10:00:00.000Z', 'confirmedAt': '2026-01-01T11:00:00.000Z',
            'recordedVia': 'private_lan_surface', 'authenticatedPerson': None}
        data = self.fx.envelope(body, snapshot, CONSISTENCY)
        data.update(reviewOnly=True, mailboxEffects=0, approvalBound=False)
        return data

    def transport(self, mutate=None, after=None):
        legacy = self.core.transport()
        def open_(request, timeout):
            self.calls.append(request)
            if not request.full_url.endswith('/current'):
                self.assertEqual(self.current_calls, 0, 'No HTTP follows current human confirmation')
                return legacy(request, timeout)
            self.assertEqual(request.full_url,
                f'http://core.invalid/api/secretary/history/manifest-confirmations/{REQUEST_ID}/current')
            self.assertEqual(request.get_method(), 'POST'); self.assertEqual(timeout, 1200)
            self.assertEqual(request.get_header('X-service-caller'), 'secretary-retention-review')
            self.current_calls += 1; body = json.loads(request.data)
            self.assertEqual(set(body), {'checks', 'before', 'observationId'} |
                ({'expected'} if self.current_calls == 2 else set()))
            self.assertEqual(body['checks'], self.checks)
            self.assertEqual(body['before'], self.manifest['snapshot']['before'])
            data = self.response(body)
            if mutate: mutate(data, self.current_calls)
            if self.current_calls == 2 and after: after()
            return io.BytesIO(json.dumps({'ok': True, 'data': data}).encode())
        return open_

    def observed(self, mutate=None):
        return capture('http://core.invalid', REQUEST_ID, self.saved, self.checks, self.before,
                       self.manifest, self.restored, opener=self.transport(mutate))

    def reconciled(self, **options):
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.fx.graph)):
            return reconcile(self.fx.fx.archive, self.before, self.saved, 'http://core.invalid',
                manifest_confirmation=REQUEST_ID, review_restoration_checks=self.checks, **options)

    def test_pure_validator_uses_complete_expected_snapshot_and_previous_without_http(self):
        _, expected = components(self.saved, self.checks, self.before, self.manifest, self.restored)
        expected['requestId'] = REQUEST_ID
        first = self.response({'observationId': 'first'})
        second = self.response({'observationId': 'second', 'expected': first['fingerprint']})
        with patch('urllib.request.urlopen', side_effect=AssertionError('Pure validation only')):
            self.assertIs(validate_observation(first, expected, 'first'), first)
            self.assertIs(validate_observation(second, expected, 'second', first), second)
            second['snapshot']['confirmation']['confirmedAt'] = '2026-01-01T10:30:00.000Z'
            second['fingerprint'] = digest(second['snapshot'])
            with self.assertRaises(ValueError): validate_observation(second, expected, 'second', first)

    def test_two_fresh_observations_reuse_original_identity_and_exact_verified_graph(self):
        value = self.observed()
        self.assertEqual(self.current_calls, 2)
        self.assertNotEqual(value['observationId'], value['initialObservationId'])
        self.assertEqual(json.loads(self.calls[-1].data)['expected'], value['fingerprint'])
        snapshot = value['snapshot']
        self.assertEqual(snapshot['requestId'], REQUEST_ID)
        self.assertEqual(snapshot['current']['manifestSha256'], self.manifest['fingerprint'])
        self.assertEqual(snapshot['current']['coreRestorationSha256'], self.restored['fingerprint'])
        self.assertEqual(snapshot['confirmationStatus'], 'current')
        self.assertEqual(value['nativeValidationGaps'], list(NATIVE_GAPS))
        self.assertFalse(value['executionAllowed']); self.assertEqual(value['cleanupStatus'], 'blocked')
        self.assertNotIn('sources', snapshot); self.assertNotIn('bindings', snapshot)
        self.assertEqual(snapshot['selectedMessages'], 1)

    def test_multiple_selected_sources_are_sorted_without_widening_shared_core_records(self):
        self.saved, self.checks, children = self.fx.multiple()
        snapshot = manifest_snapshot(self.saved, self.checks, self.before, *children)
        self.manifest = {'snapshot': snapshot, 'fingerprint': digest(snapshot)}
        self.restored = self.core.response({'observationId': 'synthetic'}, downstream=children[1])
        result = capture('http://core.invalid', REQUEST_ID, list(reversed(self.saved)), list(reversed(self.checks)),
            self.before, self.manifest, self.restored, opener=self.transport())
        self.assertEqual(result['snapshot']['selectedMessages'], 2)
        self.assertEqual(result['snapshot']['checksSha256'], digest(self.checks))
        self.assertEqual(result['snapshot']['sourceSetSha256'], digest([check['source'] for check in self.checks]))

    def test_original_uuid_checks_and_cutoff_refuse_before_http(self):
        original = [REQUEST_ID, self.saved, self.checks, self.before, self.manifest, self.restored]
        variants = [(0, None), (0, True), (0, 'bad'), (0, REQUEST_ID.upper().replace('99', 'AF')),
                    (2, None), (2, []), (2, [*self.checks, *self.checks]),
                    (3, self.before.replace(tzinfo=None)), (3, self.before + timedelta(microseconds=1))]
        for index, value in variants:
            args = deepcopy(original); args[index] = value
            with self.subTest(index=index, value=value), self.assertRaises(ValueError):
                capture('http://core.invalid', *args, opener=lambda *a, **kw: self.fail('No HTTP'))

    def test_complete_v11_and_v12_evidence_is_required_before_http(self):
        for target in ('manifest', 'restored'):
            for kind in ('missing', 'hash-only', 'wrong-contract', 'extra', 'changed-hash', 'changed-scope', 'bool'):
                manifest, restored = deepcopy(self.manifest), deepcopy(self.restored)
                row = manifest if target == 'manifest' else restored
                if kind == 'missing': row.pop('snapshot')
                if kind == 'hash-only': row['snapshot'] = {'contract': row['snapshot']['contract']}
                if kind == 'wrong-contract': row['snapshot']['contract'] = 'local'
                if kind == 'extra': row['snapshot']['privateText'] = 'Synthetic private text'
                if kind == 'changed-hash': row['fingerprint'] = '0' * 64
                if kind == 'changed-scope':
                    if target == 'manifest': row['snapshot']['checksSha256'] = '0' * 64
                    else: row['snapshot']['bindings']['members'].clear()
                if kind == 'bool':
                    if target == 'manifest': row['snapshot']['coverage']['counts']['messages'] = True
                    else: row['snapshot']['restoration']['collections']['history']['documents'] = True
                if kind not in ('missing', 'changed-hash'): row['fingerprint'] = digest(row['snapshot'])
                with self.subTest(target=target, kind=kind), self.assertRaises(ValueError):
                    capture('http://core.invalid', REQUEST_ID, self.saved, self.checks, self.before,
                            manifest, restored, opener=lambda *a, **kw: self.fail('No HTTP'))

    def test_every_envelope_field_is_required_and_unsafe_or_retyped_flags_refuse(self):
        changes = {'authority': 'local', 'contract': 'old', 'observationId': 'old', 'observedAt': False,
            'fingerprint': '0' * 64, 'status': 'changed', 'consistency': 'atomic', 'reviewOnly': 1,
            'atomicBatch': 0, 'semanticAcceptance': 0, 'authenticatedPerson': 'owner', 'approvalBound': 0,
            'mailboxEffects': False, 'executionAllowed': 0, 'cleanupStatus': 'accepted', 'nativeValidationGaps': []}
        for key, value in changes.items():
            self.current_calls = 0
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.observed(lambda data, _: data.update({key: value}))
        for key in self.response({'observationId': 'synthetic'}):
            self.current_calls = 0
            with self.subTest(missing=key), self.assertRaises(ValueError): self.observed(lambda data, _: data.pop(key))
        for extra in ({'namespace': 'private'}, {'mailboxEffects': 0.0}):
            self.current_calls = 0
            with self.assertRaises(ValueError): self.observed(lambda data, _: data.update(extra))

    def test_every_snapshot_confirmation_and_current_field_is_required(self):
        for path in ((), ('confirmation',), ('current',)):
            original = self.response({'observationId': 'synthetic'})['snapshot']
            for part in path: original = original[part]
            for key in original:
                self.current_calls = 0
                def mutate(data, _):
                    current = data['snapshot']
                    for part in path: current = current[part]
                    current.pop(key); data['fingerprint'] = digest(data['snapshot'])
                with self.subTest(path=path, missing=key), self.assertRaises(ValueError): self.observed(mutate)

    def test_matching_hash_cannot_hide_wrong_selection_current_status_or_original_receipt(self):
        snapshot_changes = {'contract': 'old', 'requestId': '00000000-0000-4000-8000-000000000098',
            'before': '2026-02-01T00:00:00.000Z', 'inputSha256': '0' * 64, 'checksSha256': '0' * 64,
            'sourceSetSha256': '0' * 64, 'selectedMessages': True, 'confirmationStatus': 'changed',
            'privateText': 'Synthetic private text'}
        confirmation_changes = {'contract': 'old', 'requestId': '00000000-0000-4000-8000-000000000098',
            'inputSha256': '0' * 64, 'bindingSha256': '0' * 64, 'manifestSha256': '0' * 64,
            'coreRestorationSha256': '0' * 64, 'recordedVia': 'runtime', 'authenticatedPerson': 'owner',
            'privateText': 'Synthetic private text'}
        for group, changes in ((None, snapshot_changes), ('confirmation', confirmation_changes),
                               ('current', {'bindingSha256': '0' * 64, 'manifestSha256': '0' * 64,
                                            'coreRestorationSha256': '0' * 64, 'privateText': 'private'})):
            for key, value in changes.items():
                self.current_calls = 0
                def mutate(data, _):
                    row = data['snapshot'][group] if group else data['snapshot']
                    row[key] = value; data['fingerprint'] = digest(data['snapshot'])
                with self.subTest(group=group, key=key), self.assertRaises(ValueError): self.observed(mutate)
        for count in (1.0, False, 0, 2, '1'):
            self.current_calls = 0
            def mutate(data, _):
                data['snapshot']['selectedMessages'] = count; data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(count=count), self.assertRaises(ValueError): self.observed(mutate)

    def test_human_dates_must_be_canonical_ordered_before_observation_and_stable(self):
        for key in ('preparedAt', 'confirmedAt'):
            for value in (None, False, '2026-01-01', '2026-01-01T11:00:00Z',
                          '2026-01-01T11:00:00.000+00:00', '2026-02-30T11:00:00.000Z',
                          '2026-01-01T11:00:00.0000Z', '2026-01-01T13:00:00.000Z'):
                self.current_calls = 0
                def mutate(data, _):
                    data['snapshot']['confirmation'][key] = value; data['fingerprint'] = digest(data['snapshot'])
                with self.subTest(key=key, value=value), self.assertRaises(ValueError): self.observed(mutate)
        for key in ('preparedAt', 'confirmedAt'):
            self.current_calls = 0
            def mutate(data, call):
                if call == 2:
                    data['snapshot']['confirmation'][key] = '2026-01-01T10:30:00.000Z'
                    data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(changed_date=key), self.assertRaises(ValueError): self.observed(mutate)
            self.assertEqual(self.current_calls, 2)
        self.current_calls = 0
        with self.assertRaises(ValueError):
            self.observed(lambda data, call: data.update(observedAt='2026-01-01T11:59:59.999Z') if call == 2 else None)
        self.current_calls = 0
        def reversed_dates(data, _):
            data['snapshot']['confirmation']['confirmedAt'] = '2026-01-01T09:00:00.000Z'
            data['fingerprint'] = digest(data['snapshot'])
        with self.assertRaises(ValueError): self.observed(reversed_dates)

    def test_unavailable_ambiguous_nonfinite_and_oversize_responses_refuse_without_retry(self):
        for error in (urllib.error.URLError('Synthetic private detail'), TimeoutError('Synthetic private detail'),
                      urllib.error.HTTPError('synthetic', 409, 'Synthetic private detail', {}, None),
                      urllib.error.HTTPError('synthetic', 503, 'Synthetic private detail', {}, None)):
            calls = []
            def lost(*args, **kwargs): calls.append(args); raise error
            with self.assertRaises(ValueError) as caught:
                capture('http://core.invalid', REQUEST_ID, self.saved, self.checks, self.before,
                        self.manifest, self.restored, opener=lost)
            self.assertEqual(len(calls), 1); self.assertNotIn('private detail', str(caught.exception))
        for raw in (b'bad-json', b'{"ok":true,"ok":false}', b'{"data":NaN}', b'x' * (MAX_RESPONSE + 1)):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                capture('http://core.invalid', REQUEST_ID, self.saved, self.checks, self.before,
                        self.manifest, self.restored, opener=lambda *a, **kw: io.BytesIO(raw))
        self.current_calls = 0
        def lost_second(data, call):
            if call == 2: raise TimeoutError('Synthetic private detail')
        with self.assertRaises(ValueError): self.observed(lost_second)
        self.assertEqual(self.current_calls, 2)
        with patch('native_history_manifest_confirmation.MAX_SNAPSHOT', 100), self.assertRaisesRegex(ValueError, 'snapshot capacity'):
            self.observed()

    def test_v13_implies_v11_v12_and_is_last_http_before_local_graph_and_disposition_fences(self):
        from native_history_review_restoration import bind_local
        with patch('native_history_review_restoration.bind_local', wraps=bind_local) as bound:
            report = self.reconciled(opener=self.transport())
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v13')
        self.assertEqual((self.fx.manifest_calls, self.core.native_calls, self.current_calls), (2, 2, 2))
        self.assertTrue(all(request.full_url.endswith('/current') for request in self.calls[-2:]))
        self.assertEqual(bound.call_args.args[-1], report['nativeReviewManifest']['snapshot']['restoration'])
        self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS))
        self.assertFalse(report['executionAllowed']); self.assertEqual(report['cleanupStatus'], 'blocked')

    def test_v13_required_inputs_refuse_before_first_http(self):
        for options in ({'manifest_confirmation': REQUEST_ID},
                        {'manifest_confirmation': 'bad', 'review_restoration_checks': self.checks},
                        {'manifest_confirmation': REQUEST_ID, 'review_restoration_checks': []}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                reconcile(self.fx.fx.archive, self.before, self.saved, 'http://core.invalid',
                    opener=lambda *a, **kw: self.fail('No HTTP'), **options)

    def test_local_archive_and_graph_mutations_after_last_http_refuse(self):
        for kind in ('disposition', 'graph'):
            self.setUp()
            def after():
                if kind == 'disposition': self.fx.fx.lane('bulk')
                else: self.fx.graph['filesSha256'] = '9' * 64
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.reconciled(opener=self.transport(after=after))
            self.assertEqual(self.current_calls, 2)

    def test_cli_retains_private_immutable_report_counts_only_and_exit_two(self):
        base = self.fx.fx.root.parent; saved, checks, output = base / 'saved.json', base / 'checks.json', base / 'current.json'
        save(saved, self.saved); save(checks, self.checks); before = saved.read_bytes()
        args = ['--root', str(self.fx.fx.root), '--before', self.before.isoformat(), '--dispositions', str(saved),
            '--output', str(output), '--native-review-restoration-checks', str(checks),
            '--core', 'http://core.invalid', '--native-manifest-confirmation', REQUEST_ID]
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.fx.graph)), \
                patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=self.transport())), \
                redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(main(args), 2)
        report, summary = load(output), json.loads(printed.getvalue())
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v13')
        self.assertEqual(output.stat().st_mode & 0o777, 0o600); self.assertEqual(saved.read_bytes(), before)
        self.assertEqual(summary['nativeManifestConfirmation'], {'selectedMessages': 1, 'confirmationStatus': 'current'})
        for private in ('Sha256', REQUEST_ID, self.saved[0]['messageId']): self.assertNotIn(private, printed.getvalue())
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()): main(args)
        for changed in (args[:-1] + ['bad'], args[:8] + ['--native-manifest-confirmation', REQUEST_ID]):
            with patch('retention_reconcile.reconcile', side_effect=AssertionError('No reconciliation')), \
                    self.assertRaises(SystemExit), redirect_stderr(io.StringIO()): main(changed)


if __name__ == '__main__': unittest.main()
