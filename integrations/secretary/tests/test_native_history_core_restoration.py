"""Core restoration transport and v12 composition; synthetic CPU fixtures only."""
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
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
from native_history_core_restoration import capture, expected_bindings, CONTRACT, ENGINE_CONTRACT, MAX_RESPONSE
from native_history_global_downstream import expected_snapshot
from retention_plan import NATIVE_GAPS
from retention_reconcile import reconcile, main
import test_native_history_review_manifest as fixtures


class CoreRestorationClientTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.ReviewManifestTests(); self.fx.setUp(); self.addCleanup(self.fx.doCleanups)
        self.saved, self.downstream = self.fx.saved, self.fx.components()[1]
        self.calls, self.native_calls = [], 0

    def bindings(self, downstream=None):
        snapshot = (downstream or self.downstream)['snapshot']
        return {'sources': snapshot['sources'], 'sourceSetSha256': snapshot['sourceSetSha256'], 'members': [
            {'reference': member['reference'], 'coreScope': member['snapshot']['findingScope']['snapshot']['coreScope'],
             'entries': member['snapshot']['entries']} for member in snapshot['members']]}

    def response(self, body, downstream=None):
        bindings = self.bindings(downstream)
        entries = {row['entryId'] for member in bindings['members'] for row in member['entries']}
        notes = {row['note']['id'] for member in bindings['members'] for row in member['entries'] if row['note'] is not None}
        restoration = {'contract': ENGINE_CONTRACT, 'verificationSha256': digest(bindings), 'temporaryCopyRemoved': True,
            'collections': {name: {'documents': count, 'bytes': count * 1000, 'indexes': 2,
                'sourceDocumentsSha256': 'a' * 64, 'restoredDocumentsSha256': 'a' * 64,
                'sourceIndexesSha256': 'b' * 64, 'restoredIndexesSha256': 'b' * 64}
                for name, count in (('history', len(entries)), ('souvenirs', len(notes)))}}
        snapshot = {'contract': CONTRACT, 'bindings': bindings, 'bindingsSha256': digest(bindings), 'restoration': restoration}
        value = self.fx.envelope(body, snapshot, 'native-typed-core-restore-with-final-source-fence')
        value.update(scope='selected-current-history-and-linked-active-souvenirs', indexState='mongo-index-definitions-only',
                     reviewOnly=True, canonicalEffects=0)
        return value

    def transport(self, mutate=None, after=None, downstream=None):
        legacy = self.fx.transport()
        def open_(request, timeout):
            self.calls.append(request)
            if not request.full_url.endswith('/core-restoration'):
                self.assertEqual(self.native_calls, 0, 'Core restoration owns the final HTTP observations')
                return legacy(request, timeout)
            self.assertEqual(request.get_method(), 'POST'); self.assertEqual(timeout, 240)
            self.assertEqual(request.get_header('X-service-caller'), 'secretary-retention-review')
            self.native_calls += 1; body = json.loads(request.data)
            self.assertEqual(set(body), {'sources', 'observationId', 'expectedBindingsSha256'} |
                ({'expected'} if self.native_calls == 2 else set()))
            self.assertEqual(body['sources'], self.bindings(downstream)['sources'])
            self.assertEqual(body['expectedBindingsSha256'], digest(self.bindings(downstream)))
            data = self.response(body, downstream)
            if mutate: mutate(data, self.native_calls)
            if self.native_calls == 2 and after: after()
            return io.BytesIO(json.dumps({'ok': True, 'data': data}).encode())
        return open_

    def observed(self, mutate=None):
        return capture('http://core.invalid', self.saved, self.downstream, opener=self.transport(mutate))

    def reconciled(self, **options):
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.fx.graph)):
            return reconcile(self.fx.fx.archive, self.fx.fx.before, self.saved, 'http://core.invalid',
                             core_restoration=True, **options)

    def test_two_fresh_exact_observations_bind_verified_v10_without_sending_documents_or_proof(self):
        value = self.observed()
        self.assertEqual(self.native_calls, 2); self.assertNotEqual(value['observationId'], value['initialObservationId'])
        self.assertEqual(json.loads(self.calls[-1].data)['expected'], value['fingerprint'])
        self.assertEqual(value['snapshot']['bindings'], self.bindings())
        self.assertEqual(value['nativeValidationGaps'], list(NATIVE_GAPS)); self.assertFalse(value['executionAllowed'])
        self.assertTrue(value['snapshot']['restoration']['temporaryCopyRemoved'])
        self.assertEqual(value['snapshot']['restoration']['collections']['souvenirs']['documents'], 1)

    def test_shared_entries_and_notes_are_counted_once_across_sorted_source_selection(self):
        saved, _, components = self.fx.multiple()
        downstream = components[1]
        value = capture('http://core.invalid', list(reversed(saved)), downstream, opener=self.transport(downstream=downstream))
        self.assertEqual(len(value['snapshot']['bindings']['members']), 2)
        self.assertEqual(value['snapshot']['restoration']['collections']['history']['documents'], 1)
        self.assertEqual(value['snapshot']['restoration']['collections']['souvenirs']['documents'], 1)

    def test_empty_linked_notes_require_zero_documents_and_bytes(self):
        member = deepcopy(self.downstream['snapshot']['members'][0])
        row = member['snapshot']['entries'][0]; row['state'] = 'not_linked'; row['note'] = None
        member['snapshot']['coverage']['counts'].update(currentLinks=0, notLinked=1)
        member['fingerprint'] = digest(member['snapshot'])
        snapshot = expected_snapshot(self.saved, [member]); self.downstream = {'snapshot': snapshot, 'fingerprint': digest(snapshot)}
        value = self.observed(); group = value['snapshot']['restoration']['collections']['souvenirs']
        self.assertEqual((group['documents'], group['bytes']), (0, 0))

    def test_missing_extra_duplicate_changed_or_retyped_v10_selection_refuses_before_http(self):
        for kind in ('absent', 'extra', 'duplicate', 'changed', 'float', 'bool', 'contract'):
            downstream = deepcopy(self.downstream)
            if kind == 'absent': downstream['snapshot']['members'].clear()
            if kind == 'extra': downstream['snapshot']['privateText'] = 'Synthetic private text'
            if kind == 'duplicate': downstream['snapshot']['members'] *= 2
            if kind == 'changed': downstream['snapshot']['sourceSetSha256'] = '0' * 64
            if kind == 'float': downstream['snapshot']['coverage']['counts']['entries'] = 1.0
            if kind == 'bool': downstream['snapshot']['coverage']['counts']['entries'] = True
            if kind == 'contract': downstream['snapshot']['contract'] = 'local'
            downstream['fingerprint'] = digest(downstream['snapshot'])
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                capture('http://core.invalid', self.saved, downstream, opener=lambda *a, **kw: self.fail('No HTTP'))

    def test_strict_complete_envelope_rejects_missing_extra_unsafe_or_retyped_fields(self):
        changes = {'authority': 'local', 'contract': 'old', 'observationId': 'old', 'observedAt': '2026-13-01T00:00:00.000Z',
            'fingerprint': '0' * 64, 'status': 'changed', 'consistency': 'atomic', 'scope': 'whole-core',
            'indexState': 'recall-qualified', 'reviewOnly': 1, 'atomicBatch': 0, 'semanticAcceptance': 0,
            'authenticatedPerson': 'owner', 'canonicalEffects': False, 'executionAllowed': 0,
            'cleanupStatus': 'accepted', 'nativeValidationGaps': []}
        for key, value in changes.items():
            self.native_calls = 0
            with self.subTest(key=key), self.assertRaises(ValueError): self.observed(lambda d, _: d.update({key: value}))
        for key in self.response({'observationId': 'synthetic'}):
            self.native_calls = 0
            with self.subTest(missing=key), self.assertRaises(ValueError): self.observed(lambda d, _: d.pop(key))
        for extra in ({'namespace': 'private'}, {'canonicalEffects': 0.0}):
            self.native_calls = 0
            with self.assertRaises(ValueError): self.observed(lambda d, _: d.update(extra))

    def test_matching_fingerprints_cannot_hide_invalid_native_engine_proof(self):
        mutations = [lambda s: s.update(privateText='Synthetic private document'), lambda s: s.pop('restoration'),
            lambda s: s.update(bindingsSha256='0' * 64), lambda s: s['bindings']['members'].clear(),
            lambda s: s['bindings']['members'][0]['coreScope']['members'][0].update(entryRevision=False),
            lambda s: s['bindings']['members'][0]['entries'][0]['note'].update(revision=True),
            lambda s: s['restoration'].update(contract='old'), lambda s: s['restoration'].update(temporaryCopyRemoved=1),
            lambda s: s['restoration'].update(temporaryCopyRemoved=False),
            lambda s: s['restoration'].update(verificationSha256='0' * 64),
            lambda s: s['restoration'].update(namespace='private'), lambda s: s['restoration']['collections'].pop('souvenirs'),
            lambda s: s['restoration']['collections'].update(unrelated={}),
            lambda s: s['restoration']['collections']['history'].update(documents=True),
            lambda s: s['restoration']['collections']['history'].update(documents=1.0),
            lambda s: s['restoration']['collections']['history'].update(documents=0),
            lambda s: s['restoration']['collections']['souvenirs'].update(documents=2),
            lambda s: s['restoration']['collections']['history'].update(bytes=True),
            lambda s: s['restoration']['collections']['history'].update(bytes=1000.0),
            lambda s: s['restoration']['collections']['history'].update(bytes=0),
            lambda s: s['restoration']['collections']['history'].update(bytes=512 * 1024 + 1),
            lambda s: s['restoration']['collections']['history'].update(indexes=False),
            lambda s: s['restoration']['collections']['history'].update(indexes=2.0),
            lambda s: s['restoration']['collections']['history'].update(indexes=0),
            lambda s: s['restoration']['collections']['history'].update(indexes=65),
            lambda s: s['restoration']['collections']['history'].update(sourceDocumentsSha256='a' * 63),
            lambda s: s['restoration']['collections']['history'].update(sourceDocumentsSha256='A' * 64),
            lambda s: s['restoration']['collections']['history'].update(restoredDocumentsSha256='0' * 64),
            lambda s: s['restoration']['collections']['history'].update(restoredIndexesSha256='0' * 64),
            lambda s: s['restoration']['collections']['history'].update(documentsBody='Synthetic private body')]
        for mutation in mutations:
            self.native_calls = 0
            def change(data, _): mutation(data['snapshot']); data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): self.observed(change)

    def test_second_native_hash_change_or_lost_reply_refuses_without_retry(self):
        def change(data, call):
            if call == 2:
                group = data['snapshot']['restoration']['collections']['history']
                group.update(sourceDocumentsSha256='c' * 64, restoredDocumentsSha256='c' * 64)
                data['fingerprint'] = digest(data['snapshot'])
        with self.assertRaises(ValueError): self.observed(change)
        self.assertEqual(self.native_calls, 2)
        for error in (urllib.error.URLError('Synthetic private detail'), TimeoutError('Synthetic private detail')):
            calls = []
            def lost(*a, **kw): calls.append(a); raise error
            with self.assertRaises(ValueError) as caught: capture('http://core.invalid', self.saved, self.downstream, opener=lost)
            self.assertEqual(len(calls), 1); self.assertNotIn('private detail', str(caught.exception))

    def test_every_snapshot_engine_and_collection_field_is_required(self):
        for path in ((), ('restoration',), ('restoration', 'collections'), ('restoration', 'collections', 'history')):
            original = self.response({'observationId': 'synthetic'})['snapshot']
            for part in path: original = original[part]
            for key in original:
                self.native_calls = 0
                def change(data, _):
                    current = data['snapshot']
                    for part in path: current = current[part]
                    current.pop(key); data['fingerprint'] = digest(data['snapshot'])
                with self.subTest(path=path, missing=key), self.assertRaises(ValueError): self.observed(change)

    def test_malformed_ambiguous_nonfinite_and_over_capacity_responses_refuse(self):
        for raw in (b'bad-json', b'{"ok":true,"ok":false}', b'{"data":NaN}', b'x' * (MAX_RESPONSE + 1)):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                capture('http://core.invalid', self.saved, self.downstream, opener=lambda *a, **kw: io.BytesIO(raw))
        with patch('native_history_core_restoration.MAX_SNAPSHOT', 100), self.assertRaisesRegex(ValueError, 'snapshot capacity'):
            self.observed()
        self.native_calls = 0
        with patch('native_history_core_restoration.MAX_TOTAL_BYTES', 1000), self.assertRaisesRegex(ValueError, 'document capacity'):
            self.observed()

    def test_v12_implies_v10_and_is_final_http_before_local_checks(self):
        report = self.reconciled(opener=self.transport())
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v12')
        self.assertIn('nativeGlobalDownstream', report); self.assertIn('nativeFindingScopes', report)
        self.assertEqual(sum(request.full_url.endswith('/decision-state/discover') for request in self.calls), 3)
        self.assertTrue(all(request.full_url.endswith('/core-restoration') for request in self.calls[-2:]))
        self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS)); self.assertEqual(report['cleanupStatus'], 'blocked')

    def test_v12_composes_v11_then_rebinds_its_restoration_proof_without_http(self):
        from native_history_review_restoration import bind_local
        with patch('native_history_review_restoration.bind_local', wraps=bind_local) as bound:
            report = self.reconciled(review_manifest=True, review_restoration_checks=self.fx.checks, opener=self.transport())
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v12')
        self.assertEqual(self.fx.manifest_calls, 2); self.assertEqual(self.native_calls, 2)
        self.assertEqual(bound.call_args.args[-1], report['nativeReviewManifest']['snapshot']['restoration'])
        self.assertTrue(all(request.full_url.endswith('/core-restoration') for request in self.calls[-2:]))
        with self.assertRaisesRegex(ValueError, 'requires retained'):
            self.reconciled(review_manifest=True, opener=lambda *a, **kw: self.fail('No HTTP before required checks'))

    def test_v12_composes_v9_and_rebinds_its_restoration_proof(self):
        from native_history_review_restoration import bind_local
        with patch('native_history_review_restoration.bind_local', wraps=bind_local) as bound:
            report = self.reconciled(review_restoration_checks=self.fx.checks, opener=self.transport())
        self.assertEqual(bound.call_args.args[-1], report['nativeReviewRestorationScope'])
        self.assertNotIn('nativeReviewManifest', report)

    def test_v12_keeps_v5_receipts_without_requiring_v9_or_v11(self):
        with patch('native_history_restoration_scope.capture', return_value={'syntheticOnly': True}) as restored:
            report = self.reconciled(restoration_checks=self.fx.checks, opener=self.transport())
        restored.assert_called_once(); self.assertEqual(report['nativeRestorationScope'], {'syntheticOnly': True})

    def test_local_disposition_or_graph_changes_during_final_http_prevent_success(self):
        for kind in ('disposition', 'graph'):
            self.setUp()
            after = (lambda: self.fx.fx.lane('bulk')) if kind == 'disposition' else lambda: self.fx.graph.update(filesSha256='9' * 64)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.reconciled(review_restoration_checks=self.fx.checks, opener=self.transport(after=after))

    def test_cli_immutable_private_report_count_only_stdout_exit_two_and_no_report_on_change(self):
        base = self.fx.fx.root.parent; saved, output = base / 'saved.json', base / 'core.json'
        save(saved, self.saved); before = saved.read_bytes()
        args = ['--root', str(self.fx.fx.root), '--before', self.fx.fx.before.isoformat(), '--dispositions', str(saved),
                '--output', str(output), '--native-core-restoration']
        with patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=self.transport())), \
                redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(main(args), 2)
        report, summary = load(output), json.loads(printed.getvalue())
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v12')
        self.assertEqual(output.stat().st_mode & 0o777, 0o600); self.assertEqual(saved.read_bytes(), before)
        self.assertEqual(summary['nativeCoreRestoration'], {'history': {'documents': 1, 'bytes': 1000, 'indexes': 2},
            'souvenirs': {'documents': 1, 'bytes': 1000, 'indexes': 2}})
        self.assertNotIn('Sha256', printed.getvalue()); self.assertNotIn(self.saved[0]['messageId'], printed.getvalue())
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()): main(args)
        args[-2] = str(output.with_name('changed.json')); self.native_calls = 0
        transport = self.transport(after=lambda: self.fx.fx.lane('bulk'))
        with patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=transport)), \
                redirect_stdout(io.StringIO()), self.assertRaises(ValueError): main(args)
        self.assertFalse(Path(args[-2]).exists()); self.assertEqual(saved.read_bytes(), before)


if __name__ == '__main__': unittest.main()
