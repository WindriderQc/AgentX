"""Synthetic native decision contracts; no provider, model or instance access."""
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
from native_history_decisions import CONTRACT, capture, digest, observe, selected
from retention_plan import NATIVE_GAPS
from retention_reconcile import main, reconcile
import test_retention_dispositions as fixtures


def reply(entry, body, **changes):
    snapshot = {"contract": CONTRACT, "entryId": entry["id"], "entryRevision": entry["revision"],
                "entrySha256": "a" * 64, "reviewState": entry["reviewState"], "kind": entry.get("kind"),
                "source": entry["source"], "relatedSources": entry.get("relatedSources", []),
                "decisionSha256": "b" * 64, "confirmationSha256": "c" * 64,
                "reviewHistorySha256": "d" * 64, "sourceReviewsSha256": "e" * 64,
                "pendingSourceDecisions": 0, "contextRevision": entry.get("contextRevision", 0),
                "contextHash": entry.get("contextHash"), "souvenirNoteId": entry.get("souvenirNoteId"),
                "downstreamState": "not_rechecked"}
    snapshot.update(changes)
    return {"authority": "agentx.core", "contract": CONTRACT, "snapshot": snapshot, "fingerprint": digest(snapshot),
            "observationId": body["observationId"], "observedAt": "2026-11-12T12:00:00.000Z", "entryMatches": True,
            "status": "observed_match" if "expected" in body else "observed",
            "consistency": "single-entry-committed-document", "scope": "selected-entry-only",
            "authenticatedPerson": None, "cleanupStatus": "blocked", "executionAllowed": False,
            "nativeValidationGaps": list(NATIVE_GAPS)}


