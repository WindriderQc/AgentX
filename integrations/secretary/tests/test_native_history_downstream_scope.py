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
from native_history_message_scope import references, discover
from native_history_finding_scope import capture as capture_findings
from native_history_downstream_scope import CONTRACT, capture, MAX_RESPONSE
from retention_plan import NATIVE_GAPS
from retention_reconcile import reconcile, main
import test_native_history_finding_scope as fixtures


class NativeDownstreamTests(unittest.TestCase):
    setUp = fixtures.NativeFindingScopeTests.setUp
    with_finding = fixtures.NativeFindingScopeTests.with_finding
    refresh_proofs = fixtures.NativeFindingScopeTests.refresh_proofs
    lane = fixtures.NativeFindingScopeTests.lane
    entry = fixtures.NativeFindingScopeTests.entry
    owned = fixtures.NativeFindingScopeTests.owned
    current = fixtures.NativeFindingScopeTests.current
    response = fixtures.NativeFindingScopeTests.response

    def prepare(self):
        entry, _ = fixtures.NativeFindingScopeTests.prepare(self)
        entry['souvenirNoteId'] = '8' * 24
        return entry, self.owned([entry])

    def downstream(self, entries, body, state='current_link'):
        finding = self.response(entries, body)
        rows = []
        for pin in finding['snapshot']['coreScope']['members']:
            entry = next(entry for entry in entries if entry['id'] == pin['entryId'])
            actual = state if entry.get('souvenirNoteId') else 'not_linked'
            note = {'id': entry.get('souvenirNoteId'), 'revision': 0, 'fingerprint': 'a' * 64,
                    'sourceBinding': True, 'contextBinding': True, 'replacementPending': False}
            rows.append({'entryId': entry['id'], 'entryRevision': entry['revision'], 'decisionFingerprint': pin['fingerprint'],
                         'state': actual, 'note': note if actual == 'current_link' else None,
                         'blockers': ['linked_souvenir_unavailable'] if actual == 'unavailable' else []})
        counts = {'entries': len(rows), 'notLinked': sum(row['state'] == 'not_linked' for row in rows),
                  'currentLinks': sum(row['state'] == 'current_link' for row in rows),
                  'unavailable': sum(row['state'] == 'unavailable' for row in rows), 'needsReview': 0}
        blockers = list(finding['snapshot']['coverage']['blockers'])
        if counts['unavailable']:
            blockers.append('linked_souvenirs_need_review')
        snapshot = {'contract': CONTRACT, 'reference': body['source'],
                    'findingScope': {'fingerprint': finding['fingerprint'], 'snapshot': finding['snapshot']},
                    'entries': rows, 'coverage': {'counts': counts, 'blockers': blockers}}
        return {'authority': 'agentx.core', 'contract': CONTRACT, 'observationId': body['observationId'],
                'observedAt': '2026-01-01T12:00:00.000Z', 'snapshot': snapshot, 'fingerprint': digest(snapshot),
                'status': 'observed_match' if 'expected' in body else 'observed',
                'consistency': 'two-agreeing-linked-souvenir-reads-with-final-core-fence',
                'downstreamState': 'linked-souvenirs-observed', 'atomicBatch': False, 'semanticAcceptance': False,
                'authenticatedPerson': None, 'executionAllowed': False, 'cleanupStatus': 'blocked',
                'nativeValidationGaps': list(NATIVE_GAPS)}

    def transport(self, entries, mutate=None, state='current_link', after=None):
        native = fixtures.NativeFindingScopeTests.opener(self, entries)
        self.downstream_calls = 0
        def open_(request, timeout):
            if not request.full_url.endswith('/decision-state/downstream'):
                return native(request, timeout)
            self.assertEqual(timeout, 60); self.downstream_calls += 1
            body = json.loads(request.data); value = self.downstream(entries, body, state)
            if mutate:
                mutate(value, self.downstream_calls)
            if self.downstream_calls == 2 and after:
                after()
            return io.BytesIO(json.dumps({'ok': True, 'data': value}).encode())
        return open_

    def observed(self, mutate=None, state='current_link'):
        entry, saved = self.prepare(); entries = [entry]
        transport = self.transport(entries, mutate, state)
        _, scopes = discover('http://core.invalid', saved, opener=transport)
        findings = capture_findings('http://core.invalid', saved, [self.current()], scopes, entries, opener=transport)
        return capture('http://core.invalid', saved, findings, entries, opener=transport)

    def test_two_fresh_native_observations_bind_current_note_and_existing_findings(self):
        rows = self.observed(); self.assertEqual(self.downstream_calls, 2)
        row = rows[0]
        self.assertNotEqual(row['initialObservationId'], row['observationId'])
        self.assertEqual(row['fingerprint'], digest(row['snapshot']))
        self.assertEqual(row['snapshot']['coverage']['counts']['currentLinks'], 1)
        self.assertEqual(row['snapshot']['entries'][0]['note']['revision'], 0)

    def test_missing_existing_note_stays_held_instead_of_becoming_accepted_memory(self):
        row = self.observed(state='unavailable')[0]
        self.assertIn('linked_souvenirs_need_review', row['snapshot']['coverage']['blockers'])
        self.assertIsNone(row['snapshot']['entries'][0]['note'])

    def test_malformed_unsafe_or_incomplete_native_results_refuse(self):
        mutations = [lambda d: d.update(contract='old'), lambda d: d.update(observationId='old'),
                     lambda d: d.update(executionAllowed=True), lambda d: d.update(semanticAcceptance=True),
                     lambda d: d.update(atomicBatch=True), lambda d: d.update(nativeValidationGaps=[]),
                     lambda d: d.pop('authenticatedPerson'), lambda d: d.update(authenticatedPerson='owner'),
                     lambda d: d.update(downstreamState='settled'), lambda d: d.update(status='changed'),
                     lambda d: d.update(fingerprint='0' * 64), lambda d: d.update(observedAt='bad'),
                     lambda d: d['snapshot']['entries'].clear(),
                     lambda d: d['snapshot']['entries'][0].update(state=[]),
                     lambda d: d['snapshot']['entries'][0]['note'].update(revision=True),
                     lambda d: d['snapshot']['entries'][0]['note'].update(text='Private field must refuse'),
                     lambda d: d['snapshot']['entries'][0]['note'].update(id='9' * 24),
                     lambda d: d['snapshot']['entries'][0]['note'].update(sourceBinding=False),
                     lambda d: d['snapshot']['entries'][0]['note'].update(contextBinding=False),
                     lambda d: d['snapshot']['entries'][0]['note'].update(replacementPending=True),
                     lambda d: d['snapshot']['coverage']['counts'].update(currentLinks=999)]
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                self.observed(lambda data, _: mutate(data))

    def test_recomputed_envelope_cannot_hide_missing_provenance_blocker(self):
        def mutate(data, _):
            data['snapshot']['entries'][0]['note']['sourceBinding'] = False
            data['fingerprint'] = digest(data['snapshot'])
        with self.assertRaisesRegex(ValueError, 'binding failures'):
            self.observed(mutate)

    def test_second_note_change_refuses_old_fingerprint(self):
        def mutate(data, call):
            if call == 2:
                data['snapshot']['entries'][0]['note']['revision'] = 1
                data['fingerprint'] = digest(data['snapshot'])
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            self.observed(mutate)

    def test_v6_composes_existing_contracts_and_preserves_all_global_gaps(self):
        entry, saved = self.prepare()
        report = reconcile(self.archive, self.before, saved, 'http://core.invalid', downstream_scope=True,
                           opener=self.transport([entry]))
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v6')
        self.assertEqual(report['counts'], {'observed_match': 1})
        self.assertEqual(report['nativeDownstreamScopes'][0]['snapshot']['coverage']['counts']['currentLinks'], 1)
        self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS)); self.assertFalse(report['executionAllowed'])
        self.assertEqual(sum(call.full_url.endswith('/decision-state/discover') for call in self.calls), 3)

    def test_late_core_and_archive_changes_cannot_publish_pre_downstream_success(self):
        for change in ('core', 'archive'):
            entry, saved = self.prepare()
            action = (lambda: entry.update(revision=entry['revision'] + 1)) if change == 'core' else lambda: self.lane('bulk')
            with self.subTest(change=change), self.assertRaises(ValueError):
                reconcile(self.archive, self.before, saved, 'http://core.invalid', downstream_scope=True,
                          opener=self.transport([entry], after=action))

    def test_v6_can_include_existing_v5_restoration_without_changing_its_receipt(self):
        entry, saved = self.prepare()
        check = {'entryId': entry['id'], 'requestId': '00000000-0000-4000-8000-000000000001',
                 'snapshotHash': 'a' * 64, 'source': references(saved)[0]}
        retained = {'status': 'observed_match', 'snapshot': {'members': [check]}}
        with patch('native_history_restoration_scope.capture', return_value=retained):
            report = reconcile(self.archive, self.before, saved, 'http://core.invalid', downstream_scope=True,
                               restoration_checks=[check], opener=self.transport([entry]))
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v6')
        self.assertEqual(report['nativeRestorationScope'], retained)
        self.assertIn('nativeDownstreamScopes', report)

    def test_cli_keeps_private_pins_out_of_stdout_and_holds_an_unavailable_note(self):
        entry, saved = self.prepare(); base = Path(self.temp.name)
        source, output = base / 'saved.json', base / 'report.json'; save(source, saved)
        transport = self.transport([entry], state='unavailable')
        with patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=transport)), redirect_stdout(io.StringIO()) as printed:
            code = main(['--root', str(self.root), '--before', self.before.isoformat(), '--dispositions', str(source),
                         '--core', 'http://core.invalid', '--native-downstream-scope', '--output', str(output)])
        self.assertEqual(code, 2); self.assertEqual(load(output)['schema'], 'agentx.secretary-retention-reconciliation/v6')
        self.assertEqual(json.loads(printed.getvalue())['nativeDownstream'], {'messages': 1, 'heldMessages': 1, 'currentLinks': 0, 'unlinkedEntries': 0})
        self.assertNotIn(self.mid, printed.getvalue()); self.assertNotIn(entry['souvenirNoteId'], printed.getvalue())
        self.assertEqual(load(source), saved)

    def test_transport_and_ambiguous_json_refuse_without_a_report(self):
        entry, saved = self.prepare(); entries = [entry]; transport = self.transport(entries)
        _, scopes = discover('http://core.invalid', saved, opener=transport)
        findings = capture_findings('http://core.invalid', saved, [self.current()], scopes, entries, opener=transport)
        for raw in (b'bad-json', b'{"ok":true,"ok":false}', b'{"data":NaN}', b'x' * (MAX_RESPONSE + 1)):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                capture('http://core.invalid', saved, findings, entries, opener=lambda *a, **kw: io.BytesIO(raw))
        def offline(*a, **kw): raise urllib.error.URLError('Synthetic private path')
        with self.assertRaisesRegex(ValueError, 'unavailable') as error:
            capture('http://core.invalid', saved, findings, entries, opener=offline)
        self.assertNotIn('private path', str(error.exception))

    def test_shared_entry_or_note_cannot_have_different_pins_across_selected_messages(self):
        for shared_entry in (True, False):
            entry, saved = self.prepare(); first_ref = references(saved)[0]
            second_ref = {**first_ref, 'messageId': '9' * 16}
            refs = [first_ref, second_ref]
            extra = {**entry, 'id': '9' * 24}
            entries = [entry] if shared_entry else [entry, extra]
            findings = [{'reference': ref, 'snapshot': {'reference': ref}} for ref in refs]
            def observed(_core, ref, _finding, _entries, **_kw):
                current = entry if shared_entry or ref == first_ref else extra
                row = {'entryId': current['id'], 'note': {'revision': 0,
                       'fingerprint': ('a' if ref == first_ref else 'b') * 64}}
                return {'snapshot': {'entries': [row]}, 'fingerprint': 'f' * 64,
                        'observationId': 'synthetic', 'observedAt': 'synthetic'}, 1
            with patch('native_history_downstream_scope.observe', side_effect=observed), self.assertRaisesRegex(ValueError, 'shared'):
                capture('http://core.invalid', refs, findings, entries)


if __name__ == '__main__':
    unittest.main()
