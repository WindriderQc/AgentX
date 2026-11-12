"""Exact-message native discovery never falls back to a whole-history export."""
from copy import deepcopy
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_history_decisions import digest
from native_history_decisions import capture
from native_history_message_scope import CONTRACT, confirm, discover, observe, references
from evidence_store import save, load
from retention_plan import NATIVE_GAPS
from retention_reconcile import reconcile, main
import test_native_history_decisions as native_fixtures

decision_reply = native_fixtures.reply


def scope_reply(entries, body):
    ref = body["source"]
    members = []
    for entry in sorted(entries, key=lambda row: row["id"]):
        cited = [src for src in [entry["source"], *entry.get("relatedSources", [])]
                 if src.get("system") == "gmail" and src.get("messageId") == ref["messageId"]]
        if not cited:
            continue
        binding = "exact" if all(src.get("threadId") == ref["threadId"] and src.get("sourceSha256") == ref["sourceSha256"] for src in cited) else "conflict"
        members.append((entry, {"entryId": entry["id"], "entryRevision": entry["revision"],
            "fingerprint": decision_reply(entry, body)["fingerprint"], "sourceBinding": binding}))
    snapshot = {"contract": CONTRACT, "reference": ref, "entries": [pin for _, pin in members]}
    fingerprint = digest(snapshot)
    return {"authority": "agentx.core", "contract": CONTRACT, "observationId": body["observationId"],
            "observedAt": "2026-11-12T21:00:00.000Z", "snapshot": snapshot, "fingerprint": fingerprint,
            "entries": [entry for entry, _ in members],
            "status": "observed" if "expected" not in body else "observed_match" if body["expected"] == fingerprint else "changed",
            "consistency": "two-agreeing-bounded-membership-queries", "coverage": "selected-message-visible-core-entries",
            "atomicBatch": False, "downstreamState": "not_rechecked", "authenticatedPerson": None,
            "executionAllowed": False, "cleanupStatus": "blocked", "nativeValidationGaps": list(NATIVE_GAPS)}


