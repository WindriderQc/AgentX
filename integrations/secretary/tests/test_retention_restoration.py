from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_store import save, load
from native_history_decisions import digest
from native_history_message_scope import references
from native_history_restoration_scope import CONTRACT
from retention_reconcile import reconcile, main
from retention_plan import NATIVE_GAPS
import test_native_history_finding_scope as findings


class RetentionRestorationTests(unittest.TestCase):
    setUp = findings.NativeFindingScopeTests.setUp
    with_finding = findings.NativeFindingScopeTests.with_finding
    refresh_proofs = findings.NativeFindingScopeTests.refresh_proofs
    lane = findings.NativeFindingScopeTests.lane
    entry = findings.NativeFindingScopeTests.entry
    owned = findings.NativeFindingScopeTests.owned
    prepare = findings.NativeFindingScopeTests.prepare
    current = findings.NativeFindingScopeTests.current
    response = findings.NativeFindingScopeTests.response

    def receipts(self, entry, saved):
        source = references(saved)[0]
        self.proof = {"contract": "agentx.history-preservation/v2", "reference": source,
            "scope": "selected-original-recorded-attachments-mime-and-temporary-disk-restore",
            "status": "verified_scope", "blockers": [], "copies": [
                {"copy": copy, "status": "available", "machineIdSha256": machine * 64,
                 "archiveIdSha256": "e" * 64, "restoration": {"temporaryCopyRemoved": True}}
                for copy, machine in (("primary", "c"), ("mirror", "d"))]}
        return [{"entryId": entry["id"], "requestId": str(uuid.uuid4()), "snapshotHash": digest(self.proof), "source": source}]

    def transport(self, entry, checks, after_restore=None):
        native = findings.NativeFindingScopeTests.opener(self, [entry])
        self.restore_calls = 0
        def open_(request, timeout):
            if not request.full_url.endswith('/preservation-scope'):
                return native(request, timeout)
            self.restore_calls += 1
            body = json.loads(request.data)
            snapshot = {"contract": CONTRACT, "sourceSetSha256": digest([check["source"] for check in checks]),
                "members": [{**check, "snapshot": deepcopy(self.proof)} for check in checks],
                "pins": [{**check, "entryRevision": entry["revision"], "basisHash": "f" * 64, "privacyHash": "9" * 64} for check in checks]}
            value = {"authority": "agentx.core", "contract": CONTRACT, "observationId": body["observationId"],
                "observedAt": "2026-01-01T12:00:00.000Z", "snapshot": snapshot, "fingerprint": digest(snapshot),
                "status": "observed_match" if "expected" in body else "observed",
                "consistency": "retained-restoration-rechecks-with-final-core-fence", "coverage": "complete-selected-source-set",
                "atomicBatch": False, "semanticAcceptance": False, "authenticatedPerson": None,
                "executionAllowed": False, "cleanupStatus": "blocked", "nativeValidationGaps": list(NATIVE_GAPS)}
            if self.restore_calls == 2 and after_restore:
                after_restore()
            return io.BytesIO(json.dumps({"ok": True, "data": value}).encode())
        return open_

    def test_v5_composes_existing_finding_decision_and_restoration_contracts(self):
        entry, saved = self.prepare(); checks = self.receipts(entry, saved)
        report = reconcile(self.archive, self.before, saved, 'http://core.invalid',
                           restoration_checks=checks, opener=self.transport(entry, checks))
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v5')
        self.assertEqual(report['counts'], {'observed_match': 1})
        self.assertEqual(report['nativeRestorationScope']['status'], 'observed_match')
        self.assertEqual(report['nativeRestorationScope']['savedDispositionsSha256'], report['savedDispositionsSha256'])
        self.assertIn('nativeFindingScopes', report)
        self.assertEqual(report['nativeValidationGaps'], list(NATIVE_GAPS))
        self.assertFalse(report['executionAllowed']); self.assertEqual(report['cleanupStatus'], 'blocked')
        self.assertEqual(self.restore_calls, 2)
        # Two earlier membership passes and one final pass after all restores.
        self.assertEqual(sum(call.full_url.endswith('/decision-state/discover') for call in self.calls), 3)

    def test_missing_receipt_coverage_fails_before_any_external_request(self):
        _, saved = self.prepare()
        with self.assertRaises(ValueError), patch('retention_reconcile.core_entries') as legacy:
            reconcile(self.archive, self.before, saved, 'http://core.invalid', restoration_checks=[])
        legacy.assert_not_called()

    def test_core_and_archive_changes_during_restoration_cannot_publish_earlier_success(self):
        entry, saved = self.prepare(); checks = self.receipts(entry, saved)
        with self.assertRaises(ValueError):
            reconcile(self.archive, self.before, saved, 'http://core.invalid', restoration_checks=checks,
                opener=self.transport(entry, checks, lambda: entry.update(revision=entry['revision'] + 1)))
        entry, saved = self.prepare(); checks = self.receipts(entry, saved)
        with self.assertRaises(ValueError):
            reconcile(self.archive, self.before, saved, 'http://core.invalid', restoration_checks=checks,
                opener=self.transport(entry, checks, lambda: self.lane('bulk')))

    def test_cli_writes_only_new_private_report_and_prints_counts_without_source_pins(self):
        entry, saved = self.prepare(); checks = self.receipts(entry, saved)
        base = Path(self.temp.name)
        snapshot, receipts, output = base / 'saved.json', base / 'checks.json', base / 'report.json'
        save(snapshot, saved); save(receipts, checks)
        args = ['--root', str(self.root), '--before', self.before.isoformat(), '--dispositions', str(snapshot),
                '--native-restoration-checks', str(receipts), '--core', 'http://core.invalid', '--output', str(output)]
        transport = self.transport(entry, checks)
        with patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=transport)), redirect_stdout(io.StringIO()) as printed:
            code = main(args)
        self.assertEqual(code, 0)
        self.assertEqual(load(output)['schema'], 'agentx.secretary-retention-reconciliation/v5')
        summary = json.loads(printed.getvalue())
        self.assertEqual(summary['nativeRestoration'], {'status': 'observed_match', 'messages': 1})
        self.assertFalse(summary['executionAllowed'])
        self.assertNotIn(self.mid, printed.getvalue()); self.assertNotIn(checks[0]['requestId'], printed.getvalue())
        self.assertEqual(load(snapshot), saved); self.assertEqual(load(receipts), checks)
        with self.assertRaises(SystemExit):
            main(args)

    def test_failed_final_fence_leaves_no_report_and_keeps_saved_input(self):
        entry, saved = self.prepare(); checks = self.receipts(entry, saved)
        base = Path(self.temp.name)
        snapshot, receipts, output = base / 'saved.json', base / 'checks.json', base / 'report.json'
        save(snapshot, saved); save(receipts, checks)
        transport = self.transport(entry, checks, lambda: entry.update(revision=2))
        with patch('retention_reconcile.reconcile', side_effect=lambda *a, **kw: reconcile(*a, **kw, opener=transport)), \
                self.assertRaises(ValueError):
            main(['--root', str(self.root), '--before', self.before.isoformat(), '--dispositions', str(snapshot),
                  '--native-restoration-checks', str(receipts), '--output', str(output)])
        self.assertFalse(output.exists()); self.assertEqual(load(snapshot), saved)


if __name__ == '__main__':
    unittest.main()
