"""Native recorded findings stay bound to archive and Core versions, never consent."""
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
from evidence_store import load, save
from history_coverage import coverage, content_hash
from native_history_decisions import capture as capture_decisions, digest
from native_history_message_scope import discover, references, CONTRACT as MESSAGE_CONTRACT
from native_history_finding_scope import CONTRACT, capture, observe
from retention_plan import NATIVE_GAPS
from retention_reconcile import main, reconcile
import test_native_history_message_scope as scope_fixtures


class NativeFindingScopeTests(unittest.TestCase):
    setUp = scope_fixtures.NativeMessageScopeTests.setUp
    with_finding = scope_fixtures.NativeMessageScopeTests.with_finding
    refresh_proofs = scope_fixtures.NativeMessageScopeTests.refresh_proofs
    lane = scope_fixtures.NativeMessageScopeTests.lane
    entry = scope_fixtures.NativeMessageScopeTests.entry
    owned = scope_fixtures.NativeMessageScopeTests.owned

    def prepare(self):
        entry, _ = scope_fixtures.NativeMessageScopeTests.prepare(self)
        entry['decision'] = {'reason': 'Synthetic retained decision', 'at': '2026-11-12T12:00:00Z'}
        return entry, self.owned([entry])

    def current(self):
        return next(row for row in coverage(self.archive, self.before)['messages'] if row['messageId'] == self.mid)

    def response(self, entries, body):
        reference = body['source']
        local = self.current()
        message = scope_fixtures.scope_reply(entries, body)
        pins = {pin['entryId']: pin for pin in message['snapshot']['entries']}
        native_findings = sorted([{'findingId': key, 'section': section} for section, ids in local['findingIds'].items() for key in ids], key=lambda row: row['findingId'])
        review = load(self.root / 'reviews' / (self.tid + '.json'))
        questions = [{'questionId': content_hash([self.tid, text])} for text in review['unresolved']]
        inventory = {'contract': 'secretary.archive-findings/v1', 'reference': reference,
            'evidenceHash': local['evidenceHash'], 'reviewSha256': local['reviewSha256'], 'metadataSha256': 'e' * 64,
            'raw': {'sha256': reference['sourceSha256'], 'bytes': 1000}, 'findings': native_findings,
            'threadQuestions': questions, 'scope': 'recorded-selected-message-findings-and-thread-questions',
            'semanticAcceptance': False, 'executionAllowed': False}
        findings = []
        for finding in native_findings:
            records = []
            for entry in message['entries']:
                if any(ref.get('findingId') == finding['findingId'] for ref in [entry['source'], *entry.get('relatedSources', [])]):
                    records.append({'entryId': entry['id'], 'revision': entry['revision'], 'kind': entry['kind'],
                        'state': entry['reviewState'], 'fingerprint': pins[entry['id']]['fingerprint'], 'blockers': []})
            findings.append({**finding, 'records': records, 'status': 'observed_decision' if records else 'no_core_reference'})
        counts = {'recordedFindings': len(findings), 'noCoreReference': sum(not row['records'] for row in findings),
                  'needsReview': 0, 'observedDecision': sum(bool(row['records']) for row in findings),
                  'threadQuestions': len(questions), 'unmatchedEntries': 0}
        blockers = []
        if not findings: blockers.append('empty_recorded_finding_set_not_semantic_acceptance')
        if counts['noCoreReference']: blockers.append('recorded_findings_need_review')
        if questions: blockers.append('thread_questions_unresolved')
        snapshot = {'contract': CONTRACT, 'reference': reference, 'inventory': inventory,
            'coreScope': {'contract': MESSAGE_CONTRACT, 'fingerprint': message['fingerprint'], 'members': message['snapshot']['entries']},
            'coverage': {'findings': findings, 'unmatchedEntries': [], 'counts': counts, 'blockers': blockers, 'meaning': 'Recorded observations only.'}}
        return {'authority': 'agentx.core', 'contract': CONTRACT, 'observationId': body['observationId'],
                'observedAt': '2026-11-12T12:00:00.000Z', 'snapshot': snapshot, 'fingerprint': digest(snapshot), 'status': 'observed',
                'atomicBatch': False, 'authenticatedPerson': None, 'semanticAcceptance': False, 'downstreamState': 'not_rechecked',
                'executionAllowed': False, 'cleanupStatus': 'blocked', 'nativeValidationGaps': list(NATIVE_GAPS)}

    def opener(self, entries, mutate=None):
        self.calls = []
        def open_(request, timeout):
            self.calls.append(request)
            self.assertEqual(request.get_method(), 'POST')
            self.assertEqual(request.get_header('X-service-caller'), 'secretary-retention-review')
            body = json.loads(request.data)
            if request.full_url.endswith('/decision-state/findings'):
                self.assertEqual(timeout, 60)
                data = self.response(entries, body)
                if mutate: mutate(data)
            elif request.full_url.endswith('/decision-state/discover'):
                data = scope_fixtures.scope_reply(entries, body)
            else:
                self.assertTrue(request.full_url.endswith('/decision-state/check'))
                entry = next(row for row in entries if row['id'] == body['entry']['id'])
                data = scope_fixtures.decision_reply(entry, body)
            return io.BytesIO(json.dumps({'ok': True, 'data': data}).encode())
        return open_

    def observe(self, entry, saved, mutate=None):
        transport = self.opener([entry], mutate)
        _, scopes = discover('http://core.invalid', saved, opener=transport)
        return observe('http://core.invalid', references(saved)[0], self.current(), scopes[0], [entry], opener=transport)

    def test_v4_binds_recorded_findings_without_promoting_observation_to_cleanup_acceptance(self):
        entry, saved = self.prepare()
        report = reconcile(self.archive, self.before, saved, 'http://core.invalid', finding_scope=True, opener=self.opener([entry]))
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v4')
        self.assertEqual(report['counts'], {'observed_match': 1})
        self.assertEqual(report['nativeFindingScopes'][0]['snapshot']['coverage']['counts']['observedDecision'], 1)
        self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS)); self.assertFalse(report['executionAllowed'])
        self.assertTrue(all(call.get_method() == 'POST' for call in self.calls))

    def test_local_undecided_finding_remains_native_unrepresented_even_if_export_comparison_matches(self):
        entry, _ = self.prepare(); self.with_finding('actions'); saved = self.owned([entry])
        report = reconcile(self.archive, self.before, saved, 'http://core.invalid', finding_scope=True, opener=self.opener([entry]))
        self.assertEqual(report['counts'], {'observed_match': 1})
        native = report['nativeFindingScopes'][0]['snapshot']['coverage']
        self.assertEqual(native['counts']['noCoreReference'], 1); self.assertIn('recorded_findings_need_review', native['blockers'])

    def test_native_source_flags_or_stale_observation_never_pass(self):
        entry, saved = self.prepare()
        for change in ({'authority': 'other'}, {'contract': 'old'}, {'observationId': 'old-reply'}, {'semanticAcceptance': True},
                       {'executionAllowed': True}, {'atomicBatch': True}, {'cleanupStatus': 'ready'}, {'nativeValidationGaps': []},
                       {'authenticatedPerson': 'owner'}, {'fingerprint': 'f' * 64}, {'observedAt': 'bad'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.observe(entry, saved, lambda data: data.update(change))

    def test_native_archive_or_core_scope_version_drift_refuses(self):
        entry, saved = self.prepare()
        for key in ('reviewSha256', 'evidenceHash'):
            def change(data, key=key):
                data['snapshot']['inventory'][key] = 'f' * 64; data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(key=key), self.assertRaises(ValueError): self.observe(entry, saved, change)
        def core_change(data):
            data['snapshot']['coreScope']['fingerprint'] = 'f' * 64; data['fingerprint'] = digest(data['snapshot'])
        with self.assertRaises(ValueError): self.observe(entry, saved, core_change)

    def test_native_inventory_or_coverage_cannot_omit_a_recorded_finding(self):
        entry, saved = self.prepare()
        for part in ('inventory', 'coverage'):
            def change(data, part=part):
                data['snapshot'][part]['findings'] = []; data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(part=part), self.assertRaises(ValueError): self.observe(entry, saved, change)

    def test_decision_records_and_counts_must_match_the_known_native_versions(self):
        entry, saved = self.prepare()
        changes = [('revision', 999), ('revision', True), ('state', 'resolved'), ('kind', 'action'), ('fingerprint', 'f' * 64)]
        for key, value in changes:
            def change(data, key=key, value=value):
                data['snapshot']['coverage']['findings'][0]['records'][0][key] = value; data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(key=key), self.assertRaises(ValueError): self.observe(entry, saved, change)
        def count_change(data):
            data['snapshot']['coverage']['counts']['recordedFindings'] = 0; data['fingerprint'] = digest(data['snapshot'])
        with self.assertRaises(ValueError): self.observe(entry, saved, count_change)

    def test_thread_question_membership_is_bound_to_the_current_archive_review(self):
        entry, saved = self.prepare()
        def change(data):
            data['snapshot']['inventory']['threadQuestions'] = [{'questionId': '1' * 64}]; data['fingerprint'] = digest(data['snapshot'])
        with self.assertRaises(ValueError): self.observe(entry, saved, change)

    def test_unavailable_or_oversized_or_ambiguous_reply_never_falls_back(self):
        entry, saved = self.prepare(); local = self.current(); reference = references(saved)[0]
        _, scopes = discover('http://core.invalid', saved, opener=self.opener([entry]))
        for raw in (b'x' * (512 * 1024 + 1), b'{"ok":true,"ok":true}', b'{"value":NaN}'):
            with self.subTest(raw=raw[:20]), self.assertRaises(ValueError):
                observe('http://core.invalid', reference, local, scopes[0], [entry], opener=lambda *_args, **_kwargs: io.BytesIO(raw))
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            observe('http://core.invalid', reference, local, scopes[0], [entry],
                    opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(urllib.error.URLError('Private upstream detail')))

    def test_cli_flag_implies_all_native_checks_and_keeps_held_counts_private(self):
        entry, _ = self.prepare(); self.with_finding('actions'); saved = self.owned([entry])
        snapshot = Path(self.temp.name) / 'saved.json'; output = Path(self.temp.name) / 'report.json'; save(snapshot, saved)
        before = snapshot.read_bytes(); transport = self.opener([entry])
        with patch('native_history_message_scope.discover', side_effect=lambda *args, **kwargs: discover(*args, **kwargs, opener=transport)), \
                patch('native_history_decisions.capture', side_effect=lambda *args, **kwargs: capture_decisions(*args, **kwargs, opener=transport)), \
                patch('native_history_finding_scope.capture', side_effect=lambda *args, **kwargs: capture(*args, **kwargs, opener=transport)), \
                patch('retention_reconcile.core_entries', side_effect=AssertionError('No legacy fallback')), redirect_stdout(io.StringIO()) as printed:
            code = main(['--root', str(self.root), '--before', self.before.isoformat(), '--dispositions', str(snapshot),
                         '--output', str(output), '--native-finding-scope'])
        self.assertEqual(code, 2); self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        summary = json.loads(printed.getvalue()); self.assertEqual(summary['nativeFindings'], {'messages': 1, 'heldMessages': 1, 'recordedFindings': 2})
        self.assertEqual(snapshot.read_bytes(), before); self.assertNotIn(entry['id'], printed.getvalue()); self.assertNotIn(self.mid, printed.getvalue())
        self.assertFalse(load(output)['executionAllowed'])

    def test_cli_native_inventory_failure_writes_no_report_and_preserves_saved_evidence(self):
        entry, saved = self.prepare()
        snapshot = Path(self.temp.name) / 'saved.json'; output = Path(self.temp.name) / 'report.json'; save(snapshot, saved)
        before = snapshot.read_bytes(); transport = self.opener([entry])
        with patch('native_history_message_scope.discover', side_effect=lambda *args, **kwargs: discover(*args, **kwargs, opener=transport)), \
                patch('native_history_decisions.capture', side_effect=lambda *args, **kwargs: capture_decisions(*args, **kwargs, opener=transport)), \
                patch('native_history_finding_scope.capture', side_effect=ValueError('Native inventory unavailable')), \
                patch('retention_reconcile.core_entries') as legacy, self.assertRaisesRegex(ValueError, 'Native inventory unavailable'):
            main(['--root', str(self.root), '--before', self.before.isoformat(), '--dispositions', str(snapshot),
                  '--output', str(output), '--native-finding-scope'])
        legacy.assert_not_called(); self.assertFalse(output.exists()); self.assertEqual(snapshot.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