class NativeDecisionTests(unittest.TestCase):
    setUp = fixtures.OwnerDispositionTests.setUp
    with_finding = fixtures.OwnerDispositionTests.with_finding
    refresh_proofs = fixtures.OwnerDispositionTests.refresh_proofs
    lane = fixtures.OwnerDispositionTests.lane
    entry = fixtures.OwnerDispositionTests.entry
    owned = fixtures.OwnerDispositionTests.owned

    def prepare(self):
        finding = self.with_finding()
        self.lane("person")
        entry = self.entry(finding, "retained", kind="fact")
        entry["source"]["system"] = "gmail"
        return entry, self.owned([entry])

    def opener(self, entries, mutate=None):
        self.calls = []

        def open_(request, timeout):
            self.calls.append(request)
            self.assertEqual(request.get_header("X-service-caller"), "secretary-retention-review")
            if request.get_method() == "GET":
                data = {"authority": "agentx.core", "entries": entries, "total": len(entries), "nextOffset": None}
            else:
                self.assertEqual(request.get_method(), "POST")
                self.assertTrue(request.full_url.endswith("/decision-state/check"))
                self.assertEqual(timeout, 15)
                body = json.loads(request.data)
                self.assertNotIn("souvenir", body["entry"])
                entry = next(row for row in entries if row["id"] == body["entry"]["id"])
                data = reply(entry, body)
                if mutate:
                    mutate(data, body)
            return io.BytesIO(json.dumps({"ok": True, "data": data}).encode())
        return open_

    def test_native_mode_observes_exact_saved_scope_and_stays_blocked_without_mutating_inputs(self):
        entry, saved = self.prepare()
        before = deepcopy(saved)
        open_ = self.opener([entry])
        report = reconcile(self.archive, self.before, saved, "http://core.invalid", opener=open_, native_decisions=True)
        self.assertEqual(report["schema"], "agentx.secretary-retention-reconciliation/v2")
        self.assertEqual(report["counts"], {"observed_match": 1})
        self.assertEqual(report["nativeDecisions"]["status"], "observed_match")
        self.assertEqual(report["nativeDecisions"]["entries"][0]["entryId"], entry["id"])
        self.assertEqual(report["nativeDecisions"]["pendingEntries"], 0)
        self.assertEqual(report["nativeValidationGaps"], list(NATIVE_GAPS))
        self.assertFalse(report["executionAllowed"])
        self.assertEqual(saved, before)
        self.assertEqual([request.get_method() for request in self.calls], ["GET", "POST", "GET", "POST"])
        first, second = [json.loads(request.data) for request in self.calls if request.data]
        self.assertNotEqual(first["observationId"], second["observationId"])
        self.assertRegex(second["expected"], r"^[a-f0-9]{64}$")

    def test_native_selection_includes_new_primary_and_related_assertions_but_not_other_messages(self):
        entry, saved = self.prepare()
        related = {**entry, "id": "a" * 24, "kind": "action", "reviewState": "candidate",
                   "source": {**entry["source"], "messageId": "9999999999999999", "findingId": "f" * 64},
                   "relatedSources": [entry["source"]]}
        unrelated = {**entry, "id": "b" * 24, "source": {**entry["source"], "messageId": "9999999999999999", "findingId": "d" * 64}}
        self.assertEqual(selected([entry, related, unrelated], [], saved), [related["id"], entry["id"]])

    def test_missing_saved_decision_and_empty_selection_are_not_native_acceptance(self):
        entry, saved = self.prepare()
        with self.assertRaisesRegex(ValueError, "unavailable"):
            capture("http://core.invalid", [], [], saved, opener=self.opener([]))
        empty = self.owned([])
        report = reconcile(self.archive, self.before, empty, "http://core.invalid", opener=self.opener([]), native_decisions=True)
        self.assertEqual(report["nativeDecisions"]["status"], "no_selected_entries")
        self.assertEqual(report["nativeDecisions"]["entries"], [])
        self.assertFalse(report["executionAllowed"])

    def test_changed_native_state_without_changed_entry_revision_refuses(self):
        entry, saved = self.prepare()

        def mutate(data, body):
            if "expected" in body:
                data["snapshot"]["sourceReviewsSha256"] = "f" * 64
                data["fingerprint"] = digest(data["snapshot"])
                # Even a server incorrectly claiming match cannot bypass hash comparison.
        with self.assertRaisesRegex(ValueError, "changed or failed"):
            reconcile(self.archive, self.before, saved, "http://core.invalid", opener=self.opener([entry], mutate), native_decisions=True)

    def test_bad_native_shape_flags_projection_or_nonce_never_pass(self):
        entry, _ = self.prepare()
        cases = [{"authority": "other"}, {"contract": "legacy"}, {"entryMatches": False},
                 {"status": "changed"}, {"executionAllowed": True}, {"cleanupStatus": "ready"},
                 {"nativeValidationGaps": []}, {"scope": "whole-archive"}, {"consistency": "atomic-global"},
                 {"authenticatedPerson": "owner"}, {"observationId": "stale-response"}, {"fingerprint": "f" * 64},
                 {"observedAt": "old"}, {"observedAt": "2026-99-12T12:00:00.000Z"}]
        for change in cases:
            with self.subTest(change=change), self.assertRaises(ValueError):
                observe("http://core.invalid", entry, opener=self.opener([entry], lambda data, _: data.update(change)))
        for change in [{"entryId": "b" * 24}, {"entryRevision": True}, {"entryRevision": 2},
                       {"source": {}}, {"kind": "action"}, {"reviewState": "dismissed"},
                       {"pendingSourceDecisions": True}, {"pendingSourceDecisions": 21},
                       {"contextRevision": True}, {"downstreamState": "accepted"},
                       {"decisionSha256": ["a" * 64]}, {"unexpected": True}]:
            def mutate(data, _, change=change):
                data["snapshot"].update(change)
                data["fingerprint"] = digest(data["snapshot"])
            with self.subTest(change=change), self.assertRaises(ValueError):
                observe("http://core.invalid", entry, opener=self.opener([entry], mutate))

    def test_pending_intent_is_not_accepted_and_cli_exit_is_two(self):
        entry, saved = self.prepare()
        snapshot = Path(self.temp.name) / "saved.json"
        output = Path(self.temp.name) / "native.json"
        save(snapshot, saved)

        def mutate(data, _):
            data["snapshot"]["pendingSourceDecisions"] = 1
            data["fingerprint"] = digest(data["snapshot"])

        with patch("urllib.request.urlopen", self.opener([entry], mutate)), \
                patch("retention_reconcile.core_entries", return_value=[entry]), \
                patch("native_history_decisions.capture", wraps=capture) as reads:
            # capture's default opener is bound at definition time; explicitly
            # inject the synthetic transport through the reconciliation call.
            reads.side_effect = lambda *args, **kwargs: capture(*args, **kwargs, opener=self.opener([entry], mutate))
            with redirect_stdout(io.StringIO()) as printed:
                code = main(["--root", str(self.root), "--before", self.before.isoformat(), "--dispositions", str(snapshot),
                             "--output", str(output), "--native-decisions"])
        self.assertEqual(code, 2)
        report = load(output)
        self.assertEqual(report["nativeDecisions"]["pendingEntries"], 1)
        self.assertEqual(json.loads(printed.getvalue())["nativeDecisions"]["pendingEntries"], 1)
        self.assertNotIn(entry["id"], printed.getvalue())
        self.assertNotIn(self.mid, printed.getvalue())
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(load(snapshot), saved)

    def test_outage_and_unsupported_endpoint_refuse_instead_of_falling_back(self):
        entry, _ = self.prepare()
        for error in (urllib.error.URLError("Synthetic outage"),
                      urllib.error.HTTPError("http://core.invalid", 404, "Unsupported", {}, None)):
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, "unavailable"):
                observe("http://core.invalid", entry, opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(error))

    def test_native_outage_never_writes_a_success_report_or_changes_saved_dispositions(self):
        entry, saved = self.prepare()
        snapshot = Path(self.temp.name) / "saved.json"
        output = Path(self.temp.name) / "native.json"
        save(snapshot, saved)
        with patch("retention_reconcile.core_entries", return_value=[entry]), \
                patch("native_history_decisions.capture", side_effect=ValueError("Native unavailable")), \
                self.assertRaisesRegex(ValueError, "Native unavailable"):
            main(["--root", str(self.root), "--before", self.before.isoformat(), "--dispositions", str(snapshot),
                  "--output", str(output), "--native-decisions"])
        self.assertFalse(output.exists())
        self.assertEqual(load(snapshot), saved)

    def test_oversized_or_ambiguous_response_and_oversized_request_refuse(self):
        entry, _ = self.prepare()
        for raw in (b"x" * (64 * 1024 + 1), b'{"ok":true,"ok":true}', b'{"value":NaN}'):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                observe("http://core.invalid", entry, opener=lambda *_args, **_kwargs: io.BytesIO(raw))
        with self.assertRaisesRegex(ValueError, "bounded capacity"):
            observe("http://core.invalid", {**entry, "text": "x" * (256 * 1024)}, opener=self.opener([entry]))
        self.assertEqual(self.calls, [])

    def test_capacity_and_ambiguous_scope_refuse_before_any_native_read(self):
        entry, saved = self.prepare()
        entries = [{**entry, "id": f"{i:024x}"} for i in range(101)]
        with self.assertRaisesRegex(ValueError, "100 exact"):
            capture("http://core.invalid", entries, [], saved, opener=self.opener(entries))
        self.assertEqual(self.calls, [])
        previous = [{"entryId": "a" * 24, "fingerprint": "a" * 64}]
        with self.assertRaisesRegex(ValueError, "selection changed"):
            capture("http://core.invalid", [entry], [], saved, previous=previous, opener=self.opener([entry]))


if __name__ == "__main__":
    unittest.main()
