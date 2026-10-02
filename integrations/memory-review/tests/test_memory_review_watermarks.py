import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from memory_review.collectors import CollectorResult, read_new_jsonl  # noqa: E402
from memory_review.watermarks import WatermarkStore  # noqa: E402


def _events(path: Path, store: WatermarkStore, result=None):
    result = result or CollectorResult(runtime="openclaw", host="test")
    events = list(read_new_jsonl(path, store, result, source_key=path.name))
    return events, result


def _write_lines(path: Path, lines, mode="w"):
    with path.open(mode, encoding="utf-8", newline="\n") as handle:
        for line in lines:
            handle.write(line + "\n")


class WatermarkLifecycleTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.state = self.root / "state"
        self.store = WatermarkStore("openclaw", self.state)
        self.session = self.root / "session-a.jsonl"

    def test_initial_scan_reads_everything(self):
        _write_lines(self.session, [json.dumps({"n": i}) for i in range(3)])
        events, result = _events(self.session, self.store)
        self.assertEqual([e["n"] for e in events], [0, 1, 2])
        self.assertIn(self.session.name, result.stagedWatermarks)

    def test_watermark_advances_only_after_commit(self):
        _write_lines(self.session, [json.dumps({"n": 1})])
        events, result = _events(self.session, self.store)
        self.assertEqual(len(events), 1)
        # simulate: server REJECTED the batch -> no commit -> same data again
        events2, _ = _events(self.session, WatermarkStore("openclaw", self.state))
        self.assertEqual(len(events2), 1)
        # now the server accepted -> commit -> nothing new on rerun
        self.store.commit(result.stagedWatermarks)
        events3, _ = _events(self.session, WatermarkStore("openclaw", self.state))
        self.assertEqual(events3, [])

    def test_incremental_append_reads_only_new(self):
        _write_lines(self.session, [json.dumps({"n": 1})])
        _, result = _events(self.session, self.store)
        self.store.commit(result.stagedWatermarks)
        _write_lines(self.session, [json.dumps({"n": 2})], mode="a")
        store2 = WatermarkStore("openclaw", self.state)
        events, result2 = _events(self.session, store2)
        self.assertEqual([e["n"] for e in events], [2])
        store2.commit(result2.stagedWatermarks)
        events3, _ = _events(self.session, WatermarkStore("openclaw", self.state))
        self.assertEqual(events3, [])

    def test_unchanged_file_with_unread_tail_resumes_after_event_cap(self):
        _write_lines(self.session, [json.dumps({"n": i}) for i in range(10)])
        first_result = CollectorResult(runtime="openclaw", host="test")
        first = list(read_new_jsonl(
            self.session, self.store, first_result,
            source_key=self.session.name, max_events=3,
        ))
        self.assertEqual([event["n"] for event in first], [0, 1, 2])
        self.store.commit(first_result.stagedWatermarks)

        second_store = WatermarkStore("openclaw", self.state)
        second_result = CollectorResult(runtime="openclaw", host="test")
        second = list(read_new_jsonl(
            self.session, second_store, second_result,
            source_key=self.session.name, max_events=3,
        ))
        self.assertEqual([event["n"] for event in second], [3, 4, 5])

    def test_idempotent_rerun_same_window(self):
        _write_lines(self.session, [json.dumps({"n": 1}), json.dumps({"n": 2})])
        events_a, _ = _events(self.session, self.store)
        events_b, _ = _events(self.session, WatermarkStore("openclaw", self.state))
        self.assertEqual(events_a, events_b)

    def test_rotation_by_head_signature_restarts(self):
        _write_lines(self.session, [json.dumps({"n": "old-content-line"})])
        _, result = _events(self.session, self.store)
        self.store.commit(result.stagedWatermarks)
        # rotate: same name, completely different content of same-or-longer size
        _write_lines(self.session, [json.dumps({"n": "totally-new-first-line"}),
                                    json.dumps({"n": "second"})])
        events, _ = _events(self.session, WatermarkStore("openclaw", self.state))
        self.assertEqual(len(events), 2)

    def test_shrunk_file_restarts_from_zero(self):
        _write_lines(self.session, [json.dumps({"n": i}) for i in range(5)])
        _, result = _events(self.session, self.store)
        self.store.commit(result.stagedWatermarks)
        _write_lines(self.session, [json.dumps({"n": "reset"})])  # shrink
        events, _ = _events(self.session, WatermarkStore("openclaw", self.state))
        self.assertEqual(len(events), 1)

    def test_malformed_lines_counted_and_skipped(self):
        _write_lines(self.session, [json.dumps({"n": 1}), "{not json", json.dumps({"n": 2})])
        events, result = _events(self.session, self.store)
        self.assertEqual([e["n"] for e in events], [1, 2])
        self.assertEqual(result.rejectionCounts["malformed"], 1)

    def test_partial_trailing_line_deferred(self):
        _write_lines(self.session, [json.dumps({"n": 1})])
        with self.session.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write('{"n": 2')  # no newline: still being written
        events, result = _events(self.session, self.store)
        self.assertEqual([e["n"] for e in events], [1])
        self.store.commit(result.stagedWatermarks)
        # the partial line completes later
        with self.session.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write('}\n')
        events2, _ = _events(self.session, WatermarkStore("openclaw", self.state))
        self.assertEqual([e["n"] for e in events2], [{"n": 2}["n"]])

    def test_empty_source_stages_nothing_new(self):
        self.session.write_text("", encoding="utf-8")
        events, result = _events(self.session, self.store)
        self.assertEqual(events, [])
        self.assertIn(self.session.name, result.stagedWatermarks)

    def test_missing_file_records_error(self):
        result = CollectorResult(runtime="openclaw", host="test")
        events = list(read_new_jsonl(self.root / "nope.jsonl", self.store, result))
        self.assertEqual(events, [])
        self.assertTrue(result.errors)

    def test_large_file_byte_budget(self):
        _write_lines(self.session, [json.dumps({"n": i, "pad": "x" * 100}) for i in range(50)])
        result = CollectorResult(runtime="openclaw", host="test")
        events = list(read_new_jsonl(self.session, self.store, result,
                                     source_key=self.session.name, max_bytes=500))
        self.assertLess(len(events), 50)
        staged = result.stagedWatermarks[self.session.name]
        self.assertLess(staged["offset"], self.session.stat().st_size)

    def test_single_giant_line_is_discarded_in_bounded_resumable_chunks(self):
        _write_lines(self.session, [
            json.dumps({"n": 1, "pad": "x" * 1000}),
            json.dumps({"n": 2}),
        ])
        seen = []
        for _ in range(20):
            store = WatermarkStore("openclaw", self.state)
            result = CollectorResult(runtime="openclaw", host="test")
            seen.extend(read_new_jsonl(
                self.session, store, result,
                source_key=self.session.name, max_bytes=100,
            ))
            store.commit(result.stagedWatermarks)
            if any(event.get("n") == 2 for event in seen):
                break
        self.assertEqual([event["n"] for event in seen], [2])

    def test_manual_reset(self):
        _write_lines(self.session, [json.dumps({"n": 1})])
        _, result = _events(self.session, self.store)
        self.store.commit(result.stagedWatermarks)
        self.assertEqual(self.store.reset(self.session.name), 1)
        events, _ = _events(self.session, WatermarkStore("openclaw", self.state))
        self.assertEqual(len(events), 1)

    def test_corrupt_store_treated_as_first_run(self):
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "watermarks-openclaw.json").write_text("{broken", encoding="utf-8")
        store = WatermarkStore("openclaw", self.state)
        self.assertEqual(store.entries, {})

    def test_token_is_opaque_and_stable(self):
        token_a = self.store.token()
        self.assertNotIn("{", token_a)
        _write_lines(self.session, [json.dumps({"n": 1})])
        _, result = _events(self.session, self.store)
        self.store.commit(result.stagedWatermarks)
        self.assertNotEqual(self.store.token(), token_a)
        # no message content in the store file
        raw = (self.state / "watermarks-openclaw.json").read_text(encoding="utf-8")
        self.assertNotIn('"n"', raw)


if __name__ == "__main__":
    unittest.main()
