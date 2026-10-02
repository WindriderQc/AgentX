import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from janitor import client  # noqa: E402


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class HttpJsonTest(unittest.TestCase):
    def test_posts_json_and_parses_response(self):
        captured = {}

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return FakeResponse(b'{"data": {"scan_id": "scan-1"}}')

        with mock.patch.object(client.urllib.request, "urlopen", fake_urlopen):
            scan_id = client.enqueue_refresh(
                "http://data.test/api/v1/",
                "media",
                hash_mode="candidates",
                hash_max_files=10,
                hash_max_bytes=20,
            )
        request = captured["request"]
        self.assertEqual(scan_id, "scan-1")
        self.assertEqual(request.full_url, "http://data.test/api/v1/storage/agent-scans")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(
            json.loads(request.data),
            {"source": "media", "hash_mode": "candidates", "hash_max_files": 10, "hash_max_bytes": 20},
        )
        self.assertEqual(captured["timeout"], 120)

    def test_http_error_carries_bounded_message(self):
        error = urllib.error.HTTPError(
            "http://data.test", 503, "busy", {}, io.BytesIO(b'{"message": "scanner busy"}')
        )
        with mock.patch.object(client.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(client.JanitorError, "AgentX HTTP 503: scanner busy"):
                client.http_json("http://data.test/x")

    def test_network_failure_is_janitor_error(self):
        with mock.patch.object(
            client.urllib.request, "urlopen", side_effect=urllib.error.URLError("refused")
        ):
            with self.assertRaisesRegex(client.JanitorError, "AgentX request failed"):
                client.http_json("http://data.test/x")

    def test_missing_scan_id_fails(self):
        with mock.patch.object(client, "http_json", return_value={"data": {}}):
            with self.assertRaisesRegex(client.JanitorError, "scan id for datalake"):
                client.enqueue_refresh("http://d", "datalake", hash_mode="none", hash_max_files=1, hash_max_bytes=1)


class EnvelopeAndRoutesTest(unittest.TestCase):
    def test_unwrap_accepts_bare_and_enveloped_objects(self):
        self.assertEqual(client.unwrap({"data": {"a": 1}}), {"a": 1})
        self.assertEqual(client.unwrap({"a": 1}), {"a": 1})
        with self.assertRaises(client.JanitorError):
            client.unwrap([])
        with self.assertRaises(client.JanitorError):
            client.unwrap({"data": [1]})

    def test_collect_root_reads_only_get_routes(self):
        calls = []

        def fake_http(url, **kwargs):
            calls.append((url, kwargs))
            return {"data": {"url": url}}

        with mock.patch.object(client, "http_json", fake_http):
            result = client.collect_root("http://d/api/v1", "media")
        self.assertEqual(result["root"], "/mnt/media")
        self.assertTrue(all(not kwargs for _, kwargs in calls))
        self.assertEqual(
            [url.split("?")[0] for url, _ in calls],
            [
                "http://d/api/v1/storage/summary",
                "http://d/api/v1/storage/files/stats",
                "http://d/api/v1/storage/files/stats",
                "http://d/api/v1/storage/files/duplicates",
                "http://d/api/v1/storage/files/cleanup-recommendations",
            ],
        )
        self.assertIn("root=%2Fmnt%2Fmedia", calls[0][0])
        self.assertIn("category=unclassified", calls[2][0])

    def test_collect_strategy_requires_report(self):
        with mock.patch.object(client, "http_json", return_value={"data": {"report": {"status": "ok"}}}) as http:
            self.assertEqual(client.collect_strategy("http://d/api/v1"), {"status": "ok"})
        http.assert_called_once_with(
            "http://d/api/v1/janitor/profiles/shared-drive/strategy", method="POST", payload={}
        )
        with mock.patch.object(client, "http_json", return_value={"data": {}}):
            with self.assertRaisesRegex(client.JanitorError, "strategy report"):
                client.collect_strategy("http://d/api/v1")


class WaitForScanTest(unittest.TestCase):
    def test_polls_until_terminal(self):
        statuses = iter([{"status": "running"}, {"status": "complete", "files": 3}])
        with mock.patch.object(client, "api", side_effect=lambda *a, **k: next(statuses)), \
                mock.patch.object(client.time, "sleep") as sleep:
            result = client.wait_for_scan("http://d", "scan/1", deadline=float("inf"), poll_seconds=7)
        self.assertEqual(result["status"], "complete")
        sleep.assert_called_once_with(7)

    def test_deadline_raises(self):
        with mock.patch.object(client.time, "monotonic", return_value=100.0):
            with self.assertRaisesRegex(client.JanitorError, "exceeded its deadline"):
                client.wait_for_scan("http://d", "scan-1", deadline=50.0, poll_seconds=1)


if __name__ == "__main__":
    unittest.main()