class NativeMessageScopeTests(unittest.TestCase):
    setUp = native_fixtures.NativeDecisionTests.setUp
    with_finding = native_fixtures.NativeDecisionTests.with_finding
    refresh_proofs = native_fixtures.NativeDecisionTests.refresh_proofs
    lane = native_fixtures.NativeDecisionTests.lane
    entry = native_fixtures.NativeDecisionTests.entry
    owned = native_fixtures.NativeDecisionTests.owned

    def prepare(self):
        entry, saved = native_fixtures.NativeDecisionTests.prepare(self)
        entry["source"]["sourceSha256"] = saved[0]["sourceSha256"]
        return entry, self.owned([entry])

    def opener(self, entries, scope_change=None, state_change=None):
        self.calls = []
        phase = 0

        def open_(request, timeout):
            nonlocal phase
            self.calls.append(request)
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(request.get_header("X-service-caller"), "secretary-retention-review")
            self.assertEqual(timeout, 15)
            body = json.loads(request.data)
            current = entries(phase) if callable(entries) else entries
            if request.full_url.endswith("/decision-state/discover"):
                phase += 1
                data = scope_reply(current, body)
                if scope_change:
                    scope_change(data, phase)
            else:
                self.assertTrue(request.full_url.endswith("/decision-state/check"))
                entry = next(row for row in current if row["id"] == body["entry"]["id"])
                data = decision_reply(entry, body)
                if state_change:
                    state_change(data)
            return io.BytesIO(json.dumps({"ok": True, "data": data}).encode())
        return open_

    def test_v3_native_chain_finds_document_action_absent_from_the_saved_primary_gmail_export(self):
        entry, saved = self.prepare()
        hidden = {**entry, "id": "a" * 24, "kind": "action", "reviewState": "candidate",
                  "source": {"system": "document", "id": "synthetic-document", "sourceSha256": "c" * 64, "findingId": "d" * 64},
                  "relatedSources": [entry["source"]]}
        original = deepcopy(saved)
        with patch("retention_reconcile.core_entries", side_effect=AssertionError("No legacy or full history scan")):
            report = reconcile(self.archive, self.before, saved, "http://core.invalid", message_scope=True, opener=self.opener([entry, hidden]))
        self.assertEqual(report["schema"], "agentx.secretary-retention-reconciliation/v3")
        self.assertEqual(report["counts"], {"changed": 1})
        self.assertIn("undecidedEntries", report["messages"][0]["changedFields"])
        self.assertEqual({row["entryId"] for row in report["nativeDecisions"]["entries"]}, {entry["id"], hidden["id"]})
        self.assertEqual(report["nativeDecisions"]["discoveryContract"], CONTRACT)
        self.assertEqual(len(report["nativeDecisions"]["messageScopes"]), 1)
        self.assertFalse(report["executionAllowed"])
        self.assertEqual(report["nativeValidationGaps"], list(NATIVE_GAPS))
        self.assertEqual(saved, original)
        self.assertTrue(all('/history?' not in call.full_url for call in self.calls))

    def test_unchanged_scope_gets_new_observation_identity_and_an_exact_membership_fingerprint(self):
        entry, saved = self.prepare()
        open_ = self.opener([entry])
        first, scopes = discover("http://core.invalid", saved, opener=open_)
        second, checked = discover("http://core.invalid", saved, previous=scopes, opener=open_)
        self.assertEqual(first, second)
        self.assertEqual(scopes[0]["fingerprint"], checked[0]["fingerprint"])
        self.assertNotEqual(scopes[0]["observationId"], checked[0]["observationId"])

    def test_unrelated_message_does_not_widen_the_selected_scope(self):
        entry, saved = self.prepare()
        unrelated = {**entry, "id": "a" * 24, "source": {**entry["source"], "messageId": "9999999999999999"}}
        found, _ = discover("http://core.invalid", saved, opener=self.opener([entry, unrelated]))
        self.assertEqual(found, [entry])

    def test_new_membership_between_observations_refuses(self):
        entry, saved = self.prepare()
        extra = {**entry, "id": "a" * 24}
        with self.assertRaisesRegex(ValueError, "did not confirm"):
            reconcile(self.archive, self.before, saved, "http://core.invalid", message_scope=True,
                      opener=self.opener(lambda phase: [entry] if phase == 0 else [entry, extra]))

    def test_per_entry_state_must_still_match_the_scope_fingerprint(self):
        entry, saved = self.prepare()

        def changed(data):
            data["snapshot"]["sourceReviewsSha256"] = "f" * 64
            data["fingerprint"] = digest(data["snapshot"])
        with self.assertRaisesRegex(ValueError, "no longer match"):
            reconcile(self.archive, self.before, saved, "http://core.invalid", message_scope=True,
                      opener=self.opener([entry], state_change=changed))
        with self.assertRaises(ValueError):
            confirm([], [{"members": [{"entryId": entry["id"], "fingerprint": "a" * 64}]}])

    def test_conflicting_thread_or_hash_is_not_silently_dropped(self):
        entry, saved = self.prepare()
        for change in ({"threadId": "9999999999999999"}, {"sourceSha256": "9" * 64}):
            changed = {**entry, "source": {**entry["source"], **change}}
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "conflict"):
                discover("http://core.invalid", saved, opener=self.opener([changed]))

    def test_malformed_flags_nonce_hash_or_membership_never_become_native_success(self):
        entry, saved = self.prepare()
        reference = references(saved)[0]
        cases = [{"authority": "other"}, {"contract": "old"}, {"observationId": "old-reply"},
                 {"atomicBatch": True}, {"coverage": "entire-archive"}, {"executionAllowed": True},
                 {"nativeValidationGaps": []}, {"cleanupStatus": "ready"}, {"downstreamState": "accepted"},
                 {"authenticatedPerson": "owner"}, {"fingerprint": "f" * 64}, {"entries": []}, {"observedAt": "bad"}]
        for change in cases:
            with self.subTest(change=change), self.assertRaises(ValueError):
                observe("http://core.invalid", reference, opener=self.opener([entry], lambda data, _: data.update(change)))
        def bad_pin(data, _):
            data["snapshot"]["entries"][0]["entryRevision"] = True
            data["fingerprint"] = digest(data["snapshot"])
        with self.assertRaises(ValueError):
            observe("http://core.invalid", reference, opener=self.opener([entry], bad_pin))

    def test_empty_scope_is_not_decision_or_cleanup_acceptance(self):
        _, saved = self.prepare()
        # The selected saved scope has no accepted finding decision to recover.
        empty = self.owned([])
        report = reconcile(self.archive, self.before, empty, "http://core.invalid", message_scope=True, opener=self.opener([]))
        self.assertEqual(report["nativeDecisions"]["status"], "no_selected_entries")
        self.assertEqual(report["nativeDecisions"]["messageScopes"][0]["members"], [])
        self.assertFalse(report["executionAllowed"])
        with self.assertRaisesRegex(ValueError, "unavailable"):
            reconcile(self.archive, self.before, saved, "http://core.invalid", message_scope=True, opener=self.opener([]))

    def test_invalid_selected_scope_refuses_before_requests(self):
        _, saved = self.prepare()
        for invalid in ([], [*saved, *saved], [{**saved[0], "sourceSha256": ["a" * 64]}],
                        [{**saved[0], "messageId": "not-a-message"}], saved * 21):
            with self.subTest(invalid=invalid), patch("native_history_message_scope.observe") as read:
                with self.assertRaises(ValueError):
                    discover("http://core.invalid", invalid)
                read.assert_not_called()

    def test_http_or_contract_failure_has_no_legacy_fallback(self):
        _, saved = self.prepare()
        with patch("retention_reconcile.core_entries") as legacy, self.assertRaisesRegex(ValueError, "unavailable"):
            reconcile(self.archive, self.before, saved, "http://core.invalid", message_scope=True,
                opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(urllib.error.HTTPError('http://core.invalid',404,'old Core',{},None)))
        legacy.assert_not_called()

    def test_response_and_aggregate_byte_bounds_refuse(self):
        entry, saved = self.prepare()
        for raw in (b"x" * (4 * 1024 * 1024 + 1), b'{"ok":true,"ok":true}', b'{"value":NaN}'):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                observe("http://core.invalid", references(saved)[0], opener=lambda *_args, **_kwargs: io.BytesIO(raw))
        with patch("native_history_message_scope.MAX_TOTAL", 1), self.assertRaisesRegex(ValueError, "aggregate"):
            discover("http://core.invalid", saved, opener=self.opener([entry]))

    def test_union_capacity_and_changed_shared_entries_refuse(self):
        entry, saved = self.prepare()
        other = {**saved[0], "messageId": "9999999999999999"}
        first = [{**entry, "id": f'{i:024x}'} for i in range(51)]
        second = [{**entry, "id": f'{i:024x}'} for i in range(51, 102)]
        receipts = [{"reference": row, "fingerprint": "a" * 64, "members": [{"entryId": e["id"], "fingerprint": "b" * 64} for e in entries]}
                    for row, entries in zip(references([saved[0], other]), [first, second])]
        with patch("native_history_message_scope.observe", side_effect=[(first, receipts[0], 1), (second, receipts[1], 1)]), \
                self.assertRaisesRegex(ValueError, "100 historical"):
            discover("http://core.invalid", [saved[0], other])
        shared = {**entry, "revision": 2}
        for receipt in receipts:
            receipt["members"] = [{"entryId": entry["id"], "fingerprint": "a" * 64}]
        with patch("native_history_message_scope.observe", side_effect=[([entry], receipts[0], 1), ([shared], receipts[1], 1)]), \
                self.assertRaisesRegex(ValueError, "shared historical entry changed"):
            discover("http://core.invalid", [saved[0], other])

    def test_cli_flag_implies_native_checks_and_writes_only_a_new_private_v3_report(self):
        entry, saved = self.prepare()
        hidden = {**entry, "id": "a" * 24, "kind": "action", "reviewState": "candidate",
                  "source": {"system": "document", "id": "synthetic-document", "sourceSha256": "c" * 64, "findingId": "d" * 64},
                  "relatedSources": [entry["source"]]}
        snapshot = Path(self.temp.name) / 'saved.json'
        output = Path(self.temp.name) / 'native-report.json'
        save(snapshot, saved)
        old_bytes = snapshot.read_bytes()
        transport = self.opener([entry, hidden])
        with patch('native_history_message_scope.discover', side_effect=lambda *args, **kwargs: discover(*args, **kwargs, opener=transport)), \
                patch('native_history_decisions.capture', side_effect=lambda *args, **kwargs: capture(*args, **kwargs, opener=transport)), \
                patch('retention_reconcile.core_entries', side_effect=AssertionError('No legacy discovery')), \
                redirect_stdout(io.StringIO()) as printed:
            code = main(['--root', str(self.root), '--before', self.before.isoformat(), '--dispositions', str(snapshot),
                         '--output', str(output), '--native-message-scope'])
        self.assertEqual(code, 2)
        report = load(output)
        self.assertEqual(report['schema'], 'agentx.secretary-retention-reconciliation/v3')
        self.assertEqual(len(report['nativeDecisions']['entries']), 2)
        self.assertEqual(json.loads(printed.getvalue())['nativeDecisions']['selectedEntries'], 2)
        self.assertNotIn(entry['id'], printed.getvalue()); self.assertNotIn(self.mid, printed.getvalue())
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(snapshot.read_bytes(), old_bytes)

    def test_cli_native_failure_writes_no_success_report_and_keeps_existing_evidence(self):
        _, saved = self.prepare()
        snapshot = Path(self.temp.name) / 'saved.json'
        output = Path(self.temp.name) / 'native-report.json'
        save(snapshot, saved)
        old_bytes = snapshot.read_bytes()
        with patch('native_history_message_scope.discover', side_effect=ValueError('Native unavailable')), \
                patch('retention_reconcile.core_entries') as legacy, self.assertRaisesRegex(ValueError, 'Native unavailable'):
            main(['--root', str(self.root), '--before', self.before.isoformat(), '--dispositions', str(snapshot),
                  '--output', str(output), '--native-message-scope'])
        legacy.assert_not_called(); self.assertFalse(output.exists())
        self.assertEqual(snapshot.read_bytes(), old_bytes)


if __name__ == '__main__':
    unittest.main()
