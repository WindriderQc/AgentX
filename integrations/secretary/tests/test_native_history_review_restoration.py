"""Strict current graph restore consumers; no live provider or archive."""
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_history_decisions import digest
from native_history_review_restoration import capture
from native_history_restoration_scope import REVIEW_CONTRACT
from retention_plan import NATIVE_GAPS
from evidence_store import save, load
from retention_reconcile import reconcile, main
import test_native_history_restoration_scope as fixtures
import test_native_history_finding_scope as finding_fixtures


class ReviewRestorationClientTests(unittest.TestCase):
    def setUp(self):
        fixtures.NativeRestorationScopeTests.setUp(self)
        self.graph = {'contract': 'secretary.archive-review-packet/v1', 'evidenceHash': '1' * 64,
            'reviewSha256': '2' * 64, 'pagesSha256': '3' * 64, 'valueLanesSha256': '4' * 64, 'filesSha256': '5' * 64,
            'counts': {'files': 7, 'bytes': 1000, 'pages': 1, 'attachments': 0, 'compoundMembers': 0}}
        self.findings = []
        for member, check, pin in zip(self.members, self.checks, self.pins):
            proof = member['snapshot']; proof['contract'] = 'agentx.history-preservation/v3'
            proof['scope'] = 'selected-original-attachments-mime-review-packet-and-temporary-disk-restore'
            for copy in proof['copies']:
                copy['content'] = {'reviewPacket': deepcopy(self.graph)}
                copy['restoration'].update(sourceFilesSha256=self.graph['filesSha256'], restoredFilesSha256=self.graph['filesSha256'],
                    filesCopied=7, bytesCopied=1000)
            for row in (member, check, pin): row['snapshotHash'] = digest(proof)
            snapshot = {'reference': check['source'], 'inventory': {key: self.graph[key] for key in ('evidenceHash', 'reviewSha256')}}
            self.findings.append({'reference': check['source'], 'snapshot': snapshot, 'fingerprint': digest(snapshot)})

    def opener(self, mutate=None):
        def open_(request, timeout):
            self.assertEqual(timeout, 960); self.calls.append(request)
            self.assertEqual(json.loads(request.data)['verification'], 'review-restoration')
            value = fixtures.NativeRestorationScopeTests.response(self, request)
            value['data']['contract'] = REVIEW_CONTRACT; value['data']['snapshot']['contract'] = REVIEW_CONTRACT
            value['data']['coverage'] = 'complete-selected-review-packet-source-set'
            value['data']['fingerprint'] = digest(value['data']['snapshot'])
            if mutate: mutate(value['data'])
            return io.BytesIO(json.dumps(value).encode())
        return open_

    def observed(self, mutate=None, local=None, findings=None):
        with patch('native_history_review_restoration.inventory', return_value=deepcopy(self.graph) if local is None else local):
            return capture('http://core.invalid', self.saved, self.checks, SimpleNamespace(root=Path('/synthetic')),
                           self.findings if findings is None else findings, opener=self.opener(mutate))

    def test_complete_native_graph_matches_current_local_bytes_and_recorded_findings(self):
        result = self.observed(); self.assertEqual(len(self.calls), 2)
        self.assertEqual(result['contract'], REVIEW_CONTRACT)
        self.assertNotEqual(result['observationId'], result['initialObservationId'])
        self.assertEqual(result['nativeValidationGaps'], list(NATIVE_GAPS)); self.assertFalse(result['executionAllowed'])

    def test_old_receipt_contract_or_malformed_graph_cannot_answer_new_mode(self):
        mutations = [lambda p: p.update(contract='agentx.history-preservation/v2'),
            lambda p: p['copies'][0]['content']['reviewPacket']['counts'].update(files=True),
            lambda p: p['copies'][0]['content']['reviewPacket']['counts'].update(files=7.0),
            lambda p: p['copies'][0]['content']['reviewPacket']['counts'].update(files=257),
            lambda p: p['copies'][0]['content']['reviewPacket'].update(filesSha256='9' * 64),
            lambda p: p['copies'][0]['content']['reviewPacket'].update(content='Synthetic private data'),
            lambda p: p['copies'][0].update(content=[])]
        for mutation in mutations:
            def change(value): mutation(value['snapshot']['members'][0]['snapshot'])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): self.observed(change)

    def test_matching_retained_hash_cannot_hide_bad_graph_counts(self):
        for wrong in (True, 7.0, 257):
            self.setUp()
            proof = self.members[0]['snapshot']; proof['copies'][0]['content']['reviewPacket']['counts']['files'] = wrong
            for row in (self.members[0], self.checks[0], self.pins[0]): row['snapshotHash'] = digest(proof)
            with self.subTest(wrong=wrong), self.assertRaises(ValueError): self.observed()

    def test_local_graph_or_native_finding_drift_refuses(self):
        for key in ('filesSha256', 'reviewSha256', 'pagesSha256', 'valueLanesSha256'):
            with self.subTest(key=key), self.assertRaises(ValueError): self.observed(local={**self.graph, key: '9' * 64})
        changed = deepcopy(self.findings); changed[0]['snapshot']['inventory']['reviewSha256'] = '9' * 64
        changed[0]['fingerprint'] = digest(changed[0]['snapshot'])
        with self.assertRaises(ValueError): self.observed(findings=changed)
        with self.assertRaises(ValueError): self.observed(findings=self.findings[:1])

    def test_local_graph_failure_has_no_private_path_or_provider_fallback(self):
        with patch('native_history_review_restoration.inventory', side_effect=OSError('Synthetic private host path')):
            with self.assertRaisesRegex(ValueError, 'local current review graph') as error:
                capture('http://core.invalid', self.saved, self.checks, SimpleNamespace(root=Path('/synthetic')), self.findings, opener=self.opener())
        self.assertNotIn('private host', str(error.exception))


