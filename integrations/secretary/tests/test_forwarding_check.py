import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SECRETARY_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SECRETARY_DIR))
SPEC = importlib.util.spec_from_file_location("forwarding_check", SECRETARY_DIR / "forwarding_check.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
evidence = sys.modules["secretary_evidence"]

HOUR = 3_600_000
NOW = 1_800_000_000_000


class ForwardingCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def archive_with(self, messages):
        payload = {"thread": {"messages": [
            {"id": f"message{n:02}", "threadId": "thread01", "internalDate": str(stamp), "body": "x",
             "headers": headers, "payload": {"parts": []}} for n, (stamp, headers) in enumerate(messages)]}}
        archive = evidence.Archive(self.root, lambda _: payload)
        archive.collect_thread("thread01")
        return archive

    def test_forwarded_mail_is_found_by_address_and_marker(self):
        archive = self.archive_with([
            (NOW - 2 * HOUR, {"to": "Owner <owner@example.invalid>"}),
            (NOW - 30 * HOUR, {"to": "other@forward.invalid", "x-forwarded-encrypted": "1"}),
            (NOW - 5 * HOUR, {"to": "other@forward.invalid, owner@example.invalid"}),  # sent to both, no marker
        ])
        newest, forwarded = module.latest_dates(archive, "Other@Forward.invalid", "X-Forwarded-Encrypted")
        self.assertEqual((newest, forwarded), (NOW - 2 * HOUR, NOW - 30 * HOUR))

    def test_recent_forwarded_mail_raises_nothing(self):
        finding = module.assess(NOW - HOUR, NOW - 10 * HOUR, quiet_hours=72, stale_hours=24, now_ms=NOW)
        self.assertIsNone(finding["metric"])

    def test_quiet_forwarding_with_a_fresh_archive_is_reported(self):
        finding = module.assess(NOW - HOUR, NOW - 100 * HOUR, quiet_hours=72, stale_hours=24, now_ms=NOW)
        self.assertEqual((finding["metric"], finding["value"]), ("mail_forwarding_quiet", 100.0))

    def test_a_stale_archive_is_blamed_on_the_sync_not_the_forwarding(self):
        finding = module.assess(NOW - 48 * HOUR, NOW - 100 * HOUR, quiet_hours=72, stale_hours=24, now_ms=NOW)
        self.assertEqual(finding["metric"], "mail_archive_stale")
        self.assertEqual(module.assess(0, 0, 72, 24, now_ms=NOW)["metric"], "mail_archive_stale")

    def test_never_forwarded_counts_as_quiet(self):
        self.assertEqual(module.assess(NOW - HOUR, 0, 72, 24, now_ms=NOW)["metric"], "mail_forwarding_quiet")

    def test_the_event_names_the_metric_and_never_the_address(self):
        sent = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"data": {"matched": true}}'

        def urlopen(request, timeout):
            sent.update(url=request.full_url, body=json.loads(request.data))
            return Response()
        finding = module.assess(NOW - HOUR, NOW - 100 * HOUR, 72, 24, now_ms=NOW)
        with mock.patch.object(module.urllib.request, "urlopen", urlopen):
            self.assertEqual(module.post("http://core.invalid:3180/", finding, "Forwarded mailbox"), {"matched": True})
        self.assertEqual(sent["url"], "http://core.invalid:3180/api/alerts/evaluate")
        self.assertEqual(sent["body"]["data"]["metric"], "mail_forwarding_quiet")
        self.assertNotIn("@", json.dumps(sent["body"]))


if __name__ == "__main__":
    unittest.main()
