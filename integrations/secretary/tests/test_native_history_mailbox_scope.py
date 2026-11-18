"""Native live message reconciliation; synthetic transports and private fixtures."""
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
from native_history_message_scope import discover, references
from native_history_finding_scope import capture as capture_findings
from native_history_mailbox_scope import CONTRACT, capture, coverage, MAX_RESPONSE
from retention_plan import NATIVE_GAPS
from retention_reconcile import reconcile, main
import test_native_history_finding_scope as fixtures


class NativeMailboxTests(unittest.TestCase):
    setUp = fixtures.NativeFindingScopeTests.setUp
    with_finding = fixtures.NativeFindingScopeTests.with_finding
    refresh_proofs = fixtures.NativeFindingScopeTests.refresh_proofs
    lane = fixtures.NativeFindingScopeTests.lane
    entry = fixtures.NativeFindingScopeTests.entry
    owned = fixtures.NativeFindingScopeTests.owned
    current = fixtures.NativeFindingScopeTests.current
    response = fixtures.NativeFindingScopeTests.response
    prepare = fixtures.NativeFindingScopeTests.prepare

    def mailbox(self, entries, body, mode='present'):
        finding = self.response(entries, body)
        ref = body['source']
        row = {'messageId': ref['messageId'], 'threadId': ref['threadId'], 'internalDate': '1000',
               'historyId': '99999999999999999999', 'labelIds': ['SENT'],
               'raw': {'sha256': ref['sourceSha256'], 'bytes': 1000}}
        if mode == 'recent': row['internalDate'] = str(int(self.before.timestamp()) * 1000)
        if mode == 'draft': row['labelIds'] = ['DRAFT', 'SENT']
        mailbox = {'contract': 'secretary.mailbox-source/v1', 'reference': ref, 'accountSelectionSha256': 'c' * 64,
                   'status': 'not_found' if mode == 'not_found' else 'present',
                   'current': None if mode == 'not_found' else row, 'scope': 'selected-live-message-raw-and-metadata'}
        snapshot = {'contract': CONTRACT, 'reference': ref, 'coreScope': finding['snapshot']['coreScope'],
                    'mailbox': mailbox, 'coverage': coverage(mailbox, ref)}
        return {'authority': 'agentx.core', 'contract': CONTRACT, 'observationId': body['observationId'],
                'observedAt': '2026-01-01T12:00:00.000Z', 'snapshot': snapshot, 'fingerprint': digest(snapshot),
                'status': 'observed_match' if 'expected' in body else 'observed',
                'consistency': 'two-agreeing-live-message-reads-with-final-core-fence',
                'downstreamState': 'not_rechecked', 'atomicBatch': False, 'semanticAcceptance': False,
                'mailboxEffects': 0, 'approvalBound': False, 'authenticatedPerson': None,
                'executionAllowed': False, 'cleanupStatus': 'blocked', 'nativeValidationGaps': list(NATIVE_GAPS)}

    def transport(self, entries, mutate=None, mode='present', after=None):
        native = fixtures.NativeFindingScopeTests.opener(self, entries)
        self.mailbox_calls = 0
        def open_(request, timeout):
            if not request.full_url.endswith('/decision-state/mailbox'):
                return native(request, timeout)
            self.assertEqual(timeout, 60); self.mailbox_calls += 1
            body = json.loads(request.data); value = self.mailbox(entries, body, mode)
            if mutate: mutate(value, self.mailbox_calls)
            if self.mailbox_calls == 2 and after: after()
            return io.BytesIO(json.dumps({'ok': True, 'data': value}).encode())
        return open_

    def observed(self, mutate=None, mode='present'):
        entry, saved = self.prepare(); entries = [entry]
        transport = self.transport(entries, mutate, mode)
        _, scopes = discover('http://core.invalid', saved, opener=transport)
        findings = capture_findings('http://core.invalid', saved, [self.current()], scopes, entries, opener=transport)
        return capture('http://core.invalid', saved, findings, self.before, opener=transport)

    def test_two_native_scopes_bind_exact_core_finding_versions_without_acceptance(self):
        rows = self.observed(); self.assertEqual(self.mailbox_calls, 2)
        row = rows[0]; self.assertNotEqual(row['initialObservationId'], row['observationId'])
        self.assertEqual(row['fingerprint'], digest(row['snapshot']))
        self.assertEqual(row['cutoffBlockers'], [])
        self.assertEqual(row['snapshot']['mailbox']['current']['historyId'], '99999999999999999999')

    def test_absence_draft_and_date_cutoff_stay_held(self):
        self.assertEqual(self.observed(mode='not_found')[0]['snapshot']['coverage']['blockers'], ['live_message_not_found'])
        self.assertEqual(self.observed(mode='draft')[0]['snapshot']['coverage']['blockers'], ['live_message_is_draft'])
        self.assertEqual(self.observed(mode='recent')[0]['cutoffBlockers'], ['live_message_outside_cutoff'])

    def test_malformed_or_unsafe_envelope_refuses(self):
        mutations = [lambda d: d.update(contract='old'), lambda d: d.update(observationId='old'),
            lambda d: d.update(executionAllowed=True), lambda d: d.update(semanticAcceptance=True),
            lambda d: d.update(atomicBatch=True), lambda d: d.update(nativeValidationGaps=[]),
            lambda d: d.pop('authenticatedPerson'), lambda d: d.update(authenticatedPerson='owner'),
            lambda d: d.update(approvalBound=True), lambda d: d.update(mailboxEffects=False),
            lambda d: d.update(mailboxEffects=0.0), lambda d: d.update(status='changed'),
            lambda d: d.update(fingerprint='0' * 64), lambda d: d.update(observedAt='bad')]
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                self.observed(lambda data, _: mutate(data))

    def test_recomputed_fingerprint_cannot_hide_invalid_metadata_or_core_pins(self):
        mutations = [lambda s: s['mailbox']['current']['raw'].update(bytes=True),
            lambda s: s['mailbox']['current']['raw'].update(bytes=1000.0),
            lambda s: s['mailbox']['current']['raw'].update(bytes=16777217),
            lambda s: s['mailbox']['current'].update(historyId=999),
            lambda s: s['mailbox']['current'].update(internalDate='01'),
            lambda s: s['mailbox']['current'].update(internalDate='253402300800000'),
            lambda s: s['mailbox']['current'].update(labelIds=['SENT', 'SENT']),
            lambda s: s['mailbox']['current'].update(labelIds=['Z', 'A']),
            lambda s: s['mailbox']['current'].update(labelIds=['A' * 129]),
            lambda s: s['mailbox']['current'].update(subject='Synthetic private content'),
            lambda s: s['mailbox'].update(accountSelectionSha256=['c' * 64]),
            lambda s: s['mailbox']['current']['raw'].update(sha256='f' * 64),
            lambda s: s['mailbox']['current'].update(threadId='f' * 16),
            lambda s: s['coverage'].update(sourceMatches=1),
            lambda s: s['coreScope']['members'][0].update(entryRevision=False),
            lambda s: s['coreScope'].update(fingerprint='f' * 64)]
        for mutate in mutations:
            def change(data, _):
                mutate(data['snapshot']); data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.observed(change)

    def test_second_live_metadata_change_refuses_old_fingerprint(self):
        def change(data, call):
            if call == 2:
                data['snapshot']['mailbox']['current']['historyId'] = '123'
                data['fingerprint'] = digest(data['snapshot'])
        with self.assertRaisesRegex(ValueError, 'fingerprint'): self.observed(change)

    def test_v7_final_fences_and_unchanged_global_gaps(self):
        entry, saved = self.prepare()
        report = reconcile(self.archive, self.before, saved, 'http://core.invalid', mailbox_scope=True, opener=self.transport([entry]))
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v7')
        self.assertEqual(report['counts'], {'observed_match': 1})
        self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS)); self.assertFalse(report['executionAllowed'])
        self.assertEqual(len(report['nativeMailboxScopes']), 1)
        self.assertEqual(sum(call.full_url.endswith('/decision-state/discover') for call in self.calls), 3)

    def test_late_core_and_archive_changes_cannot_publish_pre_mailbox_success(self):
        for change in ('core', 'archive'):
            entry, saved = self.prepare()
            action = (lambda: entry.update(revision=entry['revision'] + 1)) if change == 'core' else lambda: self.lane('bulk')
            with self.subTest(change=change), self.assertRaises(ValueError):
                reconcile(self.archive, self.before, saved, 'http://core.invalid', mailbox_scope=True,
                          opener=self.transport([entry], after=action))

    def test_v7_can_compose_v5_restoration_and_v6_downstream(self):
        entry, saved = self.prepare()
        check = {'entryId': entry['id'], 'requestId': '00000000-0000-4000-8000-000000000001',
                 'snapshotHash': 'a' * 64, 'source': references(saved)[0]}
        restoration = {'status': 'observed_match', 'snapshot': {'members': [check]}}
        with patch('native_history_restoration_scope.capture', return_value=restoration), \
                patch('native_history_downstream_scope.capture', return_value=[]) as downstream:
            report = reconcile(self.archive, self.before, saved, 'http://core.invalid', mailbox_scope=True,
                               downstream_scope=True, restoration_checks=[check], opener=self.transport([entry]))
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v7')
        self.assertEqual(report['nativeRestorationScope'], restoration); downstream.assert_called_once()
        self.assertIn('nativeDownstreamScopes', report)

    def test_cli_holds_recent_source_and_keeps_private_pins_out_of_stdout(self):
        entry, saved = self.prepare(); base = Path(self.temp.name)
        source, output = base / 'saved.json', base / 'report.json'; save(source, saved)
        transport = self.transport([entry], mode='recent')
        with patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=transport)), redirect_stdout(io.StringIO()) as printed:
            code = main(['--root', str(self.root), '--before', self.before.isoformat(), '--dispositions', str(source),
                         '--core', 'http://core.invalid', '--native-mailbox-scope', '--output', str(output)])
        self.assertEqual(code, 2); self.assertEqual(load(output)['schema'], 'agentx.secretary-retention-reconciliation/v7')
        self.assertEqual(json.loads(printed.getvalue())['nativeMailbox'], {'messages': 1, 'heldMessages': 1, 'present': 1})
        self.assertNotIn(self.mid, printed.getvalue()); self.assertEqual(load(source), saved)
        with self.assertRaises(SystemExit):
            with redirect_stdout(io.StringIO()), patch('sys.stderr', io.StringIO()):
                main(['--root', str(self.root), '--before', self.before.isoformat(), '--dispositions', str(source),
                      '--native-mailbox-scope', '--output', str(output)])

    def test_transport_ambiguity_and_capacity_errors_refuse(self):
        entry, saved = self.prepare(); entries = [entry]; transport = self.transport(entries)
        _, scopes = discover('http://core.invalid', saved, opener=transport)
        findings = capture_findings('http://core.invalid', saved, [self.current()], scopes, entries, opener=transport)
        for raw in (b'bad-json', b'{"ok":true,"ok":false}', b'{"data":NaN}', b'x' * (MAX_RESPONSE + 1)):
            with self.subTest(raw=raw[:20]), self.assertRaises(ValueError):
                capture('http://core.invalid', saved, findings, self.before, opener=lambda *a, **kw: io.BytesIO(raw))
        def offline(*a, **kw): raise urllib.error.URLError('Synthetic private path')
        with self.assertRaisesRegex(ValueError, 'unavailable') as error:
            capture('http://core.invalid', saved, findings, self.before, opener=offline)
        self.assertNotIn('private path', str(error.exception))
        with patch('native_history_mailbox_scope.MAX_TOTAL', 1), self.assertRaisesRegex(ValueError, 'aggregate'):
            capture('http://core.invalid', saved, findings, self.before, opener=transport)

    def test_account_selector_must_stay_consistent_across_selected_messages(self):
        entry, saved = self.prepare(); ref = references(saved)[0]; other = {**ref, 'messageId': '9' * 16}
        findings = [{'reference': r} for r in [ref, other]]
        def observed(_core, reference, _finding, **kw):
            return {'snapshot': {'mailbox': {'accountSelectionSha256': ('a' if reference == ref else 'b') * 64, 'current': None}},
                    'fingerprint': 'f' * 64, 'observationId': 'synthetic', 'observedAt': 'synthetic'}, 1
        with patch('native_history_mailbox_scope.observe', side_effect=observed), self.assertRaisesRegex(ValueError, 'selector'):
            capture('http://core.invalid', [ref, other], findings, self.before)


if __name__ == '__main__':
    unittest.main()
