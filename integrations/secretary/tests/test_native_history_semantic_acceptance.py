"""Explicit human semantic v16: strict synthetic transport/CLI, no model calls."""
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
from native_history_manifest_confirmation import components
import native_history_semantic_acceptance as semantic
from retention_plan import NATIVE_GAPS
from retention_reconcile import main, reconcile
import test_native_history_preservation_acceptance as fixtures

MANIFEST_ID = fixtures.REQUEST_ID
SEMANTIC_ID = '00000000-0000-4000-8000-000000000079'


class SemanticAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.p = fixtures.PreservationAcceptanceTests(); self.p.setUp(); self.addCleanup(self.p.doCleanups)
        self.saved, self.checks, self.before = self.p.saved, self.p.checks, self.p.before
        self.calls, self.parent_calls = [], 0
        self.state, self.complete = 'accepted', True

    def response(self, body):
        child = self.p.response({'observationId': body['observationId']})
        current = child['decisionObservation']['currentObservation']['snapshot']
        binding = {'contract': semantic.REVIEW_CONTRACT, 'purpose': semantic.PURPOSE,
            'inputSha256': digest({'manifestRequestId': MANIFEST_ID, 'checks': self.checks, 'before': current['before']}),
            'current': current['current'], 'originalConfirmation': current['confirmation'],
            'sources': [{'resources': [
                {'kind': 'original', 'key': 'original', 'sha256': check['source']['sourceSha256'], 'bytes': 50},
                {'kind': 'analysis', 'key': 'selected-analysis', 'sha256': 'a' * 64, 'bytes': 30}]} for check in self.checks]}
        count = 2 * len(self.checks); size = 80 * len(self.checks)
        receipt = {'contract': semantic.REVIEW_CONTRACT, 'requestId': SEMANTIC_ID, 'state': self.state,
            'inputSha256': binding['inputSha256'], 'bindingSha256': digest(binding),
            'preparedAt': current['confirmation']['confirmedAt'],
            'decidedAt': current['confirmation']['confirmedAt'] if self.state in ('accepted', 'held') else None,
            'decision': 'accepted_selected_semantics' if self.state in ('accepted', 'deciding') else 'held_ambiguous' if self.state == 'held' else None,
            'blockedCode': 'evidence_unavailable' if self.state == 'blocked' else None,
            'coverage': {'resources': count, 'totalBytes': size, 'servedResources': count if self.complete else 0,
                'servedBytes': size if self.complete else 0, 'complete': self.complete},
            'recordedVia': 'private_lan_surface', 'authenticatedPerson': None, 'semanticAcceptance': False,
            'approvalBound': False, 'executionAllowed': False, 'cleanupStatus': 'blocked', 'mailboxEffects': 0,
            'replayed': True, 'nativeState': 'not_rechecked'}
        snapshot = semantic.expected_snapshot(MANIFEST_ID, SEMANTIC_ID, self.checks, self.p.fx.manifest['snapshot'],
            child, receipt, binding, semantic.date(child['observedAt']))
        data = self.p.fx.fx.envelope(body, snapshot, semantic.CONSISTENCY)
        data.update(preservationObservation=child, reviewOnly=True, approvalBound=False, mailboxEffects=0,
            **{key: snapshot[key] for key in ('semanticAcceptance', 'preservationAccepted', 'decisionReconciliationAccepted')},
            nativeValidationGaps=snapshot['remainingNativeValidationGaps'])
        return data

    def transport(self, mutate=None, after=None):
        legacy = self.p.fx.core.transport()
        def open_(request, timeout):
            self.calls.append(request)
            if not request.full_url.endswith('/semantic-acceptance'):
                self.assertEqual(self.parent_calls, 0, 'No HTTP after final semantic observations')
                self.assertFalse(any(request.full_url.endswith(path) for path in ('/preservation-acceptance', '/decision-acceptance', '/current', '/storage-scope')))
                return legacy(request, timeout)
            self.assertEqual(request.full_url, f'http://core.invalid/api/secretary/history/manifest-confirmations/{MANIFEST_ID}/semantic-acceptance')
            self.assertEqual(request.get_method(), 'POST'); self.assertEqual(timeout, 1800)
            self.assertEqual(request.get_header('X-service-caller'), 'secretary-retention-review')
            self.parent_calls += 1; body = json.loads(request.data)
            self.assertEqual(set(body), {'semanticRequestId', 'checks', 'before', 'observationId'} | ({'expected'} if self.parent_calls == 2 else set()))
            self.assertEqual(body['semanticRequestId'], SEMANTIC_ID); self.assertEqual(body['checks'], self.checks)
            self.assertEqual(body['before'], self.p.fx.manifest['snapshot']['before'])
            data = self.response(body)
            if mutate: mutate(data, self.parent_calls)
            if self.parent_calls == 2 and after: after()
            return io.BytesIO(json.dumps({'ok': True, 'data': data}).encode())
        return open_

    def observed(self, mutate=None):
        return semantic.capture('http://core.invalid', MANIFEST_ID, SEMANTIC_ID, self.saved, self.checks,
            self.before, self.p.fx.manifest, self.p.fx.restored, opener=self.transport(mutate))

    def reconciled(self, **kwargs):
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.p.fx.fx.graph)):
            return reconcile(self.p.fx.fx.fx.archive, self.before, self.saved, 'http://core.invalid',
                semantic_acceptance=SEMANTIC_ID, manifest_confirmation=MANIFEST_ID,
                review_restoration_checks=self.checks, **kwargs)

    @staticmethod
    def reseal(data):
        snapshot = data['snapshot']; binding, receipt = snapshot['reviewBinding'], snapshot['receipt']
        receipt['bindingSha256'] = digest(binding); snapshot['bindingSha256'] = receipt['bindingSha256']
        data['fingerprint'] = digest(snapshot)

    def test_two_parent_posts_accept_three_contracts_and_keep_mailbox_approval_blocked(self):
        value = self.observed(); observed = value['semantic']
        self.assertEqual(len(self.calls), 2); self.assertEqual(self.parent_calls, 2)
        self.assertNotEqual(observed['observationId'], observed['initialObservationId'])
        self.assertEqual({v['observationId'] for v in value.values()}, {observed['observationId']})
        self.assertEqual(json.loads(self.calls[-1].data)['expected'], observed['fingerprint'])
        self.assertTrue(observed['semanticAcceptance']); self.assertTrue(observed['preservationAccepted'])
        self.assertTrue(observed['decisionReconciliationAccepted'])
        self.assertEqual(observed['nativeValidationGaps'], [NATIVE_GAPS[3]])
        self.assertFalse(observed['snapshot']['receipt']['semanticAcceptance'])
        self.assertFalse(observed['approvalBound']); self.assertFalse(observed['executionAllowed'])
        self.assertEqual(observed['mailboxEffects'], 0); self.assertEqual(observed['cleanupStatus'], 'blocked')
        self.assertEqual(value['preservation']['nativeValidationGaps'], [NATIVE_GAPS[0], NATIVE_GAPS[3]])

    def test_complete_delivery_without_explicit_human_acceptance_never_discharges_semantics(self):
        for state in ('prepared', 'deciding', 'held', 'blocked'):
            self.parent_calls = 0; self.state = state
            value = self.observed()['semantic']
            self.assertFalse(value['semanticAcceptance']); self.assertIn(semantic.SEMANTIC_GAP, value['nativeValidationGaps'])
            self.assertIn('explicit_human_semantic_decision_missing', value['snapshot']['blockers'])
        self.parent_calls = 0; self.state = 'prepared'; self.complete = False
        value = self.observed()['semantic']
        self.assertIn('semantic_sources_not_fully_served', value['snapshot']['blockers'])

    def test_human_semantics_does_not_accept_ambiguous_physical_preservation(self):
        self.p.devices = [[[], ['2' * 64]]]
        value = self.observed()['semantic']
        self.assertTrue(value['semanticAcceptance']); self.assertFalse(value['preservationAccepted'])
        self.assertTrue(value['decisionReconciliationAccepted'])
        self.assertEqual(value['nativeValidationGaps'], [NATIVE_GAPS[2], NATIVE_GAPS[3]])
        self.assertFalse(value['approvalBound']); self.assertFalse(value['executionAllowed'])

    def test_all_selected_messages_and_resource_counts_are_bound_together(self):
        self.p.multiple(); self.saved, self.checks = self.p.saved, self.p.checks
        value = self.observed()['semantic']
        self.assertEqual(len(value['snapshot']['reviewBinding']['sources']), 2)
        self.assertEqual(value['snapshot']['receipt']['coverage'],
            {'resources': 4, 'totalBytes': 160, 'servedResources': 4, 'servedBytes': 160, 'complete': True})
        self.assertTrue(value['semanticAcceptance']); self.assertEqual(value['nativeValidationGaps'], [NATIVE_GAPS[3]])

    def test_parent_envelope_and_outcomes_are_strict(self):
        changes = {'authority': 'runtime', 'contract': 'old', 'observationId': 'old', 'observedAt': False,
            'fingerprint': 'f' * 64, 'status': 'changed', 'consistency': 'atomic', 'reviewOnly': 1, 'atomicBatch': 0,
            'authenticatedPerson': 'owner', 'semanticAcceptance': 1, 'preservationAccepted': 1,
            'decisionReconciliationAccepted': 1, 'approvalBound': 0, 'executionAllowed': 0,
            'cleanupStatus': 'accepted', 'mailboxEffects': False, 'nativeValidationGaps': [], 'extra': 'private'}
        for key, value in changes.items():
            self.parent_calls = 0
            with self.subTest(key=key), self.assertRaises(ValueError): self.observed(lambda d, n: d.update({key: value}))
        for key in self.response({'observationId': 'synthetic'}):
            self.parent_calls = 0
            with self.subTest(missing=key), self.assertRaises(ValueError): self.observed(lambda d, n: d.pop(key))

    def test_historical_receipt_identity_scope_dates_and_human_boundary_cannot_be_forged(self):
        changes = {'contract': 'inspection', 'requestId': MANIFEST_ID, 'inputSha256': 'f' * 64,
            'bindingSha256': 'f' * 64, 'preparedAt': '2026-01-01T11:59:59.000Z', 'decidedAt': None,
            'decision': 'reviewed_selected_manifest', 'blockedCode': 'evidence_changed', 'recordedVia': 'runtime',
            'authenticatedPerson': 'owner', 'semanticAcceptance': True, 'approvalBound': True,
            'executionAllowed': True, 'cleanupStatus': 'approved', 'mailboxEffects': False,
            'replayed': False, 'nativeState': 'observed', 'preview': {'private': 'data'}}
        for key, value in changes.items():
            self.parent_calls = 0
            def change(data, count):
                data['snapshot']['receipt'][key] = value; data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(key=key), self.assertRaises(ValueError): self.observed(change)

    def test_opaque_semantic_hash_must_recompose_exact_native_source_and_analysis_binding(self):
        mutations = [lambda b: b.update(contract='old'), lambda b: b.update(purpose='reviewed_selected_manifest'),
            lambda b: b.update(inputSha256='f' * 64), lambda b: b['current'].update(manifestSha256='f' * 64),
            lambda b: b['originalConfirmation'].update(requestId=SEMANTIC_ID), lambda b: b['sources'].clear(),
            lambda b: b['sources'][0]['resources'].clear(),
            lambda b: b['sources'][0]['resources'][0].update(sha256='f' * 64),
            lambda b: b['sources'][0]['resources'][0].update(bytes=True),
            lambda b: b['sources'][0]['resources'][0].update(key='../../private'),
            lambda b: b['sources'][0]['resources'].append(deepcopy(b['sources'][0]['resources'][0])),
            lambda b: b['sources'][0]['resources'][1].update(kind='attachment'),
            lambda b: b['sources'][0]['resources'][1].update(bytes=16777216),
            lambda b: b['sources'][0].update(reference={'private': 'extra'})]
        for mutate in mutations:
            self.parent_calls = 0
            def change(data, count): mutate(data['snapshot']['reviewBinding']); self.reseal(data)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(change)

    def test_reading_counts_types_and_complete_accepted_receipt_are_required(self):
        changes = {'resources': True, 'totalBytes': 1.0, 'servedResources': -1, 'servedBytes': 81, 'complete': 1}
        for key, value in changes.items():
            self.parent_calls = 0
            def change(data, count):
                data['snapshot']['receipt']['coverage'][key] = value; data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(key=key), self.assertRaises(ValueError): self.observed(change)
        self.parent_calls = 0
        def incomplete(data, count):
            data['snapshot']['receipt']['coverage'].update(servedResources=0, servedBytes=0, complete=False)
            data['fingerprint'] = digest(data['snapshot'])
        with self.assertRaises(ValueError): self.observed(incomplete)

    def test_second_pass_retains_human_identity_analysis_and_child_hashes(self):
        for mutate in (lambda d: d['snapshot']['reviewBinding']['sources'][0]['resources'][1].update(sha256='f' * 64),
                       lambda d: d['snapshot']['receipt'].update(preparedAt='2026-01-01T12:00:00.000Z'),
                       lambda d: d['preservationObservation'].update(status='observed_match'),
                       lambda d: d.update(observedAt='2026-01-01T11:59:59.000Z')):
            self.parent_calls = 0
            def change(data, count):
                if count == 2: mutate(data); self.reseal(data)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(change)
            self.assertEqual(self.parent_calls, 2)

    def test_prerequisites_require_both_original_ids_and_complete_verified_graph_before_http(self):
        original = [MANIFEST_ID, SEMANTIC_ID, self.saved, self.checks, self.before, self.p.fx.manifest, self.p.fx.restored]
        for index, value in ((0, None), (1, 'bad'), (3, []), (3, self.checks * 2),
                (4, self.before.replace(tzinfo=None)), (4, self.before + timedelta(microseconds=1)),
                (5, {'fingerprint': 'f' * 64}), (6, {'fingerprint': 'f' * 64})):
            args = deepcopy(original); args[index] = value
            with self.subTest(index=index), self.assertRaises(ValueError):
                semantic.capture('http://core.invalid', *args, opener=lambda *a, **kw: self.fail('No HTTP'))
        for options in ({'semantic_acceptance': 'bad'}, {'semantic_acceptance': SEMANTIC_ID},
                {'semantic_acceptance': SEMANTIC_ID, 'manifest_confirmation': MANIFEST_ID, 'preservation_acceptance': SEMANTIC_ID},
                {'semantic_acceptance': SEMANTIC_ID, 'manifest_confirmation': MANIFEST_ID, 'decision_acceptance': SEMANTIC_ID}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                reconcile(self.p.fx.fx.fx.archive, self.before, self.saved, 'http://core.invalid',
                    opener=lambda *a, **kw: self.fail('No HTTP'), **options)

    def test_v16_reuses_nested_children_and_keeps_last_native_and_local_fences(self):
        with patch('native_history_preservation_acceptance.capture', side_effect=AssertionError('No standalone v15')), \
                patch('native_history_decision_acceptance.capture', side_effect=AssertionError('No standalone v14')), \
                patch('native_history_manifest_confirmation.capture', side_effect=AssertionError('No standalone v13')):
            report = self.reconciled(opener=self.transport(), preservation_acceptance=MANIFEST_ID, decision_acceptance=MANIFEST_ID)
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v16')
        self.assertEqual(report['nativeValidationGaps'], [NATIVE_GAPS[3]])
        self.assertEqual((self.p.fx.fx.manifest_calls, self.p.fx.core.native_calls, self.parent_calls), (2, 2, 2))
        self.assertTrue(all(request.full_url.endswith('/semantic-acceptance') for request in self.calls[-2:]))
        self.assertFalse(report['executionAllowed']); self.assertEqual(report['cleanupStatus'], 'blocked')
        self.parent_calls = 0; self.p.fx.fx.manifest_calls = self.p.fx.core.native_calls = 0
        with self.assertRaisesRegex(ValueError, 'Archive changed during native human semantic acceptance'):
            self.reconciled(opener=self.transport(after=lambda: self.p.fx.fx.fx.lane('bulk')))

    def test_invalid_transport_bounds_and_unknown_response_never_retry(self):
        for raw in (b'bad-json', b'{"ok":true,"ok":false}', b'{"data":NaN}', b'x' * (semantic.MAX_RESPONSE + 1)):
            with self.subTest(raw=raw[:20]), self.assertRaises(ValueError):
                semantic.capture('http://core.invalid', MANIFEST_ID, SEMANTIC_ID, self.saved, self.checks,
                    self.before, self.p.fx.manifest, self.p.fx.restored, opener=lambda *a, **kw: io.BytesIO(raw))
        for error in (urllib.error.URLError('Synthetic private detail'), TimeoutError('Synthetic private detail')):
            calls = []
            def lost(*a, **kw): calls.append(a); raise error
            with self.assertRaises(ValueError) as caught:
                semantic.capture('http://core.invalid', MANIFEST_ID, SEMANTIC_ID, self.saved, self.checks,
                    self.before, self.p.fx.manifest, self.p.fx.restored, opener=lost)
            self.assertEqual(len(calls), 1); self.assertNotIn('private detail', str(caught.exception))
        with patch('native_history_semantic_acceptance.MAX_SNAPSHOT', 10), self.assertRaises(ValueError): self.observed()

    def cli_args(self, suffix):
        base = self.p.fx.fx.fx.root.parent
        saved, checks, output = base / ('saved-' + suffix + '.json'), base / ('checks-' + suffix + '.json'), base / ('report-' + suffix + '.json')
        save(saved, self.saved); save(checks, self.checks)
        return ['--root', str(self.p.fx.fx.fx.root), '--before', self.before.isoformat(), '--dispositions', str(saved),
            '--output', str(output), '--native-review-restoration-checks', str(checks), '--core', 'http://core.invalid',
            '--native-manifest-confirmation', MANIFEST_ID, '--native-semantic-acceptance', SEMANTIC_ID], saved, output

    def test_cli_retains_private_immutable_report_and_exit_two_without_identifiers_on_stdout(self):
        args, saved, output = self.cli_args('valid'); original = saved.read_bytes()
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.p.fx.fx.graph)), \
                patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=self.transport())), \
                redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(main(args), 2)
        report, summary = load(output), json.loads(printed.getvalue())
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v16')
        self.assertEqual(output.stat().st_mode & 0o777, 0o600); self.assertEqual(saved.read_bytes(), original)
        self.assertTrue(summary['nativeSemanticAcceptance']['semanticAcceptance'])
        self.assertEqual(summary['nativeSemanticAcceptance']['remainingNativeValidationGaps'], [NATIVE_GAPS[3]])
        for private in ('Sha256', MANIFEST_ID, SEMANTIC_ID, self.saved[0]['messageId']): self.assertNotIn(private, printed.getvalue())
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()): main(args)

    def test_cli_bad_ids_compatibility_and_missing_manifest_refuse_before_reconciliation(self):
        args, _, _ = self.cli_args('bad')
        variants = [args[:-1] + ['bad'], args[:-4] + args[-2:],
            args + ['--native-preservation-acceptance', SEMANTIC_ID], args + ['--native-decision-acceptance', SEMANTIC_ID]]
        for variant in variants:
            with self.subTest(variant=variant[-4:]), patch('retention_reconcile.reconcile', side_effect=AssertionError('No reconciliation')), \
                    self.assertRaises(SystemExit), redirect_stderr(io.StringIO()): main(variant)

    def test_unknown_ack_or_stale_evidence_never_writes_report(self):
        args, _, output = self.cli_args('unavailable')
        def failed(data, count): raise urllib.error.URLError('Synthetic private native failure')
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.p.fx.fx.graph)), \
                patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=self.transport(failed))), \
                self.assertRaises(ValueError), redirect_stdout(io.StringIO()):
            main(args)
        self.assertFalse(output.exists()); self.assertEqual(self.parent_calls, 1)


if __name__ == '__main__': unittest.main()
