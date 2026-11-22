"""Recorded-decision v14 consumer; synthetic CPU fixtures, no live services."""
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
from native_history_decision_acceptance import capture, expected_snapshot, CONTRACT, CONSISTENCY, MAX_RESPONSE, DECISION_GAP
from native_history_global_decisions import expected_snapshot as decisions_snapshot
from native_history_global_downstream import expected_snapshot as downstream_snapshot
from native_history_review_manifest import expected_snapshot as manifest_snapshot
from retention_plan import NATIVE_GAPS
from retention_reconcile import reconcile, main
import test_native_history_manifest_confirmation as fixtures

REQUEST_ID = fixtures.REQUEST_ID


class DecisionAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.ManifestConfirmationTests(); self.fx.setUp(); self.addCleanup(self.fx.doCleanups)
        self.saved, self.checks, self.before = self.fx.saved, self.fx.checks, self.fx.before
        self.calls, self.parent_calls = [], 0

    def response(self, body):
        child_body = {'observationId': body['observationId']}
        if 'expectedCurrent' in body:
            child_body['expected'] = body['expectedCurrent']
        child = self.fx.response(child_body)
        snapshot = expected_snapshot(self.fx.manifest['snapshot'], child)
        data = self.fx.fx.envelope(body, snapshot, CONSISTENCY)
        data.update(currentObservation=child, reviewOnly=True, approvalBound=False, mailboxEffects=0,
            decisionReconciliationAccepted=snapshot['decisionReconciliationAccepted'],
            nativeValidationGaps=snapshot['remainingNativeValidationGaps'])
        return data

    def transport(self, mutate=None, after=None):
        legacy = self.fx.core.transport()
        def open_(request, timeout):
            self.calls.append(request)
            if not request.full_url.endswith('/decision-acceptance'):
                self.assertEqual(self.parent_calls, 0, 'No HTTP follows v14')
                self.assertFalse(request.full_url.endswith('/current'))
                return legacy(request, timeout)
            self.assertEqual(request.full_url,
                f'http://core.invalid/api/secretary/history/manifest-confirmations/{REQUEST_ID}/decision-acceptance')
            self.assertEqual(request.get_method(), 'POST'); self.assertEqual(timeout, 1200)
            self.assertEqual(request.get_header('X-service-caller'), 'secretary-retention-review')
            self.parent_calls += 1
            body = json.loads(request.data)
            self.assertEqual(set(body), {'checks', 'before', 'observationId'} |
                ({'expected', 'expectedCurrent'} if self.parent_calls == 2 else set()))
            self.assertEqual(body['checks'], self.checks)
            self.assertEqual(body['before'], self.fx.manifest['snapshot']['before'])
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
                decision_acceptance=REQUEST_ID, review_restoration_checks=self.checks, **options)

    def test_nested_confirmation_uses_only_two_parent_posts_and_discharges_exactly_one_gap(self):
        value = self.observed(); acceptance, child = value['acceptance'], value['confirmation']
        self.assertEqual(len(self.calls), 2); self.assertEqual(self.parent_calls, 2)
        self.assertNotEqual(acceptance['initialObservationId'], acceptance['observationId'])
        self.assertEqual(child['observationId'], acceptance['observationId'])
        self.assertEqual(child['initialObservationId'], acceptance['initialObservationId'])
        body = json.loads(self.calls[-1].data)
        self.assertEqual(body['expected'], acceptance['fingerprint'])
        self.assertEqual(body['expectedCurrent'], child['fingerprint'])
        self.assertEqual(child['status'], 'observed_match')
        snapshot = acceptance['snapshot']
        self.assertEqual(snapshot['contract'], CONTRACT)
        self.assertEqual(snapshot['counts'], {'messages': 1, 'acceptedMessages': 1, 'blockedMessages': 0,
            'recordedFindings': 1, 'records': 1, 'currentLinks': 1, 'notLinked': 0})
        self.assertEqual(snapshot['messages'], [{'referenceSha256': digest(self.checks[0]['source']),
            'recordedFindings': 1, 'observedDecisions': 1, 'records': 1, 'currentLinks': 1,
            'notLinked': 0, 'blockers': [], 'accepted': True}])
        self.assertEqual(acceptance['nativeValidationGaps'], [gap for gap in NATIVE_GAPS if gap != DECISION_GAP])
        self.assertEqual(child['nativeValidationGaps'], list(NATIVE_GAPS))
        self.assertFalse(acceptance['executionAllowed']); self.assertFalse(acceptance['approvalBound'])
        self.assertEqual(acceptance['cleanupStatus'], 'blocked')

    def test_strict_parent_fields_and_recomputed_policy_hash_cannot_forge_acceptance(self):
        mutations = {'authority': 'local', 'contract': 'old', 'observationId': 'old', 'observedAt': False,
            'fingerprint': '0' * 64, 'status': 'changed', 'consistency': 'atomic', 'reviewOnly': 1,
            'atomicBatch': 0, 'semanticAcceptance': 0, 'authenticatedPerson': 'owner', 'approvalBound': 0,
            'mailboxEffects': False, 'executionAllowed': 0, 'cleanupStatus': 'accepted',
            'decisionReconciliationAccepted': 1, 'nativeValidationGaps': [], 'private': 'Synthetic private detail'}
        for key, value in mutations.items():
            self.parent_calls = 0
            with self.subTest(key=key), self.assertRaises(ValueError): self.observed(lambda data, _: data.update({key: value}))
        for key in self.response({'observationId': 'synthetic'}):
            self.parent_calls = 0
            with self.subTest(missing=key), self.assertRaises(ValueError): self.observed(lambda data, _: data.pop(key))
        for mutation in (lambda s: s['messages'][0].update(records=True), lambda s: s['counts'].update(records=1.0),
                         lambda s: s['messages'].clear(), lambda s: s.update(acceptanceStatus='blocked_scope'),
                         lambda s: s['currentConfirmation'].update(fingerprint='0' * 64),
                         lambda s: s.update(remainingNativeValidationGaps=list(NATIVE_GAPS)),
                         lambda s: s.update(private='Synthetic private detail')):
            self.parent_calls = 0
            def change(data, _): mutation(data['snapshot']); data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): self.observed(change)

    def test_nested_v13_cannot_be_stale_forged_or_use_parent_expectation(self):
        variants = [lambda d: d.update(observationId='old'), lambda d: d.update(executionAllowed=True),
            lambda d: d.update(status='changed'), lambda d: d.update(observedAt='2026-13-01T12:00:00.000Z'),
            lambda d: d['snapshot'].update(confirmationStatus='changed'),
            lambda d: d['snapshot']['current'].update(manifestSha256='0' * 64),
            lambda d: d['snapshot']['confirmation'].update(confirmedAt='2026-01-01T13:00:00.000Z'),
            lambda d: d.update(nativeValidationGaps=[]), lambda d: d.update(fingerprint='0' * 64)]
        for variant in variants:
            self.parent_calls = 0
            def change(data, _):
                variant(data['currentObservation'])
                data['snapshot']['currentConfirmation'] = {key: data['currentObservation'][key] for key in ('fingerprint', 'snapshot')}
                data['fingerprint'] = digest(data['snapshot'])
            with self.subTest(variant=variant), self.assertRaises(ValueError): self.observed(change)
        self.parent_calls = 0
        def second(data, call):
            if call == 2:
                data['currentObservation']['status'] = 'observed'
        with self.assertRaises(ValueError): self.observed(second)
        self.assertEqual(self.parent_calls, 2)
        self.parent_calls = 0
        with self.assertRaises(ValueError):
            self.observed(lambda data, call: data.update(observedAt='2026-01-01T11:59:59.999Z') if call == 2 else None)

    def policy(self, mutation):
        manifest = deepcopy(self.fx.manifest['snapshot'])
        finding = manifest['decisions']['snapshot']['findings'][0]['snapshot']
        downstream = manifest['downstream']['snapshot']['members'][0]['snapshot']
        mutation(finding, downstream)
        return expected_snapshot(manifest, self.fx.response({'observationId': 'synthetic'}))

    def test_explicit_states_and_existing_blockers_define_only_recorded_scope_acceptance(self):
        for kind in ('action', 'deliverable', 'invoice', 'fact', 'other'):
            for state in ('retained', 'resolved', 'dismissed', 'proposed'):
                def mutate(f, d):
                    section = {'action': 'actions', 'fact': 'memories', 'deliverable': 'deliverables', 'invoice': 'invoices'}.get(kind, 'memories')
                    f['inventory']['findings'][0]['section'] = section
                    f['coverage']['findings'][0]['section'] = section
                    f['coverage']['findings'][0]['records'][0].update(kind=kind, state=state)
                snapshot = self.policy(mutate)
                accepted = state in ('resolved', 'dismissed') or kind == 'fact' and state == 'retained'
                accepted = accepted and kind != 'other'
                with self.subTest(kind=kind, state=state):
                    self.assertEqual(snapshot['decisionReconciliationAccepted'], accepted)
                    self.assertEqual(len(snapshot['remainingNativeValidationGaps']), 3 if accepted else 4)
                    self.assertEqual(snapshot['acceptanceStatus'], 'accepted_scope' if accepted else 'blocked_scope')
        def unresolved(f, d):
            f['inventory']['threadQuestions'] = [{'questionId': 'f' * 64}]
            f['coverage']['counts']['threadQuestions'] = 1
            f['coverage']['blockers'] = ['thread_questions_unresolved']
            d['coverage']['blockers'] = ['thread_questions_unresolved']
        self.assertIn('thread_questions_unresolved', self.policy(unresolved)['messages'][0]['blockers'])
        def missing(f, d):
            f['coverage']['findings'][0].update(records=[], status='no_core_reference')
            f['coverage']['counts'].update(noCoreReference=1, observedDecision=0)
            f['coverage']['blockers'] = ['recorded_findings_need_review']
        self.assertEqual(self.policy(missing)['messages'][0]['blockers'],
            ['recorded_decision_not_observed', 'recorded_finding_without_decision', 'recorded_findings_need_review'])
        def pending(f, d):
            f['coverage']['findings'][0]['records'][0]['blockers'] = ['pending_source_decision']
            f['coverage']['findings'][0]['status'] = 'needs_review'
            f['coverage']['counts'].update(needsReview=1, observedDecision=0)
            f['coverage']['blockers'] = ['recorded_findings_need_review']
        self.assertIn('recorded_decision_not_observed', self.policy(pending)['messages'][0]['blockers'])
        def empty(f, d):
            f['inventory']['findings'] = []; f['coverage']['findings'] = []
            f['coverage']['counts'].update(recordedFindings=0, observedDecision=0)
            f['coverage']['blockers'] = ['empty_recorded_finding_set_not_semantic_acceptance']
        self.assertFalse(self.policy(empty)['decisionReconciliationAccepted'])
        def unavailable(f, d):
            d['entries'][0].update(state='unavailable', note=None, blockers=['linked_souvenir_unavailable'])
            d['coverage']['counts'].update(currentLinks=0, unavailable=1)
            d['coverage']['blockers'] = ['linked_souvenirs_need_review']
        self.assertIn('linked_souvenirs_need_review', self.policy(unavailable)['messages'][0]['blockers'])
        def unlinked(f, d):
            d['entries'][0].update(state='not_linked', note=None)
            d['coverage']['counts'].update(currentLinks=0, notLinked=1)
        self.assertTrue(self.policy(unlinked)['decisionReconciliationAccepted'])

    def test_kind_section_mismatch_blocks_even_with_observed_status_and_no_native_blockers(self):
        def mismatch(finding, downstream):
            finding['coverage']['findings'][0]['records'][0].update(kind='invoice', state='resolved')
        result = self.policy(mismatch)
        self.assertEqual(result['messages'][0]['blockers'], ['recorded_decision_not_observed'])
        self.assertEqual(result['acceptanceStatus'], 'blocked_scope')
        self.assertFalse(result['decisionReconciliationAccepted'])
        self.assertEqual(result['remainingNativeValidationGaps'], list(NATIVE_GAPS))

    def test_current_human_receipt_cannot_accept_mailbox_or_cutoff_blockers(self):
        for code in ('live_message_outside_cutoff', 'live_source_changed', 'live_source_missing'):
            manifest = deepcopy(self.fx.manifest['snapshot'])
            manifest['coverage']['messages'][0].update(blockers=[code], reviewStatus='held')
            manifest['coverage']['counts']['evidenceHeldMessages'] = 1
            result = expected_snapshot(manifest, self.fx.response({'observationId': 'synthetic'}))
            with self.subTest(code=code):
                self.assertEqual(result['messages'][0]['blockers'], [code])
                self.assertFalse(result['decisionReconciliationAccepted'])
                self.assertEqual(result['remainingNativeValidationGaps'], list(NATIVE_GAPS))
        for mutate in (lambda m: m['coverage']['messages'].clear(),
                       lambda m: m['coverage']['messages'][0].update(reference={**m['sources'][0], 'messageId': '0' * 16}),
                       lambda m: m['coverage']['counts'].update(evidenceHeldMessages=1)):
            manifest = deepcopy(self.fx.manifest['snapshot']); mutate(manifest)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                expected_snapshot(manifest, self.fx.response({'observationId': 'synthetic'}))

    def test_bad_graph_structure_counts_and_member_versions_are_unavailable(self):
        variants = [lambda f, d: f['coverage']['counts'].update(observedDecision=True),
            lambda f, d: f['coverage']['counts'].update(observedDecision=0),
            lambda f, d: f['coverage']['findings'][0]['records'][0].update(revision=True),
            lambda f, d: f['coverage']['findings'][0]['records'][0].update(fingerprint='0' * 64),
            lambda f, d: f['coverage']['findings'][0].update(status='needs_review'),
            lambda f, d: f['coverage']['findings'][0].update(findingId='0' * 64),
            lambda f, d: d['entries'].clear(), lambda f, d: d['entries'][0].update(entryId='0' * 24),
            lambda f, d: d['coverage']['counts'].update(currentLinks=0),
            lambda f, d: d['entries'][0]['note'].update(revision=True)]
        for variant in variants:
            with self.subTest(variant=variant), self.assertRaises(ValueError): self.policy(variant)

    def test_inputs_and_complete_v11_v12_are_required_before_http(self):
        original = [REQUEST_ID, self.saved, self.checks, self.before, self.fx.manifest, self.fx.restored]
        for index, value in ((0, 'bad'), (0, None), (2, []), (2, None), (2, self.checks * 2),
                             (3, self.before.replace(tzinfo=None)), (3, self.before + timedelta(microseconds=1)),
                             (4, {'fingerprint': '0' * 64}), (5, {'fingerprint': '0' * 64})):
            args = deepcopy(original); args[index] = value
            with self.subTest(index=index), self.assertRaises(ValueError):
                capture('http://core.invalid', *args, opener=lambda *a, **kw: self.fail('No HTTP'))
        for options in ({'decision_acceptance': REQUEST_ID}, {'decision_acceptance': 'bad'},
                        {'decision_acceptance': REQUEST_ID, 'review_restoration_checks': []},
                        {'decision_acceptance': REQUEST_ID, 'manifest_confirmation': '00000000-0000-4000-8000-000000000098'}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                reconcile(self.fx.fx.fx.archive, self.before, self.saved, 'http://core.invalid',
                    opener=lambda *a, **kw: self.fail('No HTTP'), **options)

    def test_records_count_occurrences_across_findings_instead_of_unique_ids(self):
        def mutate(f, d):
            row = deepcopy(f['coverage']['findings'][0]); row['findingId'] = 'f' * 64
            f['inventory']['findings'].append({key: row[key] for key in ('findingId', 'section')})
            f['coverage']['findings'].append(row)
            f['coverage']['counts'].update(recordedFindings=2, observedDecision=2)
        result = self.policy(mutate)
        self.assertEqual(result['counts']['records'], 2)
        self.assertEqual(result['counts']['currentLinks'], 1)
        self.assertTrue(result['decisionReconciliationAccepted'])

    def test_multiple_sources_keep_exact_order_and_count_shared_records_per_message(self):
        self.saved, self.checks, children = self.fx.fx.multiple()
        self.fx.saved, self.fx.checks = self.saved, self.checks
        snapshot = manifest_snapshot(self.saved, self.checks, self.before, *children)
        self.fx.manifest = {'snapshot': snapshot, 'fingerprint': digest(snapshot)}
        self.fx.restored = self.fx.core.response({'observationId': 'synthetic'}, downstream=children[1])
        value = capture('http://core.invalid', REQUEST_ID, list(reversed(self.saved)), list(reversed(self.checks)),
            self.before, self.fx.manifest, self.fx.restored, opener=self.transport())
        counts = value['acceptance']['snapshot']['counts']
        self.assertEqual((counts['messages'], counts['acceptedMessages'], counts['records'], counts['currentLinks']), (2, 2, 2, 2))

    def test_unavailable_ambiguous_nonfinite_and_oversized_responses_never_retry(self):
        for error in (urllib.error.URLError('Synthetic private detail'), TimeoutError('Synthetic private detail'),
                      urllib.error.HTTPError('synthetic', 409, 'Synthetic private detail', {}, None),
                      urllib.error.HTTPError('synthetic', 503, 'Synthetic private detail', {}, None)):
            calls = []
            def lost(*a, **kw): calls.append(a); raise error
            with self.assertRaises(ValueError) as caught:
                capture('http://core.invalid', REQUEST_ID, self.saved, self.checks, self.before,
                    self.fx.manifest, self.fx.restored, opener=lost)
            self.assertEqual(len(calls), 1); self.assertNotIn('private detail', str(caught.exception))
        for raw in (b'bad-json', b'{"ok":true,"ok":false}', b'{"data":NaN}', b'x' * (MAX_RESPONSE + 1)):
            with self.subTest(raw=raw[:20]), self.assertRaises(ValueError):
                capture('http://core.invalid', REQUEST_ID, self.saved, self.checks, self.before,
                    self.fx.manifest, self.fx.restored, opener=lambda *a, **kw: io.BytesIO(raw))
        with patch('native_history_decision_acceptance.MAX_SNAPSHOT', 100), self.assertRaisesRegex(ValueError, 'snapshot capacity'):
            self.observed()
        self.parent_calls = 0
        def lost_second(data, call):
            if call == 2: raise TimeoutError('Synthetic private detail')
        with self.assertRaises(ValueError): self.observed(lost_second)
        self.assertEqual(self.parent_calls, 2)

    def test_v14_implies_v11_v12_skips_standalone_v13_and_keeps_final_local_fences(self):
        with patch('native_history_manifest_confirmation.capture', side_effect=AssertionError('No standalone v13')):
            report = self.reconciled(opener=self.transport(), manifest_confirmation=REQUEST_ID)
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v14')
        self.assertEqual((self.fx.fx.manifest_calls, self.fx.core.native_calls, self.parent_calls), (2, 2, 2))
        self.assertTrue(all(request.full_url.endswith('/decision-acceptance') for request in self.calls[-2:]))
        self.assertEqual(report['nativeValidationGaps'], [gap for gap in NATIVE_GAPS if gap != DECISION_GAP])
        self.assertFalse(report['executionAllowed']); self.assertEqual(report['cleanupStatus'], 'blocked')
        self.assertEqual(report['nativeManifestConfirmation']['observationId'], report['nativeDecisionAcceptance']['observationId'])
        for kind in ('disposition', 'graph'):
            self.setUp()
            def after():
                if kind == 'disposition': self.fx.fx.fx.lane('bulk')
                else: self.fx.fx.graph['filesSha256'] = '9' * 64
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.reconciled(opener=self.transport(after=after))
            self.assertEqual(self.parent_calls, 2)

    def test_current_but_blocked_manifest_returns_v14_report_with_all_four_gaps(self):
        snapshot = self.fx.fx.snapshot(mode='recent')
        self.fx.manifest = {'snapshot': snapshot, 'fingerprint': digest(snapshot)}
        original = self.fx.fx.transport
        with patch.object(self.fx.fx, 'transport', side_effect=lambda: original(mode='recent')):
            transport = self.transport()
        report = self.reconciled(opener=transport)
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v14')
        self.assertEqual(report['nativeManifestConfirmation']['snapshot']['confirmationStatus'], 'current')
        self.assertEqual(report['nativeDecisionAcceptance']['snapshot']['acceptanceStatus'], 'blocked_scope')
        self.assertEqual(report['nativeDecisionAcceptance']['snapshot']['messages'][0]['blockers'], ['live_message_outside_cutoff'])
        self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS))
        self.assertFalse(report['executionAllowed']); self.assertEqual(report['cleanupStatus'], 'blocked')
        self.assertEqual(self.parent_calls, 2)

    def test_cli_private_immutable_report_counts_only_and_exit_two(self):
        base = self.fx.fx.fx.root.parent
        saved, checks, output = base / 'saved.json', base / 'checks.json', base / 'accepted.json'
        save(saved, self.saved); save(checks, self.checks); original = saved.read_bytes()
        args = ['--root', str(self.fx.fx.fx.root), '--before', self.before.isoformat(), '--dispositions', str(saved),
            '--output', str(output), '--native-review-restoration-checks', str(checks),
            '--core', 'http://core.invalid', '--native-decision-acceptance', REQUEST_ID]
        with patch('native_history_review_restoration.inventory', side_effect=lambda *a: deepcopy(self.fx.fx.graph)), \
                patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=self.transport())), \
                redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(main(args), 2)
        report, summary = load(output), json.loads(printed.getvalue())
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v14')
        self.assertEqual(output.stat().st_mode & 0o777, 0o600); self.assertEqual(saved.read_bytes(), original)
        self.assertEqual(summary['nativeDecisionAcceptance']['acceptanceStatus'], 'accepted_scope')
        self.assertEqual(len(summary['nativeDecisionAcceptance']['remainingNativeValidationGaps']), 3)
        for private in ('Sha256', REQUEST_ID, self.saved[0]['messageId']): self.assertNotIn(private, printed.getvalue())
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()): main(args)
        for changed in (args[:-1] + ['bad'], args[:8] + ['--native-decision-acceptance', REQUEST_ID],
                        args + ['--native-manifest-confirmation', '00000000-0000-4000-8000-000000000098']):
            with patch('retention_reconcile.reconcile', side_effect=AssertionError('No reconciliation')), \
                    self.assertRaises(SystemExit), redirect_stderr(io.StringIO()): main(changed)


if __name__ == '__main__': unittest.main()
