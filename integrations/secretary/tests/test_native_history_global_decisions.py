"""Global native selected decisions, synthetic transport only."""
from contextlib import redirect_stdout
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
from native_history_message_scope import references, discover
from native_history_finding_scope import capture as capture_findings
from native_history_global_decisions import CONTRACT, capture, expected_snapshot, MAX_RESPONSE
from retention_plan import NATIVE_GAPS
from retention_reconcile import main, reconcile
import test_native_history_finding_scope as fixtures


class NativeGlobalDecisionTests(unittest.TestCase):
    setUp = fixtures.NativeFindingScopeTests.setUp
    with_finding = fixtures.NativeFindingScopeTests.with_finding
    refresh_proofs = fixtures.NativeFindingScopeTests.refresh_proofs
    lane = fixtures.NativeFindingScopeTests.lane
    entry = fixtures.NativeFindingScopeTests.entry
    owned = fixtures.NativeFindingScopeTests.owned
    current = fixtures.NativeFindingScopeTests.current
    response = fixtures.NativeFindingScopeTests.response
    prepare = fixtures.NativeFindingScopeTests.prepare

    def transport(self, entries, mutate=None, after=None):
        native = fixtures.NativeFindingScopeTests.opener(self, entries)
        self.global_calls = 0
        def open_(request, timeout):
            if not request.full_url.endswith('/decision-state/global'):
                return native(request, timeout)
            self.assertEqual(timeout, 240); self.global_calls += 1
            body = json.loads(request.data)
            findings = []
            for source in body['sources']:
                finding = self.response(entries, {'source': source, 'observationId': body['observationId']})
                findings.append({'reference': source, 'snapshot': finding['snapshot'], 'fingerprint': finding['fingerprint']})
            snapshot = expected_snapshot(body['sources'], findings)
            value = {'authority': 'agentx.core', 'contract': CONTRACT, 'observationId': body['observationId'],
                'observedAt': '2026-01-01T12:00:00.000Z', 'snapshot': snapshot, 'fingerprint': digest(snapshot),
                'status': 'observed_match' if 'expected' in body else 'observed',
                'consistency': 'two-complete-finding-passes-with-final-global-core-fence',
                'downstreamState': 'not_rechecked', 'atomicBatch': False, 'semanticAcceptance': False,
                'authenticatedPerson': None, 'executionAllowed': False, 'cleanupStatus': 'blocked',
                'nativeValidationGaps': list(NATIVE_GAPS)}
            if mutate: mutate(value, self.global_calls)
            if self.global_calls == 2 and after: after()
            return io.BytesIO(json.dumps({'ok': True, 'data': value}).encode())
        return open_

    def selected(self, mutate=None):
        entry, saved = self.prepare(); entries = [entry]; transport = self.transport(entries, mutate)
        _, scopes = discover('http://core.invalid', saved, opener=transport)
        findings = capture_findings('http://core.invalid', saved, [self.current()], scopes, entries, opener=transport)
        return saved, findings, transport

    def test_two_native_scopes_pin_complete_selected_findings_and_keep_all_gaps(self):
        saved, findings, transport = self.selected()
        value = capture('http://core.invalid', saved, findings, opener=transport)
        self.assertEqual(self.global_calls, 2)
        self.assertNotEqual(value['initialObservationId'], value['observationId'])
        self.assertEqual(value['snapshot']['coverage']['counts']['observedDecision'], 1)
        self.assertEqual(value['snapshot']['coverage']['counts']['entries'], 1)
        self.assertEqual(value['fingerprint'], digest(value['snapshot']))

    def test_invalid_unsafe_omitted_or_changed_global_reply_refuses(self):
        mutations = [lambda d: d.update(contract='old'), lambda d: d.update(observationId='old'),
            lambda d: d.update(executionAllowed=True), lambda d: d.update(semanticAcceptance=True),
            lambda d: d.update(atomicBatch=True), lambda d: d.update(nativeValidationGaps=[]),
            lambda d: d.pop('authenticatedPerson'), lambda d: d.update(authenticatedPerson='owner'),
            lambda d: d.update(status='changed'), lambda d: d.update(fingerprint='0' * 64), lambda d: d.update(observedAt='bad'),
            lambda d: d['snapshot']['findings'].clear(), lambda d: d['snapshot']['coreScopes'].clear(),
            lambda d: d['snapshot']['sources'].clear(), lambda d: d['snapshot'].update(sourceSetSha256='0' * 64),
            lambda d: d['snapshot']['coverage']['counts'].update(entries=True),
            lambda d: d['snapshot']['coverage']['counts'].update(entries=1.0),
            lambda d: d['snapshot']['findings'][0]['snapshot']['inventory'].update(reviewSha256='0' * 64),
            lambda d: d['snapshot']['findings'][0]['snapshot'].update(privateText='Synthetic private'),
            lambda d: d['snapshot']['coreScopes'][0]['members'][0].update(entryRevision=False)]
        for mutation in mutations:
            def mutate(value, _): mutation(value)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                saved, findings, transport = self.selected(mutate)
                capture('http://core.invalid', saved, findings, opener=transport)

    def test_recomputed_fingerprint_cannot_hide_numeric_substitution_or_stale_member(self):
        for wrong in (True, 1.0, 999):
            def mutate(value, _):
                value['snapshot']['coverage']['counts']['entries'] = wrong
                value['fingerprint'] = digest(value['snapshot'])
            with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                saved, findings, transport = self.selected(mutate)
                capture('http://core.invalid', saved, findings, opener=transport)

    def test_incomplete_duplicate_wrong_source_selection_refuses_before_http(self):
        saved, findings, transport = self.selected()
        for selected in ([], findings + findings, [{**findings[0], 'reference': {**findings[0]['reference'], 'messageId': '9' * 16}}]):
            with self.subTest(selected=selected), self.assertRaises(ValueError):
                capture('http://core.invalid', saved, selected, opener=transport)
        self.assertEqual(self.global_calls, 0)

    def test_v8_composes_old_read_contracts_and_final_fences(self):
        entry, saved = self.prepare()
        report = reconcile(self.archive, self.before, saved, 'http://core.invalid', global_decisions=True, opener=self.transport([entry]))
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v8')
        self.assertEqual(report['counts'], {'observed_match': 1})
        self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS)); self.assertFalse(report['executionAllowed'])
        self.assertEqual(report['nativeGlobalDecisions']['snapshot']['coverage']['counts']['messages'], 1)
        self.assertEqual(sum(call.full_url.endswith('/decision-state/discover') for call in self.calls), 3)

    def test_late_core_and_archive_changes_refuse_a_global_report(self):
        for kind in ('core', 'archive'):
            entry, saved = self.prepare()
            action = (lambda: entry.update(revision=entry['revision'] + 1)) if kind == 'core' else lambda: self.lane('bulk')
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                reconcile(self.archive, self.before, saved, 'http://core.invalid', global_decisions=True,
                          opener=self.transport([entry], after=action))

    def test_v8_can_include_restoration_downstream_and_live_mailbox_without_promoting_them(self):
        entry, saved = self.prepare()
        check = {'entryId': entry['id'], 'requestId': '00000000-0000-4000-8000-000000000001',
                 'snapshotHash': 'a' * 64, 'source': references(saved)[0]}
        with patch('native_history_restoration_scope.capture', return_value={'synthetic': 'restoration'}) as restore, \
                patch('native_history_downstream_scope.capture', return_value=[]) as downstream, \
                patch('native_history_mailbox_scope.capture', return_value=[]) as mailbox:
            report = reconcile(self.archive, self.before, saved, 'http://core.invalid', global_decisions=True,
                restoration_checks=[check], downstream_scope=True, mailbox_scope=True, opener=self.transport([entry]))
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v8')
        self.assertEqual(report['nativeRestorationScope'], {'synthetic': 'restoration'})
        restore.assert_called_once(); downstream.assert_called_once(); mailbox.assert_called_once()

    def test_cli_counts_only_and_holds_unrepresented_action_without_changing_saved_input(self):
        entry, _ = self.prepare(); self.with_finding('actions'); saved = self.owned([entry]); base = Path(self.temp.name)
        source, output = base / 'saved.json', base / 'global.json'; save(source, saved)
        transport = self.transport([entry])
        with patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=transport)), redirect_stdout(io.StringIO()) as printed:
            code = main(['--root', str(self.root), '--before', self.before.isoformat(), '--dispositions', str(source),
                         '--core', 'http://core.invalid', '--native-global-decisions', '--output', str(output)])
        self.assertEqual(code, 2); report = load(output)
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v8')
        self.assertEqual(json.loads(printed.getvalue())['nativeGlobalDecisions']['heldMessages'], 1)
        self.assertEqual(load(source), saved); self.assertNotIn(self.mid, printed.getvalue())
        self.assertFalse(report['executionAllowed']); self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS))

    def test_transport_and_ambiguous_or_oversized_json_refuse(self):
        saved, findings, _ = self.selected()
        for raw in (b'bad-json', b'{"ok":true,"ok":false}', b'{"data":NaN}', b'x' * (MAX_RESPONSE + 1)):
            with self.subTest(raw=raw[:20]), self.assertRaises(ValueError):
                capture('http://core.invalid', saved, findings, opener=lambda *a, **kw: io.BytesIO(raw))
        def offline(*a, **kw): raise urllib.error.URLError('Synthetic private path')
        with self.assertRaisesRegex(ValueError, 'unavailable') as error:
            capture('http://core.invalid', saved, findings, opener=offline)
        self.assertNotIn('private path', str(error.exception))


if __name__ == '__main__': unittest.main()
