"""Selected preservation v15 transport/policy/CLI; synthetic CPU evidence only."""
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
import native_history_decision_acceptance as decision
from native_history_global_decisions import expected_snapshot as decision_snapshot
from native_history_global_downstream import expected_snapshot as downstream_snapshot
from native_history_manifest_confirmation import components
from native_history_preservation_acceptance import (
    capture, CONTRACT, CONSISTENCY, MAX_RESPONSE, PRESERVATION_GAP, expected_snapshot, storage_bindings,
)
from native_history_review_manifest import expected_snapshot as manifest_snapshot
import native_history_storage_scope as storage
from retention_plan import NATIVE_GAPS
from retention_reconcile import reconcile, main
import test_native_history_decision_acceptance as fixtures

REQUEST_ID = fixtures.REQUEST_ID


class PreservationAcceptanceTests(unittest.TestCase):
    def setUp(self):
        fixtures.DecisionAcceptanceTests.setUp(self)
        self.configure(self.saved, self.checks, self.fx.fx.components())

    def configure(self, saved, checks, children, *, normalize=True):
        self.saved, self.checks = saved, checks
        self.fx.saved, self.fx.checks = saved, checks
        self.fx.fx.saved, self.fx.fx.checks = saved, checks
        restored = children[2]['snapshot']
        for member, pin, check in zip(restored['members'], restored['pins'], checks):
            reference = member['source']
            for copy in member['snapshot']['copies'] if normalize else []:
                graph = copy['content']['reviewPacket']
                copy['content'] = {key: reference[key] for key in ('messageId', 'threadId', 'sourceSha256')}
                copy['content'].update(raw={'sha256': reference['sourceSha256'], 'bytes': 50}, attachments=[],
                    metadataSha256='6' * 64, partsDecoded=1, attachmentsDecoded=0, reviewPacket=graph)
            member['snapshotHash'] = pin['snapshotHash'] = check['snapshotHash'] = digest(member['snapshot'])
        children[2]['fingerprint'] = digest(restored)
        self.fx.fx.restoration = restored
        snapshot = manifest_snapshot(saved, checks, self.before, *children)
        self.fx.manifest = {'snapshot': snapshot, 'fingerprint': digest(snapshot)}
        self.fx.core.saved = saved; self.fx.core.downstream = children[1]
        self.fx.restored = self.fx.core.response({'observationId': 'synthetic'}, downstream=children[1])
        self.devices = [[['1' * 64], ['2' * 64]] for _ in saved]

    def topology(self, identifiers):
        return {'contract': storage.STORAGE_CONTRACT, 'scope': storage.STORAGE_SCOPE,
                'status': 'observed_local_devices' if identifiers else 'unqualified',
                'files': 7, 'filesSha256': '5' * 64, 'physicalDiskIdsSha256': identifiers,
                'blockers': [] if identifiers else ['unsupported_storage_topology'], 'physicalIndependenceAccepted': False}

    def response(self, body):
        d_body = {'observationId': body['observationId']}
        if 'expectedDecision' in body:
            d_body.update(expected=body['expectedDecision'], expectedCurrent=body['expectedCurrent'])
        d = fixtures.DecisionAcceptanceTests.response(self, d_body)
        refs, scopes, expected = storage_bindings(self.fx.manifest['snapshot'])
        members = []
        for row, devices in zip(expected, self.devices):
            copies = [{**deepcopy(copy), 'storage': self.topology(ids)} for copy, ids in zip(row['copies'], devices)]
            members.append({'reference': row['reference'], 'copies': copies, 'coverage': storage.coverage(copies)})
        held = sum(bool(row['coverage']['blockers']) for row in members)
        s_snapshot = {'contract': storage.CONTRACT, 'sources': refs, 'sourceSetSha256': digest(refs), 'coreScopes': scopes,
            'members': members, 'coverage': {'counts': {'messages': len(refs), 'distinctKernelDeviceMessages': len(refs) - held,
                'heldMessages': held}, 'blockers': ['selected_storage_evidence_held'] if held else []}}
        s = self.fx.fx.envelope({'observationId': body['observationId'], **({'expected': body['expectedStorage']} if 'expectedStorage' in body else {})},
            s_snapshot, 'two-complete-storage-passes-with-final-core-fence')
        s.update(reviewOnly=True, physicalIndependenceAccepted=False, approvalBound=False, mailboxEffects=0)
        snapshot = expected_snapshot(self.fx.manifest['snapshot'], d, s)
        data = self.fx.fx.envelope(body, snapshot, CONSISTENCY)
        data.update(decisionObservation=d, storageObservation=s, reviewOnly=True, approvalBound=False, mailboxEffects=0,
            preservationAccepted=snapshot['preservationAccepted'], decisionReconciliationAccepted=snapshot['decisionReconciliationAccepted'],
            nativeValidationGaps=snapshot['remainingNativeValidationGaps'])
        return data

    def transport(self, mutate=None, after=None):
        legacy = self.fx.core.transport()
        def open_(request, timeout):
            self.calls.append(request)
            if not request.full_url.endswith('/preservation-acceptance'):
                self.assertEqual(self.parent_calls, 0, 'No HTTP follows v15')
                self.assertFalse(any(request.full_url.endswith(path) for path in ('/current', '/decision-acceptance', '/storage-scope')))
                return legacy(request, timeout)
            self.assertEqual(request.full_url,
                f'http://core.invalid/api/secretary/history/manifest-confirmations/{REQUEST_ID}/preservation-acceptance')
            self.assertEqual(request.get_method(), 'POST'); self.assertEqual(timeout, 1800)
            self.assertEqual(request.get_header('X-service-caller'), 'secretary-retention-review')
            self.parent_calls += 1; body = json.loads(request.data)
            self.assertEqual(set(body), {'checks', 'before', 'observationId'} |
                ({'expected', 'expectedDecision', 'expectedCurrent', 'expectedStorage'} if self.parent_calls == 2 else set()))
            self.assertEqual(body['checks'], self.checks); self.assertEqual(body['before'], self.fx.manifest['snapshot']['before'])
            data = self.response(body)
            if mutate: mutate(data, self.parent_calls)
            if self.parent_calls == 2 and after: after()
            return io.BytesIO(json.dumps({'ok': True, 'data': data}).encode())
        return open_

    def observed(self, mutate=None):
        return capture('http://core.invalid', REQUEST_ID, self.saved, self.checks, self.before,
            self.fx.manifest, self.fx.restored, opener=self.transport(mutate))

    def reconciled(self, **options):
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.fx.fx.graph)):
            return reconcile(self.fx.fx.fx.archive, self.before, self.saved, 'http://core.invalid',
                preservation_acceptance=REQUEST_ID, review_restoration_checks=self.checks, **options)

    def test_two_final_parent_posts_and_independent_children_discharge_exactly_two_gaps(self):
        result = self.observed(); p, d, c, s = (result[key] for key in ('preservation', 'acceptance', 'confirmation', 'storage'))
        self.assertEqual(len(self.calls), 2); self.assertEqual(self.parent_calls, 2)
        self.assertNotEqual(p['observationId'], p['initialObservationId'])
        self.assertEqual({row['observationId'] for row in result.values()}, {p['observationId']})
        self.assertEqual({row['initialObservationId'] for row in result.values()}, {p['initialObservationId']})
        body = json.loads(self.calls[-1].data)
        self.assertEqual([body[key] for key in ('expected', 'expectedDecision', 'expectedCurrent', 'expectedStorage')],
                         [row['fingerprint'] for row in (p, d, c, s)])
        self.assertTrue(p['preservationAccepted']); self.assertTrue(p['decisionReconciliationAccepted'])
        self.assertEqual(p['snapshot']['counts'], {'messages': 1, 'primaryDisks': 1, 'mirrorDisks': 1, 'heldMessages': 0})
        self.assertEqual(p['nativeValidationGaps'], [NATIVE_GAPS[0], NATIVE_GAPS[3]])
        self.assertEqual(s['nativeValidationGaps'], list(NATIVE_GAPS)); self.assertFalse(s['physicalIndependenceAccepted'])
        self.assertEqual(c['nativeValidationGaps'], list(NATIVE_GAPS)); self.assertEqual(len(d['nativeValidationGaps']), 3)
        self.assertNotIn('storageObservation', p['snapshot']); self.assertNotIn('decisionObservation', p['snapshot'])
        self.assertFalse(p['executionAllowed']); self.assertFalse(p['approvalBound']); self.assertEqual(p['cleanupStatus'], 'blocked')

    def test_retained_invoice_blocks_decision_but_preservation_remains_accepted(self):
        children = self.fx.fx.components()
        finding = children[0]['snapshot']['findings'][0]
        finding['snapshot']['inventory']['findings'][0]['section'] = 'invoices'
        record = finding['snapshot']['coverage']['findings'][0]
        record['section'] = 'invoices'; record['records'][0].update(kind='invoice', state='retained')
        finding['fingerprint'] = digest(finding['snapshot'])
        linked = children[1]['snapshot']['members'][0]
        linked['snapshot']['findingScope'] = {key: finding[key] for key in ('fingerprint', 'snapshot')}
        linked['fingerprint'] = digest(linked['snapshot'])
        for child, snapshot in ((children[0], decision_snapshot(self.saved, [finding])),
                                 (children[1], downstream_snapshot(self.saved, [linked]))):
            child.update(snapshot=snapshot, fingerprint=digest(snapshot))
        self.configure(self.saved, self.checks, children)
        result = self.observed()['preservation']
        self.assertTrue(result['preservationAccepted']); self.assertFalse(result['decisionReconciliationAccepted'])
        self.assertEqual(result['nativeValidationGaps'], [gap for gap in NATIVE_GAPS if gap != PRESERVATION_GAP])

    def test_shared_and_unknown_devices_return_held_scope_preserving_decision_acceptance(self):
        for devices, blockers in (([['1' * 64], ['1' * 64]], ['selected_device_identity_overlap', 'selected_storage_evidence_held']),
                                   ([[], ['2' * 64]], ['selected_storage_evidence_held', 'storage_topology_unqualified'])):
            self.parent_calls = 0; self.devices = [devices]
            result = self.observed()['preservation']
            self.assertFalse(result['preservationAccepted']); self.assertTrue(result['decisionReconciliationAccepted'])
            self.assertEqual(result['snapshot']['blockers'], blockers)
            self.assertEqual(result['nativeValidationGaps'], [gap for gap in NATIVE_GAPS if gap != decision.DECISION_GAP])
            self.assertEqual(result['snapshot']['counts']['heldMessages'], 1)

    def multiple(self):
        saved, checks, children = self.fx.fx.multiple()
        self.configure(saved, checks, children)

    def test_cross_message_overlap_is_held_even_when_every_member_is_distinct(self):
        self.multiple(); self.devices = [[['1' * 64], ['2' * 64]], [['3' * 64], ['1' * 64]]]
        result = self.observed()['preservation']
        self.assertFalse(result['preservationAccepted'])
        self.assertEqual(result['snapshot']['blockers'], ['selected_device_identity_overlap'])
        self.assertEqual(result['snapshot']['counts'], {'messages': 2, 'primaryDisks': 2, 'mirrorDisks': 2, 'heldMessages': 0})
        self.assertEqual(result['snapshot']['copies'][1]['physicalDiskIdsSha256'], ['1' * 64, '2' * 64])

    def test_global_device_unions_are_sorted_unique_and_identity_conflicts_are_held(self):
        self.multiple(); result = self.observed()['preservation']['snapshot']
        self.assertEqual(result['counts'], {'messages': 2, 'primaryDisks': 1, 'mirrorDisks': 1, 'heldMessages': 0})
        self.parent_calls = 0
        restored = self.fx.fx.restoration
        restored['members'][1]['snapshot']['copies'][0]['archiveIdSha256'] = 'f' * 64
        children = [deepcopy(self.fx.manifest['snapshot'][key]) for key in ('decisions', 'downstream', 'restoration', 'mailbox')]
        children[2]['snapshot'] = restored
        self.configure(self.saved, self.checks, children)
        result = self.observed()['preservation']
        self.assertFalse(result['preservationAccepted']); self.assertEqual(result['snapshot']['blockers'], ['storage_copy_identity_changed'])
        self.assertEqual(result['snapshot']['copies'][0]['archiveIdSha256'], 'e' * 64)

    def test_same_machine_and_content_mismatch_are_held_with_exact_expected_metadata(self):
        for copy in self.fx.fx.restoration['members'][0]['snapshot']['copies']:
            copy['machineIdSha256'] = 'c' * 64
        self.fx.fx.restoration['members'][0]['snapshot']['copies'][1]['content']['metadataSha256'] = '8' * 64
        self.configure(self.saved, self.checks, self.fx.fx.components(), normalize=False)
        result = self.observed()['preservation']
        self.assertFalse(result['preservationAccepted'])
        self.assertEqual(result['snapshot']['blockers'], ['same_native_machine', 'selected_storage_evidence_held'])

    def test_current_held_physical_scope_can_produce_private_v15_report(self):
        self.devices = [[[], ['2' * 64]]]
        report = self.reconciled(opener=self.transport())
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v15')
        self.assertFalse(report['nativePreservationAcceptance']['preservationAccepted'])
        self.assertEqual(report['nativePreservationAcceptance']['snapshot']['preservationStatus'], 'held_scope')
        self.assertIn(PRESERVATION_GAP, report['nativeValidationGaps'])
        self.assertFalse(report['executionAllowed']); self.assertEqual(report['cleanupStatus'], 'blocked')

    def test_response_and_snapshot_fields_types_and_acceptance_cannot_be_forged(self):
        mutations = {'authority': 'local', 'contract': 'old', 'observationId': 'old', 'observedAt': False,
            'fingerprint': '0' * 64, 'status': 'changed', 'consistency': 'atomic', 'reviewOnly': 1,
            'atomicBatch': 0, 'semanticAcceptance': 0, 'authenticatedPerson': 'owner', 'approvalBound': 0,
            'mailboxEffects': False, 'executionAllowed': 0, 'cleanupStatus': 'accepted',
            'preservationAccepted': 1, 'decisionReconciliationAccepted': 1, 'nativeValidationGaps': [], 'private': 'private'}
        for key, value in mutations.items():
            self.parent_calls = 0
            with self.subTest(key=key), self.assertRaises(ValueError): self.observed(lambda d, _: d.update({key: value}))
        for key in self.response({'observationId': 'synthetic'}):
            self.parent_calls = 0
            with self.subTest(missing=key), self.assertRaises(ValueError): self.observed(lambda d, _: d.pop(key))
        for mutate in (lambda s: s['counts'].update(messages=True), lambda s: s['counts'].update(primaryDisks=1.0),
                       lambda s: s['copies'].reverse(), lambda s: s['copies'][0]['physicalDiskIdsSha256'].clear(),
                       lambda s: s['binding'].update(storageScopeSha256='0' * 64), lambda s: s.update(blockers=['invented']),
                       lambda s: s.update(preservationStatus='held_scope'), lambda s: s.update(remainingNativeValidationGaps=[]),
                       lambda s: s.update(private='private')):
            self.parent_calls = 0
            def change(d, _): mutate(d['snapshot']); d['fingerprint'] = digest(d['snapshot'])
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(change)

    def test_embedded_native_storage_must_match_exact_manifest_and_unchanged_v1_contract(self):
        variants = [lambda s: s.update(observationId='old'), lambda s: s.update(status='changed'),
            lambda s: s.update(nativeValidationGaps=[]), lambda s: s.update(physicalIndependenceAccepted=True),
            lambda s: s['snapshot']['members'].clear(), lambda s: s['snapshot']['sources'].clear(),
            lambda s: s['snapshot']['coreScopes'][0]['members'][0].update(entryRevision=True),
            lambda s: s['snapshot']['members'][0]['copies'][0].update(machineIdSha256='f' * 64),
            lambda s: s['snapshot']['members'][0]['copies'][0]['content'].update(metadataSha256='f' * 64),
            lambda s: s['snapshot']['members'][0]['copies'][0]['restoration'].update(filesCopied=True),
            lambda s: s['snapshot']['coverage']['counts'].update(messages=True)]
        for mutate in variants:
            self.parent_calls = 0
            def change(data, _):
                s = data['storageObservation']; mutate(s); s['fingerprint'] = digest(s['snapshot'])
                data['snapshot']['binding']['storageScopeSha256'] = s['fingerprint']; data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(change)

    def test_stale_human_or_changed_native_child_never_produces_report(self):
        variants = [lambda d: d['decisionObservation'].update(status='changed'),
            lambda d: d['decisionObservation']['currentObservation'].update(status='changed'),
            lambda d: d['decisionObservation']['currentObservation']['snapshot'].update(confirmationStatus='changed'),
            lambda d: d['decisionObservation']['currentObservation']['snapshot']['confirmation'].update(recordedVia='runtime'),
            lambda d: d['decisionObservation'].update(decisionReconciliationAccepted=False),
            lambda d: d.update(observedAt='2026-01-01T11:59:59.999Z')]
        for mutate in variants:
            self.parent_calls = 0
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(lambda d, _: mutate(d))

    def test_all_second_child_expectations_and_fresh_dates_are_required(self):
        for target in ('decisionObservation', 'storageObservation', 'currentObservation'):
            self.parent_calls = 0
            def mutate(data, count):
                if count == 2:
                    child = data['decisionObservation']['currentObservation'] if target == 'currentObservation' else data[target]
                    child['status'] = 'observed'
            with self.subTest(target=target), self.assertRaises(ValueError): self.observed(mutate)
        for target in ('decisionObservation', 'storageObservation'):
            self.parent_calls = 0
            with self.subTest(target=target), self.assertRaises(ValueError):
                self.observed(lambda d, n: d[target].update(observedAt='2026-01-01T12:00:00.001Z'))
        self.parent_calls = 0
        def drift(data, count):
            if count == 2:
                s = data['storageObservation']; s['snapshot']['members'][0]['copies'][0]['storage']['physicalDiskIdsSha256'] = ['3' * 64]
                s['fingerprint'] = digest(s['snapshot']); data['snapshot'] = expected_snapshot(self.fx.manifest['snapshot'], data['decisionObservation'], s)
                data['fingerprint'] = digest(data['snapshot'])
        with self.assertRaises(ValueError): self.observed(drift)
        self.assertEqual(self.parent_calls, 2)

    def test_original_inputs_and_complete_typed_copies_required_before_http(self):
        original = [REQUEST_ID, self.saved, self.checks, self.before, self.fx.manifest, self.fx.restored]
        for index, value in ((0, None), (0, 'bad'), (2, []), (2, self.checks * 2),
                             (3, self.before.replace(tzinfo=None)), (3, self.before + timedelta(microseconds=1)),
                             (4, {'fingerprint': '0' * 64}), (5, {'fingerprint': '0' * 64})):
            args = deepcopy(original); args[index] = value
            with self.subTest(index=index), self.assertRaises(ValueError):
                capture('http://core.invalid', *args, opener=lambda *a, **kw: self.fail('No HTTP'))
        children = self.fx.fx.components()
        children[2]['snapshot']['members'][0]['snapshot']['copies'][0]['content']['partsDecoded'] = True
        self.configure(self.saved, self.checks, children, normalize=False)
        with self.assertRaises(ValueError):
            capture('http://core.invalid', REQUEST_ID, self.saved, self.checks, self.before, self.fx.manifest, self.fx.restored,
                    opener=lambda *a, **kw: self.fail('No HTTP'))

    def test_uuid_flags_must_agree_before_any_http(self):
        other = '00000000-0000-4000-8000-000000000098'
        for options in ({'preservation_acceptance': 'bad'}, {'preservation_acceptance': REQUEST_ID},
                        {'preservation_acceptance': REQUEST_ID, 'decision_acceptance': other},
                        {'preservation_acceptance': REQUEST_ID, 'manifest_confirmation': other},
                        {'preservation_acceptance': REQUEST_ID, 'decision_acceptance': REQUEST_ID, 'manifest_confirmation': other}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                reconcile(self.fx.fx.fx.archive, self.before, self.saved, 'http://core.invalid',
                          opener=lambda *a, **kw: self.fail('No HTTP'), **options)

    def test_v15_reuses_nested_children_and_keeps_final_local_fences(self):
        with patch('native_history_decision_acceptance.capture', side_effect=AssertionError('No standalone v14')), \
                patch('native_history_manifest_confirmation.capture', side_effect=AssertionError('No standalone v13')), \
                patch('native_history_storage_scope.capture', side_effect=AssertionError('No standalone storage')):
            report = self.reconciled(opener=self.transport(), decision_acceptance=REQUEST_ID, manifest_confirmation=REQUEST_ID)
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v15')
        self.assertEqual((self.fx.fx.manifest_calls, self.fx.core.native_calls, self.parent_calls), (2, 2, 2))
        self.assertTrue(all(request.full_url.endswith('/preservation-acceptance') for request in self.calls[-2:]))
        self.assertEqual(report['nativeValidationGaps'], [NATIVE_GAPS[0], NATIVE_GAPS[3]])
        self.assertFalse(report['executionAllowed']); self.assertEqual(report['cleanupStatus'], 'blocked')
        for kind in ('disposition', 'graph'):
            self.setUp()
            def after():
                if kind == 'disposition': self.fx.fx.fx.lane('bulk')
                else: self.fx.fx.graph['filesSha256'] = '9' * 64
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.reconciled(opener=self.transport(after=after))
            self.assertEqual(self.parent_calls, 2)

    def test_pure_validators_have_no_transport(self):
        body = {'observationId': 'synthetic'}; data = self.response(body)
        _, current = components(self.saved, self.checks, self.before, self.fx.manifest, self.fx.restored); current['requestId'] = REQUEST_ID
        bindings = storage_bindings(self.fx.manifest['snapshot'])
        with patch('urllib.request.urlopen', side_effect=AssertionError('No transport')):
            self.assertIs(decision.validate_observation(data['decisionObservation'], current, self.fx.manifest['snapshot'], 'synthetic'), data['decisionObservation'])
            self.assertIs(storage.validate_observation(data['storageObservation'], *bindings, 'synthetic'), data['storageObservation'])

    def test_http_failures_ambiguous_nonfinite_and_capacity_never_retry(self):
        for raw in (b'bad-json', b'{"ok":true,"ok":false}', b'{"data":NaN}', b'x' * (MAX_RESPONSE + 1)):
            with self.subTest(raw=raw[:20]), self.assertRaises(ValueError):
                capture('http://core.invalid', REQUEST_ID, self.saved, self.checks, self.before, self.fx.manifest, self.fx.restored,
                        opener=lambda *a, **kw: io.BytesIO(raw))
        for error in (urllib.error.URLError('Synthetic private detail'), TimeoutError('Synthetic private detail')):
            calls = []
            def lost(*a, **kw): calls.append(a); raise error
            with self.assertRaises(ValueError) as caught:
                capture('http://core.invalid', REQUEST_ID, self.saved, self.checks, self.before, self.fx.manifest, self.fx.restored, opener=lost)
            self.assertEqual(len(calls), 1); self.assertNotIn('private detail', str(caught.exception))
        with patch('native_history_preservation_acceptance.MAX_SNAPSHOT', 100), self.assertRaisesRegex(ValueError, 'snapshot capacity'): self.observed()

    def test_child_failure_or_stale_human_writes_no_private_report(self):
        base = self.fx.fx.fx.root.parent
        saved, checks, output = base / 'failed-saved.json', base / 'failed-checks.json', base / 'failed-report.json'
        save(saved, self.saved); save(checks, self.checks)
        args = ['--root', str(self.fx.fx.fx.root), '--before', self.before.isoformat(), '--dispositions', str(saved),
            '--output', str(output), '--native-review-restoration-checks', str(checks),
            '--core', 'http://core.invalid', '--native-preservation-acceptance', REQUEST_ID]
        for kind in ('unavailable', 'stale'):
            self.parent_calls = 0; self.fx.fx.manifest_calls = self.fx.core.native_calls = 0
            def failure(data, count):
                if kind == 'unavailable': raise urllib.error.URLError('Synthetic private failure')
                data['decisionObservation']['currentObservation']['snapshot']['confirmationStatus'] = 'changed'
            with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.fx.fx.graph)), \
                    patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=self.transport(failure))), \
                    self.subTest(kind=kind), self.assertRaises(ValueError), redirect_stdout(io.StringIO()):
                main(args)
            self.assertFalse(output.exists()); self.assertEqual(self.parent_calls, 1)

    def test_cli_private_immutable_report_counts_only_and_exit_two(self):
        base = self.fx.fx.fx.root.parent
        saved, checks, output = base / 'saved.json', base / 'checks.json', base / 'preserved.json'
        save(saved, self.saved); save(checks, self.checks); original = saved.read_bytes()
        args = ['--root', str(self.fx.fx.fx.root), '--before', self.before.isoformat(), '--dispositions', str(saved),
            '--output', str(output), '--native-review-restoration-checks', str(checks),
            '--core', 'http://core.invalid', '--native-preservation-acceptance', REQUEST_ID]
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.fx.fx.graph)), \
                patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=self.transport())), \
                redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(main(args), 2)
        report, summary = load(output), json.loads(printed.getvalue())
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v15')
        self.assertEqual(output.stat().st_mode & 0o777, 0o600); self.assertEqual(saved.read_bytes(), original)
        self.assertEqual(summary['nativePreservationAcceptance']['preservationStatus'], 'accepted_scope')
        self.assertEqual(len(summary['nativePreservationAcceptance']['remainingNativeValidationGaps']), 2)
        self.assertIn('nativeDecisionAcceptance', summary); self.assertIn('nativeManifestConfirmation', summary)
        for private in ('Sha256', REQUEST_ID, self.saved[0]['messageId']): self.assertNotIn(private, printed.getvalue())
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()): main(args)
        for changed in (args[:-1] + ['bad'], args + ['--native-decision-acceptance', '00000000-0000-4000-8000-000000000098'],
                        args + ['--native-manifest-confirmation', '00000000-0000-4000-8000-000000000098']):
            with patch('retention_reconcile.reconcile', side_effect=AssertionError('No reconciliation')), \
                    self.assertRaises(SystemExit), redirect_stderr(io.StringIO()): main(changed)


if __name__ == '__main__': unittest.main()