class ReviewRestorationReconciliationTests(unittest.TestCase):
    setUp = finding_fixtures.NativeFindingScopeTests.setUp
    with_finding = finding_fixtures.NativeFindingScopeTests.with_finding
    refresh_proofs = finding_fixtures.NativeFindingScopeTests.refresh_proofs
    lane = finding_fixtures.NativeFindingScopeTests.lane
    entry = finding_fixtures.NativeFindingScopeTests.entry
    owned = finding_fixtures.NativeFindingScopeTests.owned
    current = finding_fixtures.NativeFindingScopeTests.current
    response = finding_fixtures.NativeFindingScopeTests.response
    prepare = finding_fixtures.NativeFindingScopeTests.prepare

    def test_v9_cli_preserves_inputs_modes_and_all_native_gaps(self):
        entry, saved = self.prepare(); source = {key: saved[0][key] for key in ('messageId', 'threadId', 'sourceSha256')}
        check = {'entryId': entry['id'], 'requestId': '00000000-0000-4000-8000-000000000001', 'snapshotHash': 'a' * 64,
                 'source': {'system': 'gmail', **source}}
        base = Path(self.temp.name); input_file, checks_file, out = base / 'saved.json', base / 'checks.json', base / 'out.json'
        save(input_file, saved); save(checks_file, [check])
        proof = {'status': 'observed_match', 'snapshot': {'members': [check]}}
        transport = finding_fixtures.NativeFindingScopeTests.opener(self, [entry])
        with patch('native_history_review_restoration.capture', return_value=proof) as restored, \
                patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=transport)), redirect_stdout(io.StringIO()) as printed:
            code = main(['--root', str(self.root), '--before', self.before.isoformat(), '--dispositions', str(input_file),
                '--output', str(out), '--core', 'http://core.invalid', '--native-review-restoration-checks', str(checks_file)])
        self.assertEqual(code, 0); report = load(out)
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v9')
        self.assertFalse(report['executionAllowed']); self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS))
        self.assertEqual(json.loads(printed.getvalue())['nativeReviewRestoration'], {'status': 'observed_match', 'messages': 1})
        self.assertNotIn(source['messageId'], printed.getvalue()); self.assertEqual(load(input_file), saved)
        restored.assert_called_once()
        with self.assertRaisesRegex(ValueError, 'one retained native restoration mode'):
            reconcile(self.archive, self.before, saved, 'http://core.invalid', restoration_checks=[check], review_restoration_checks=[check],
                      opener=lambda *a, **kw: self.fail('No call before selection'))

    def test_failed_graph_binding_writes_no_success_report(self):
        entry, saved = self.prepare(); source = {'system': 'gmail', **{key: saved[0][key] for key in ('messageId', 'threadId', 'sourceSha256')}}
        check = {'entryId': entry['id'], 'requestId': '00000000-0000-4000-8000-000000000001', 'snapshotHash': 'a' * 64, 'source': source}
        transport = finding_fixtures.NativeFindingScopeTests.opener(self, [entry])
        with patch('native_history_review_restoration.capture', side_effect=ValueError('Changed graph')), self.assertRaisesRegex(ValueError, 'Changed graph'):
            reconcile(self.archive, self.before, saved, 'http://core.invalid', review_restoration_checks=[check], opener=transport)


if __name__ == '__main__': unittest.main()
