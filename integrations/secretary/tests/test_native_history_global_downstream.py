"""Complete downstream selection, strict native observation and final fences."""
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_store import save, load
from native_history_decisions import digest
from native_history_message_scope import discover
from native_history_finding_scope import capture as capture_findings
from native_history_downstream_scope import capture as capture_downstream
from native_history_global_downstream import CONTRACT, capture, expected_snapshot, MAX_RESPONSE
from retention_plan import NATIVE_GAPS
from retention_reconcile import reconcile, main
import test_native_history_downstream_scope as fixtures
import test_native_history_global_decisions as global_fixtures


class GlobalDownstreamTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.NativeDownstreamTests()
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)

    def transport(self, entries, mutate=None, after=None, state='current_link'):
        native = self.fx.transport(entries, state=state)
        self.calls = 0
        def open_(request, timeout):
            if not request.full_url.endswith('/decision-state/downstream/global'):
                return native(request, timeout)
            self.assertEqual(timeout, 240)
            self.calls += 1
            body = json.loads(request.data)
            members = []
            for source in body['sources']:
                value = self.fx.downstream(entries, {'source': source, 'observationId': body['observationId']}, state=state)
                members.append({'reference': source, 'snapshot': value['snapshot'], 'fingerprint': value['fingerprint']})
            snapshot = expected_snapshot(body['sources'], members)
            value = {'authority': 'agentx.core', 'contract': CONTRACT, 'observationId': body['observationId'],
                     'observedAt': '2026-01-01T12:00:00.000Z', 'snapshot': snapshot, 'fingerprint': digest(snapshot),
                     'status': 'observed_match' if 'expected' in body else 'observed',
                     'consistency': 'two-complete-downstream-passes-with-final-joined-core-note-fence',
                     'downstreamState': 'selected-linked-souvenirs-observed', 'atomicBatch': False, 'semanticAcceptance': False,
                     'authenticatedPerson': None, 'executionAllowed': False, 'cleanupStatus': 'blocked',
                     'nativeValidationGaps': list(NATIVE_GAPS)}
            if mutate: mutate(value, self.calls)
            if self.calls == 2 and after: after()
            return io.BytesIO(json.dumps({'ok': True, 'data': value}).encode())
        return open_

    def observed(self, mutate=None):
        entry, saved = self.fx.prepare()
        entries = [entry]
        transport = self.transport(entries, mutate)
        _, scopes = discover('http://core.invalid', saved, opener=transport)
        findings = capture_findings('http://core.invalid', saved, [self.fx.current()], scopes, entries, opener=transport)
        downstream = capture_downstream('http://core.invalid', saved, findings, entries, opener=transport)
        return capture('http://core.invalid', saved, downstream, opener=transport), saved, downstream

    def test_two_complete_native_observations_and_exact_existing_scope_binding(self):
        value, saved, downstream = self.observed()
        self.assertEqual(self.calls, 2)
        self.assertNotEqual(value['observationId'], value['initialObservationId'])
        self.assertEqual(value['snapshot'], expected_snapshot(saved, downstream))
        self.assertEqual(value['snapshot']['coverage']['counts']['observedNotes'], 1)
        self.assertEqual(value['snapshot']['coverage']['counts']['currentLinks'], 1)

    def test_partial_duplicate_and_changed_shared_selections_refuse_before_http(self):
        _, saved, downstream = self.observed()
        with self.assertRaises(ValueError): expected_snapshot(saved, [])
        with self.assertRaises(ValueError): expected_snapshot(saved, downstream * 2)
        stale = deepcopy(downstream)
        stale[0]['snapshot']['entries'][0]['note']['revision'] += 1
        with self.assertRaises(ValueError): expected_snapshot(saved, stale)

    def test_unsafe_stale_or_retyped_native_evidence_is_rejected(self):
        mutations = [lambda d: d.update(contract='old'), lambda d: d.update(executionAllowed=True),
            lambda d: d.update(semanticAcceptance=True), lambda d: d.pop('authenticatedPerson'),
            lambda d: d.update(atomicBatch=0), lambda d: d.update(nativeValidationGaps=[]),
            lambda d: d.update(consistency='per-message-only'), lambda d: d.update(observationId='old'),
            lambda d: d.update(observedAt='2026-13-01T12:00:00.000Z'), lambda d: d['snapshot']['members'].clear(),
            lambda d: d['snapshot']['coverage']['counts'].update(entries=True),
            lambda d: d['snapshot']['coverage']['counts'].update(entries=1.0),
            lambda d: d['snapshot']['members'][0]['snapshot']['entries'][0]['note'].update(revision=1)]
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                self.observed(lambda value, _: mutate(value))
        with self.assertRaises(ValueError):
            self.observed(lambda value, count: value['snapshot']['coverage']['counts'].update(currentLinks=0) if count == 2 else None)

    def test_transport_refusals_are_bounded_and_content_free(self):
        _, saved, scopes = self.observed()
        for opener in (lambda *a, **kw: io.BytesIO(b'x' * (MAX_RESPONSE + 1)),
                       lambda *a, **kw: io.BytesIO(b'{"ok":true,"ok":false}'),
                       lambda *a, **kw: io.BytesIO(b'{"data":NaN}'),
                       lambda *a, **kw: (_ for _ in ()).throw(urllib.error.URLError('private failure'))):
            with self.assertRaises(ValueError) as caught: capture('http://core.invalid', saved, scopes, opener=opener)
            self.assertNotIn('private failure', str(caught.exception))

    def test_v10_implies_native_downstream_keeps_gaps_and_writes_only_private_counts_stdout(self):
        entry, saved = self.fx.prepare()
        saved_path, output = self.fx.root.parent / 'global-saved.json', self.fx.root.parent / 'global-observed.json'
        save(saved_path, saved)
        before = saved_path.read_bytes()
        args = ['--root', str(self.fx.root), '--before', self.fx.before.isoformat(), '--dispositions', str(saved_path),
                '--core', 'http://core.invalid', '--native-global-downstream', '--output', str(output)]
        stream = io.StringIO()
        transport = self.transport([entry])
        with patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=transport)), redirect_stdout(stream):
            result = main(args)
        report, summary = load(output), json.loads(stream.getvalue())
        self.assertEqual(result, 0)  # Matching observations retain all native acceptance gaps.
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v10')
        self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS))
        self.assertFalse(report['executionAllowed'])
        self.assertEqual(report['cleanupStatus'], 'blocked')
        self.assertEqual(summary['nativeGlobalDownstream']['observedNotes'], 1)
        self.assertNotIn('snapshot', summary['nativeGlobalDownstream'])
        self.assertEqual(before, saved_path.read_bytes())
        with self.assertRaises(SystemExit), redirect_stdout(io.StringIO()): main(args)
        args[-1] = str(output.with_name('global-held.json'))
        transport = self.transport([entry], state='unavailable')
        with patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=transport)), redirect_stdout(io.StringIO()):
            self.assertEqual(main(args), 2)
        held = load(Path(args[-1]))
        self.assertEqual(held['nativeGlobalDownstream']['snapshot']['coverage']['counts']['unavailable'], 1)

    def test_core_change_after_all_global_calls_refuses_before_success_report(self):
        entry, saved = self.fx.prepare()
        transport = self.transport([entry], after=lambda: entry.update(revision=entry['revision'] + 1))
        with self.assertRaises(ValueError):
            reconcile(self.fx.archive, self.fx.before, saved, 'http://core.invalid', global_downstream=True, opener=transport)
        self.assertEqual(self.calls, 2)

    def test_v10_composes_v8_and_v9_without_replacing_their_native_evidence(self):
        entry, saved = self.fx.prepare()
        entries = [entry]
        downstream = self.transport(entries)
        decisions = global_fixtures.NativeGlobalDecisionTests.transport(self.fx, entries)
        def transport(request, timeout):
            return (decisions if request.full_url.endswith('/decision-state/global') else downstream)(request, timeout)
        ref = {key: entry['source'][key] for key in ('system', 'messageId', 'threadId', 'sourceSha256')}
        checks = [{'entryId': entry['id'], 'requestId': '11111111-1111-4111-8111-111111111111', 'snapshotHash': 'a' * 64, 'source': ref}]
        with patch('native_history_review_restoration.capture', return_value={'syntheticOnly': True}) as restored:
            report = reconcile(self.fx.archive, self.fx.before, saved, 'http://core.invalid', opener=transport,
                               global_decisions=True, review_restoration_checks=checks, global_downstream=True)
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v10')
        self.assertEqual(report['nativeGlobalDecisions']['snapshot']['coverage']['counts']['messages'], 1)
        self.assertEqual(report['nativeGlobalDownstream']['snapshot']['coverage']['counts']['messages'], 1)
        self.assertEqual(report['nativeReviewRestorationScope'], {'syntheticOnly': True})
        self.assertEqual(restored.call_args.args[2], checks)
        self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS))


if __name__ == '__main__': unittest.main()
