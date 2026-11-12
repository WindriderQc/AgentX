"""A saved owner disposition never silently substitutes for fresh Core state."""
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
from retention_dispositions import core_entries
from retention_plan import NATIVE_GAPS
from retention_reconcile import main, reconcile
import test_retention_dispositions as fixtures


class CurrentDecisionTests(unittest.TestCase):
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

    def opener(self, reads):
        replies = iter(reads)

        def open_(request, timeout):
            self.assertEqual(request.get_header("X-service-caller"), "secretary-retention-review")
            self.assertEqual(request.get_method(), "GET")
            entries = next(replies)
            payload = {"ok": True, "data": {"authority": "agentx.core", "entries": entries,
                       "total": len(entries), "nextOffset": None}}
            return io.BytesIO(json.dumps(payload).encode())
        return open_

    def test_unchanged_observation_stays_blocked_and_preserves_saved_bytes(self):
        entry, saved = self.prepare()
        original = deepcopy(saved)
        report = reconcile(self.archive, self.before, saved, "http://core.invalid", opener=self.opener([[entry], [entry]]))
        self.assertEqual(report["counts"], {"observed_match": 1})
        self.assertEqual(report["messages"][0]["savedContentSha256"], report["messages"][0]["observedContentSha256"])
        self.assertEqual(saved, original)
        self.assertFalse(report["executionAllowed"])
        self.assertEqual(report["nativeValidationGaps"], list(NATIVE_GAPS))
        self.assertEqual(report["cleanupStatus"], "blocked")

    def test_observation_date_alone_does_not_invalidate_the_same_decision(self):
        entry, saved = self.prepare()
        saved[0]["at"] = "2020-01-01T00:00:00Z"
        with patch.object(self.archive, "run", side_effect=AssertionError("No provider access")):
            report = reconcile(self.archive, self.before, saved, "http://core.invalid",
                               opener=self.opener([[entry], [entry]]))
        self.assertEqual(report["messages"][0]["status"], "observed_match")
        self.assertEqual(report["messages"][0]["changedFields"], [])

    def test_current_extra_message_never_widens_selected_saved_scope(self):
        entry, saved = self.prepare()
        self.lane("person")
        lanes = load(self.root / "value-lanes.json")
        lanes["messages"]["1234567890abcde1"] = {"lane": "bulk", "reason": "synthetic"}
        save(self.root / "value-lanes.json", lanes)
        saved = self.owned([entry])
        saved = [row for row in saved if row["messageId"] == self.mid]
        report = reconcile(self.archive, self.before, saved, "http://core.invalid",
                           opener=self.opener([[entry], [entry]]))
        self.assertEqual([row["messageId"] for row in report["messages"]], [self.mid])
        self.assertEqual(report["counts"], {"observed_match": 1})

    def test_decision_revision_source_and_souvenir_changes_are_not_current(self):
        entry, saved = self.prepare()
        changes = [{"reviewState": "candidate"}, {"revision": 2}, {"souvenirNoteId": "a" * 24},
                   {"source": {**entry["source"], "findingId": "b" * 64}},
                   {"decision": {"reason": "Synthetic corrected decision"}}]
        for change in changes:
            with self.subTest(change=change):
                current = {**entry, **change}
                report = reconcile(self.archive, self.before, saved, "http://core.invalid",
                                   opener=self.opener([[current], [current]]))
                self.assertEqual(report["messages"][0]["status"], "changed")

    def test_forgotten_or_missing_entry_and_new_related_open_action_are_changed(self):
        entry, saved = self.prepare()
        extra = {**entry, "id": "a" * 24, "kind": "action", "reviewState": "candidate"}
        for entries in ([], [entry, extra]):
            with self.subTest(entries=entries):
                report = reconcile(self.archive, self.before, saved, "http://core.invalid",
                                   opener=self.opener([entries, entries]))
                self.assertEqual(report["messages"][0]["status"], "changed")

    def test_changed_lane_is_absent_in_current_scope(self):
        entry, saved = self.prepare()
        save(self.root / "value-lanes.json", {"messages": {}})
        report = reconcile(self.archive, self.before, saved, "http://core.invalid", opener=self.opener([[entry], [entry]]))
        self.assertEqual(report["messages"][0]["status"], "absent")

    def test_native_change_between_reads_refuses_successful_observation(self):
        entry, saved = self.prepare()
        with self.assertRaisesRegex(ValueError, "changed during reconciliation"):
            reconcile(self.archive, self.before, saved, "http://core.invalid",
                      opener=self.opener([[entry], [{**entry, "revision": 2}]]))

    def test_archive_change_between_reads_refuses_successful_observation(self):
        entry, saved = self.prepare()
        open_ = self.opener([[entry], [entry]])
        calls = 0

        def changing(request, timeout):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.lane("bulk")
            return open_(request, timeout)

        with self.assertRaisesRegex(ValueError, "changed during reconciliation"):
            reconcile(self.archive, self.before, saved, "http://core.invalid", opener=changing)

    def test_consolidated_manifest_is_reused_and_changes_remain_visible(self):
        entry, saved = self.prepare()
        finding = entry["source"]["findingId"]
        entry["source"]["findingId"] = "c" * 64
        manifests = [{"entries": [{"source": {"findingId": "c" * 64}, "findingIds": [finding]}]}]
        saved = self.owned([entry], manifests)
        report = reconcile(self.archive, self.before, saved, "http://core.invalid", iter(manifests),
                           opener=self.opener([[entry], [entry]]))
        self.assertEqual(report["messages"][0]["status"], "observed_match")
        report = reconcile(self.archive, self.before, saved, "http://core.invalid", [],
                           opener=self.opener([[entry], [entry]]))
        self.assertEqual(report["messages"][0]["status"], "changed")

    def test_outage_never_writes_success_or_changes_existing_report(self):
        entry, saved = self.prepare()
        output = Path(self.temp.name) / "reconciliation.json"
        snapshot = Path(self.temp.name) / "dispositions.json"
        save(snapshot, saved)
        args = ["--root", str(self.root), "--before", self.before.isoformat(),
                "--dispositions", str(snapshot), "--output", str(output)]
        with patch("retention_reconcile.core_entries", side_effect=urllib.error.URLError("Synthetic offline")):
            with self.assertRaises(urllib.error.URLError):
                main(args)
        self.assertFalse(output.exists())
        self.assertEqual(load(snapshot), saved)
        save(output, {"old": "keep"})
        with self.assertRaises(SystemExit), patch("retention_reconcile.core_entries") as read:
            main(args)
        read.assert_not_called()
        self.assertEqual(load(output), {"old": "keep"})

    def test_cli_private_rows_stay_in_new_report_and_changed_exit_is_two(self):
        entry, saved = self.prepare()
        snapshot = Path(self.temp.name) / "snapshot.json"
        output = Path(self.temp.name) / "report.json"
        save(snapshot, saved)
        with patch("retention_reconcile.core_entries", return_value=[]), redirect_stdout(io.StringIO()) as printed:
            code = main(["--root", str(self.root), "--before", self.before.isoformat(),
                         "--dispositions", str(snapshot), "--output", str(output)])
        self.assertEqual(code, 2)
        self.assertNotIn(self.mid, printed.getvalue())
        self.assertNotIn("coreEntriesSha256", printed.getvalue())
        self.assertEqual(load(snapshot), saved)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_ambiguous_saved_scope_refuses_before_any_native_read(self):
        entry, saved = self.prepare()
        with patch("retention_reconcile.core_entries") as read:
            for invalid in ([*saved, *saved], {}, [{**saved[0], "schema": "old"}]):
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    reconcile(self.archive, self.before, invalid, "http://core.invalid")
            read.assert_not_called()


