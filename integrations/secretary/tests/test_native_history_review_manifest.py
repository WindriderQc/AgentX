"""Native manifest consumers and v11 sequencing, synthetic CPU fixtures only."""
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
from datetime import datetime, timedelta, timezone
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
from native_history_global_decisions import expected_snapshot as decisions_snapshot
from native_history_global_downstream import expected_snapshot as downstream_snapshot
from native_history_message_scope import references
from native_history_review_manifest import capture, expected_snapshot, canonical_before, CONTRACT, CONSISTENCY, MAX_RESPONSE
from retention_plan import NATIVE_GAPS
from retention_reconcile import reconcile, main
import test_native_history_downstream_scope as downstream_fixtures
import test_native_history_mailbox_scope as mailbox_fixtures


class ReviewManifestTests(unittest.TestCase):
    def setUp(self):
        self.fx = downstream_fixtures.NativeDownstreamTests()
        self.fx.setUp(); self.addCleanup(self.fx.doCleanups)
        entry, self.saved = self.fx.prepare(); self.entries = [entry]
        self.source = references(self.saved)[0]
        local = self.fx.current()
        self.graph = {'contract': 'secretary.archive-review-packet/v1', 'evidenceHash': local['evidenceHash'],
            'reviewSha256': local['reviewSha256'], 'pagesSha256': '3' * 64, 'valueLanesSha256': '4' * 64,
            'filesSha256': '5' * 64, 'counts': {'files': 7, 'bytes': 1000, 'pages': 1, 'attachments': 0, 'compoundMembers': 0}}
        restored = {'contract': 'agentx.history-preservation/v3', 'reference': self.source,
            'scope': 'selected-original-attachments-mime-review-packet-and-temporary-disk-restore',
            'status': 'verified_scope', 'blockers': [], 'copies': [
                {'copy': name, 'status': 'available', 'machineIdSha256': machine * 64, 'archiveIdSha256': 'e' * 64,
                 'content': {'reviewPacket': deepcopy(self.graph)}, 'restoration': {'temporaryCopyRemoved': True,
                 'filesCopied': 7, 'bytesCopied': 1000, 'sourceFilesSha256': self.graph['filesSha256'],
                 'restoredFilesSha256': self.graph['filesSha256']}} for name, machine in (('primary', 'c'), ('mirror', 'd'))]}
        check = {'entryId': entry['id'], 'requestId': '00000000-0000-4000-8000-000000000001',
                 'snapshotHash': digest(restored), 'source': self.source}
        self.checks = [check]
        self.restoration = {'contract': 'agentx.history-restoration-scope/v2', 'sourceSetSha256': digest([self.source]),
            'pins': [{**check, 'entryRevision': entry['revision'], 'basisHash': '6' * 64, 'privacyHash': '7' * 64}],
            'members': [{**check, 'snapshot': restored}]}
        self.calls = []; self.manifest_calls = 0

    def envelope(self, body, snapshot, consistency=CONSISTENCY):
        return {'authority': 'agentx.core', 'contract': snapshot['contract'], 'observationId': body['observationId'],
            'observedAt': '2026-01-01T12:00:00.000Z', 'snapshot': snapshot, 'fingerprint': digest(snapshot),
            'status': 'observed_match' if 'expected' in body else 'observed', 'consistency': consistency,
            'atomicBatch': False, 'semanticAcceptance': False, 'authenticatedPerson': None,
            'executionAllowed': False, 'cleanupStatus': 'blocked', 'nativeValidationGaps': list(NATIVE_GAPS)}

    def components(self, mode='present', state='current_link'):
        body = {'source': self.source, 'observationId': 'synthetic'}
        finding = self.fx.response(self.entries, body)
        downstream = self.fx.downstream(self.entries, body, state)
        mailbox = mailbox_fixtures.NativeMailboxTests.mailbox(self.fx, self.entries, body, mode)
        finding['reference'] = downstream['reference'] = mailbox['reference'] = self.source
        ds = decisions_snapshot(self.saved, [finding]); linked = downstream_snapshot(self.saved, [downstream])
        return [{'snapshot': ds, 'fingerprint': digest(ds)}, {'snapshot': linked, 'fingerprint': digest(linked)},
                {'snapshot': deepcopy(self.restoration), 'fingerprint': digest(self.restoration)}, [mailbox]]

    def snapshot(self, mode='present', state='current_link'):
        return expected_snapshot(self.saved, self.checks, self.fx.before, *self.components(mode, state))

    def transport(self, mutate=None, after=None, mode='present', state='current_link'):
        legacy = self.fx.transport(self.entries, state=state)
        def open_(request, timeout):
            self.calls.append(request)
            body = json.loads(request.data); path = request.full_url
            if path.endswith('/review-manifest'):
                self.assertEqual(timeout, 960); self.manifest_calls += 1
                self.assertEqual(set(body), {'checks', 'before', 'observationId'} | ({'expected'} if self.manifest_calls == 2 else set()))
                self.assertEqual(body['before'], canonical_before(self.fx.before)); self.assertEqual(body['checks'], self.checks)
                data = self.envelope(body, self.snapshot(mode, state))
                data.update(reviewOnly=True, mailboxEffects=0, approvalBound=False)
                if mutate: mutate(data, self.manifest_calls)
                if self.manifest_calls == 2 and after: after()
            else:
                self.assertEqual(self.manifest_calls, 0, 'No HTTP may follow native manifest observations')
                if path.endswith('/decision-state/global'):
                    data = self.envelope(body, self.components(mode, state)[0]['snapshot'],
                        'two-complete-finding-passes-with-final-global-core-fence')
                    data['downstreamState'] = 'not_rechecked'
                elif path.endswith('/downstream/global'):
                    data = self.envelope(body, self.components(mode, state)[1]['snapshot'],
                        'two-complete-downstream-passes-with-final-joined-core-note-fence')
                    data['downstreamState'] = 'selected-linked-souvenirs-observed'
                elif path.endswith('/decision-state/mailbox'):
                    data = mailbox_fixtures.NativeMailboxTests.mailbox(self.fx, self.entries, body, mode)
                elif path.endswith('/preservation-scope'):
                    self.assertEqual(body['verification'], 'review-restoration')
                    data = self.envelope(body, deepcopy(self.restoration), 'retained-restoration-rechecks-with-final-core-fence')
                    data['coverage'] = 'complete-selected-review-packet-source-set'
                else:
                    return legacy(request, timeout)
            return io.BytesIO(json.dumps({'ok': True, 'data': data}).encode())
        return open_

    def observed(self, mutate=None, **kwargs):
        return capture('http://core.invalid', self.saved, self.checks, self.fx.before, *self.components(),
                       opener=self.transport(mutate, **kwargs))

    def reconciled(self, **options):
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.graph)):
            return reconcile(self.fx.archive, self.fx.before, self.saved, 'http://core.invalid',
                review_restoration_checks=self.checks, review_manifest=True, **options)

    def test_two_fresh_native_observations_exact_components_and_no_local_attestation_input(self):
        value = self.observed()
        self.assertEqual(self.manifest_calls, 2)
        self.assertNotEqual(value['observationId'], value['initialObservationId'])
        self.assertEqual(json.loads(self.calls[-1].data)['expected'], value['fingerprint'])
        self.assertEqual(value['snapshot'], self.snapshot())
        self.assertEqual(value['nativeValidationGaps'], list(NATIVE_GAPS))
        self.assertEqual(value['snapshot']['coverage']['blockers'], list(NATIVE_GAPS))
        self.assertEqual(value['snapshot']['coverage']['counts'], {'messages': 1, 'entries': 1, 'observedNotes': 1,
            'livePresent': 1, 'evidenceHeldMessages': 0, 'candidatesForOwnerReview': 0})
        self.assertEqual(set(value['snapshot']['restoration']), {'snapshot', 'fingerprint'})
        self.assertNotIn('cutoffBlockers', value['snapshot']['mailbox'][0])

    def test_missing_or_unsafe_envelope_fields_refuse(self):
        changes = {'authority': 'local', 'contract': 'old', 'observationId': 'old', 'status': 'changed',
            'consistency': 'atomic', 'reviewOnly': 1, 'atomicBatch': 0, 'semanticAcceptance': 0,
            'authenticatedPerson': 'owner', 'mailboxEffects': False, 'approvalBound': 0,
            'executionAllowed': 0, 'cleanupStatus': 'accepted', 'nativeValidationGaps': [],
            'observedAt': '2026-13-01T12:00:00.000Z', 'fingerprint': '0' * 64}
        for key, value in changes.items():
            self.manifest_calls = 0
            with self.subTest(key=key), self.assertRaises(ValueError): self.observed(lambda d, _: d.update({key: value}))
        for key in self.envelope({'observationId': 'synthetic'}, self.snapshot()) | {'reviewOnly': True, 'mailboxEffects': 0, 'approvalBound': False}:
            self.manifest_calls = 0
            with self.subTest(missing=key), self.assertRaises(ValueError): self.observed(lambda d, _: d.pop(key))
        self.manifest_calls = 0
        with self.assertRaises(ValueError): self.observed(lambda d, _: d.update(mailboxEffects=0.0))

    def test_recomputed_hash_cannot_hide_bool_float_missing_extra_or_changed_child_proofs(self):
        mutations = [lambda s: s['coverage']['counts'].update(entries=True),
            lambda s: s['coverage']['counts'].update(entries=1.0),
            lambda s: s['coverage']['messages'][0].update(candidateForOwnerReview=0),
            lambda s: s['coverage']['messages'][0].update(reviewStatus='accepted'),
            lambda s: s['decisions']['snapshot']['findings'].clear(),
            lambda s: s['downstream']['snapshot']['members'][0]['snapshot']['entries'][0]['note'].update(revision=1),
            lambda s: s['restoration']['snapshot']['members'].clear(),
            lambda s: s['mailbox'][0]['snapshot']['mailbox']['current'].update(historyId='123'),
            lambda s: s.update(sourceSetSha256='0' * 64), lambda s: s.update(checksSha256='0' * 64),
            lambda s: s.update(before='2026-01-01T00:00:00.000Z'), lambda s: s['sources'].clear(),
            lambda s: s['coverage'].update(blockers=[]), lambda s: s.update(privateText='Synthetic private text')]
        for mutation in mutations:
            self.manifest_calls = 0
            def change(data, _): mutation(data['snapshot']); data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): self.observed(change)

    def test_second_observation_change_refuses_without_third_call(self):
        def change(data, call):
            if call == 2: data['snapshot']['coverage']['counts']['messages'] = 0; data['fingerprint'] = digest(data['snapshot'])
        with self.assertRaises(ValueError): self.observed(change)
        self.assertEqual(self.manifest_calls, 2)

    def test_transport_failures_never_retry_or_reveal_private_detail(self):
        for raw in (b'bad-json', b'{"ok":true,"ok":false}', b'{"data":NaN}', b'x' * (MAX_RESPONSE + 1)):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                capture('http://core.invalid', self.saved, self.checks, self.fx.before, *self.components(),
                        opener=lambda *a, **kw: io.BytesIO(raw))
        calls = []
        def offline(*a, **kw): calls.append(a); raise urllib.error.URLError('Synthetic private detail')
        with self.assertRaises(ValueError) as error:
            capture('http://core.invalid', self.saved, self.checks, self.fx.before, *self.components(), opener=offline)
        self.assertEqual(len(calls), 1); self.assertNotIn('private detail', str(error.exception))

    def test_exact_cutoff_equality_is_held_and_missing_mail_is_not_a_cutoff_failure(self):
        recent = self.snapshot(mode='recent')
        self.assertEqual(recent['coverage']['messages'][0]['blockers'], ['live_message_outside_cutoff'])
        self.assertEqual(recent['coverage']['counts']['evidenceHeldMessages'], 1)
        self.assertEqual(recent['coverage']['blockers'], [*NATIVE_GAPS, 'selected_evidence_needs_review'])
        missing = self.snapshot(mode='not_found')
        self.assertEqual(missing['coverage']['messages'][0]['blockers'], ['live_message_not_found'])
        self.assertEqual(missing['coverage']['counts']['livePresent'], 0)

    def test_components_must_cross_bind_before_http(self):
        for kind in ('missing_findings', 'duplicate_mailbox', 'wrong_downstream', 'wrong_restore', 'wrong_core', 'stale_restore'):
            components = deepcopy(self.components())
            if kind == 'missing_findings': components[0]['snapshot']['findings'].clear()
            if kind == 'duplicate_mailbox': components[3] *= 2
            if kind == 'wrong_downstream': components[1]['snapshot']['members'][0]['snapshot']['findingScope']['fingerprint'] = '0' * 64
            if kind == 'wrong_restore': components[2]['snapshot']['members'][0]['source']['sourceSha256'] = '0' * 64
            if kind == 'wrong_core': components[3][0]['snapshot']['coreScope']['fingerprint'] = '0' * 64
            if kind == 'stale_restore': components[2]['snapshot']['contract'] = 'agentx.history-restoration-scope/v1'
            # A recomputed local component hash is still not a native proof.
            for row in [*components[:3], *components[3]]: row['fingerprint'] = digest(row['snapshot'])
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                capture('http://core.invalid', self.saved, self.checks, self.fx.before, *components,
                        opener=lambda *a, **kw: self.fail('Cross-binding must precede HTTP'))

    def multiple(self, changed_account=False):
        decisions, downstream, restoration, mailbox = deepcopy(self.components())
        saved = [*self.saved, {**self.saved[0], 'messageId': 'f' * 16}]
        refs = references(saved)
        finding = deepcopy(decisions['snapshot']['findings'][0]); source = refs[1]
        finding['reference'] = finding['snapshot']['reference'] = source
        finding['snapshot']['inventory']['reference'] = source
        finding['fingerprint'] = digest(finding['snapshot'])
        findings = [decisions['snapshot']['findings'][0], finding]
        member = deepcopy(downstream['snapshot']['members'][0])
        member['reference'] = member['snapshot']['reference'] = source
        member['snapshot']['findingScope'] = {key: finding[key] for key in ('fingerprint', 'snapshot')}
        member['fingerprint'] = digest(member['snapshot'])
        members = [downstream['snapshot']['members'][0], member]
        retained = deepcopy(restoration['snapshot']['members'][0]); retained['source'] = source
        retained['snapshot']['reference'] = source; retained['snapshotHash'] = digest(retained['snapshot'])
        check = {key: retained[key] for key in self.checks[0]}; checks = [*self.checks, check]
        restoration['snapshot']['sourceSetSha256'] = digest(refs)
        restoration['snapshot']['pins'].append({**restoration['snapshot']['pins'][0], **check})
        restoration['snapshot']['members'].append(retained)
        restoration['fingerprint'] = digest(restoration['snapshot'])
        live = deepcopy(mailbox[0]); live['reference'] = live['snapshot']['reference'] = source
        live['snapshot']['mailbox']['reference'] = source
        live['snapshot']['mailbox']['current']['messageId'] = source['messageId']
        if changed_account: live['snapshot']['mailbox']['accountSelectionSha256'] = '9' * 64
        live['fingerprint'] = digest(live['snapshot']); mailbox.append(live)
        ds = decisions_snapshot(saved, findings); linked = downstream_snapshot(saved, members)
        return saved, checks, [{'snapshot': ds, 'fingerprint': digest(ds)},
            {'snapshot': linked, 'fingerprint': digest(linked)}, restoration, mailbox]

    def test_multiple_sources_sort_checks_deduplicate_entries_notes_and_reject_account_drift(self):
        saved, checks, components = self.multiple()
        value = expected_snapshot(list(reversed(saved)), list(reversed(checks)), self.fx.before, *components)
        self.assertEqual(value['sources'], references(saved)); self.assertEqual(value['checksSha256'], digest(checks))
        self.assertEqual(value['coverage']['counts'], {'messages': 2, 'entries': 1, 'observedNotes': 1,
            'livePresent': 2, 'evidenceHeldMessages': 0, 'candidatesForOwnerReview': 0})
        saved, checks, components = self.multiple(changed_account=True)
        with self.assertRaisesRegex(ValueError, 'account selection'):
            expected_snapshot(saved, checks, self.fx.before, *components)

    def test_blockers_are_stably_deduplicated_and_snapshot_capacity_precedes_http(self):
        components = deepcopy(self.components())
        finding = components[0]['snapshot']['findings'][0]
        finding['snapshot']['coverage']['blockers'] = ['first', 'shared']
        finding['fingerprint'] = digest(finding['snapshot'])
        member = components[1]['snapshot']['members'][0]
        member['snapshot']['findingScope'] = {key: finding[key] for key in ('fingerprint', 'snapshot')}
        member['snapshot']['coverage']['blockers'] = ['shared', 'last']
        member['fingerprint'] = digest(member['snapshot'])
        for index, builder, rows in ((0, decisions_snapshot, [finding]), (1, downstream_snapshot, [member])):
            snapshot = builder(self.saved, rows); components[index] = {'snapshot': snapshot, 'fingerprint': digest(snapshot)}
        value = expected_snapshot(self.saved, self.checks, self.fx.before, *components)
        self.assertEqual(value['coverage']['messages'][0]['blockers'], ['first', 'shared', 'last'])
        self.assertEqual(value['coverage']['messages'][0]['reviewStatus'], 'held')
        with patch('native_history_review_manifest.MAX_SNAPSHOT', 100), self.assertRaisesRegex(ValueError, 'snapshot capacity'):
            capture('http://core.invalid', self.saved, self.checks, self.fx.before, *self.components(),
                    opener=lambda *a, **kw: self.fail('Capacity check must precede HTTP'))

    def test_v11_implies_all_scopes_keeps_last_two_http_calls_and_rebinds_local_graph(self):
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.graph)) as local:
            report = reconcile(self.fx.archive, self.fx.before, self.saved, 'http://core.invalid', review_manifest=True,
                review_restoration_checks=self.checks, opener=self.transport())
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v11')
        self.assertEqual(local.call_count, 2)  # Existing v9 binding, then binding after v11 HTTP.
        self.assertTrue(all(request.full_url.endswith('/review-manifest') for request in self.calls[-2:]))
        self.assertEqual(sum(request.full_url.endswith('/decision-state/discover') for request in self.calls), 3)
        for key in ('nativeGlobalDecisions', 'nativeGlobalDownstream', 'nativeReviewRestorationScope', 'nativeMailboxScopes'):
            self.assertIn(key, report)
        self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS)); self.assertFalse(report['executionAllowed'])

    def test_missing_checks_or_imprecise_cutoff_refuse_before_any_http(self):
        for before in (self.fx.before.replace(tzinfo=None), self.fx.before.replace(microsecond=1)):
            with self.subTest(before=before), self.assertRaises(ValueError):
                reconcile(self.fx.archive, before, self.saved, 'http://core.invalid', review_manifest=True,
                    review_restoration_checks=self.checks, opener=lambda *a, **kw: self.fail('No HTTP'))
        with self.assertRaisesRegex(ValueError, 'requires retained'):
            reconcile(self.fx.archive, self.fx.before, self.saved, 'http://core.invalid', review_manifest=True,
                      opener=lambda *a, **kw: self.fail('No HTTP'))
        shifted = self.fx.before.astimezone(timezone(timedelta(hours=-5)))
        self.assertEqual(canonical_before(shifted), canonical_before(self.fx.before))

    def test_local_disposition_or_graph_change_during_manifest_refuses(self):
        for kind in ('disposition', 'graph'):
            self.manifest_calls = 0
            action = (lambda: self.fx.lane('bulk')) if kind == 'disposition' else lambda: self.graph.update(filesSha256='9' * 64)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.reconciled(opener=self.transport(after=action))

    def test_cli_counts_only_immutable_private_report_and_exit_two_for_global_gaps(self):
        base = self.fx.root.parent
        saved_path, checks_path, output = base / 'saved.json', base / 'checks.json', base / 'manifest.json'
        save(saved_path, self.saved); save(checks_path, self.checks)
        inputs = [saved_path.read_bytes(), checks_path.read_bytes()]
        args = ['--root', str(self.fx.root), '--before', self.fx.before.isoformat(), '--dispositions', str(saved_path),
                '--output', str(output), '--native-review-manifest', '--native-review-restoration-checks', str(checks_path)]
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.graph)), \
                patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=self.transport())), \
                redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(main(args), 2)
        report, summary = load(output), json.loads(printed.getvalue())
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v11')
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(summary['nativeReviewManifest'], report['nativeReviewManifest']['snapshot']['coverage']['counts'])
        self.assertNotIn(self.source['messageId'], printed.getvalue()); self.assertNotIn('snapshot', printed.getvalue())
        self.assertEqual(inputs, [saved_path.read_bytes(), checks_path.read_bytes()])
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()): main(args)
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()): main(args[:-2])

    def test_changed_local_graph_writes_no_cli_report(self):
        base = self.fx.root.parent; saved, checks, output = base / 's.json', base / 'c.json', base / 'o.json'
        save(saved, self.saved); save(checks, self.checks)
        transport = self.transport(after=lambda: self.graph.update(filesSha256='9' * 64))
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.graph)), \
                patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=transport)), \
                redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
            main(['--root', str(self.fx.root), '--before', self.fx.before.isoformat(), '--dispositions', str(saved),
                  '--output', str(output), '--native-review-manifest', '--native-review-restoration-checks', str(checks)])
        self.assertFalse(output.exists())


if __name__ == '__main__': unittest.main()