class NativePaginationTests(unittest.TestCase):
    def call(self, pages):
        replies = iter(pages)

        def open_(request, timeout):
            return io.BytesIO(json.dumps({"ok": True, "data": next(replies)}).encode())
        return core_entries("http://core.invalid", opener=open_)

    def page(self, entries=(), total=0, next_=None):
        return {"authority": "agentx.core", "entries": list(entries), "total": total, "nextOffset": next_}

    def entry(self, id_="a" * 24):
        return {"id": id_, "revision": 1, "reviewState": "retained", "source": {"system": "gmail"}}

    def test_complete_and_empty_observations(self):
        self.assertEqual(self.call([self.page()]), [])
        entry = self.entry()
        self.assertEqual(self.call([self.page([entry], 1)]), [entry])
        second = self.entry("b" * 24)
        self.assertEqual(self.call([self.page([entry], 2, 1), self.page([second], 2)]), [entry, second])

    def test_new_native_candidate_has_revision_zero(self):
        entry = {**self.entry(), "revision": 0, "reviewState": "candidate"}
        self.assertEqual(self.call([self.page([entry], 1)]), [entry])

    def test_partial_stuck_duplicate_or_changing_pagination_refuses(self):
        entry = self.entry()
        bad = [[self.page([], 1)], [self.page([entry], 2, 0)],
               [self.page([entry], 2, 1), self.page([entry], 2)],
               [self.page([entry], 2, 1), self.page([self.entry("b" * 24)], 3)],
               [self.page([entry], 1, 1)], [self.page([entry], 0)], [self.page([], 20001)]]
        for pages in bad:
            with self.subTest(pages=pages), self.assertRaises(ValueError):
                self.call(pages)

    def test_malformed_native_rows_never_become_empty_success(self):
        for entry in (True, {**self.entry(), "reviewState": "forgotten"},
                      {**self.entry(), "revision": True}, {**self.entry(), "revision": -1},
                      {**self.entry(), "source": {}},
                      {**self.entry(), "id": "invalid"}, {**self.entry(), "id": 123456789012345678901234}):
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                self.call([self.page([entry], 1)])
        for page in ({}, {**self.page(), "total": True}, {**self.page(), "authority": "other"},
                     {key: value for key, value in self.page().items() if key != "nextOffset"}):
            with self.subTest(page=page), self.assertRaises(ValueError):
                self.call([page])


if __name__ == "__main__":
    unittest.main()
