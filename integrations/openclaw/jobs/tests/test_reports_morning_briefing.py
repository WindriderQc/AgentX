import contextlib
import io
import os
import unittest
from unittest import mock

from reports_stubs import RouteStub
from reports import openclaw_morning_briefing as briefing


def report(**overrides):
    data = {
        "alerts": {"critical": 0, "warning": 0, "active": 0},
        "analytics": {"messages": 7, "cost_usd": 0.0123},
        "performance": {"avg_latency_ms": 812.4},
        "memoryReview": {"pending": 0},
    }
    data.update(overrides)
    return {"status": "success", "data": data}


def run(argv, body, env=None):
    stub = RouteStub({"/api/reports/morning-brief": body})
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env or {}, clear=True), \
            mock.patch.object(briefing.urllib.request, "urlopen", stub), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = briefing.main(argv)
    return code, out.getvalue(), err.getvalue(), stub


class MorningBriefingTests(unittest.TestCase):
    def test_all_clear_briefing(self):
        code, out, _, stub = run([], report())
        self.assertEqual(code, 0)
        self.assertEqual(out.strip().splitlines(), [
            "GREEN All clear",
            "Analytics: 7 messages, $0.0123 cost",
            "Performance: avg latency 812ms",
            "Dreaming Review: nothing awaiting review.",
        ])
        self.assertEqual(stub.requests[0].full_url, "http://127.0.0.1:3180/api/reports/morning-brief")

    def test_exception_only_is_silent_without_attention(self):
        code, out, err, _ = run(["--exception-only"], report())
        self.assertEqual((code, out, err), (0, "", ""))

    def test_critical_alert_and_overdue_reconciliation(self):
        body = report(
            alerts={"critical": 1, "warning": 0, "active": 1, "recent": [{"title": "Disk almost full"}]},
            memoryReview={"pending": 2, "runId": "run-a", "activeRun": {
                "runId": "run-a", "reconciliation": {"overdue": True, "missingRuntimes": ["runtime-b"]},
            }},
        )
        code, out, _, _ = run(["--exception-only"], body)
        self.assertEqual(code, 0)
        lines = out.strip().splitlines()
        self.assertEqual(lines[0], "RED Critical alerts: 1 - Disk almost full")
        self.assertIn("Dreaming Review: 2 awaiting individual review in run-a. Open AgentX /memory-review.", lines)
        self.assertIn("Dreaming Review: run-a reconciliation is overdue waiting for runtime-b. "
                      "Open AgentX /memory-review.", lines)

    def test_invalid_evidence_fails_the_job(self):
        body = report(alerts={"critical": -1, "warning": 0, "active": 0})
        code, out, err, _ = run([], body)
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("invalid alerts.critical", err)

    def test_error_envelope_fails_the_job(self):
        code, _, err, _ = run([], {"status": "error"})
        self.assertEqual(code, 1)
        self.assertIn("invalid success envelope", err)

    def test_core_url_env_sets_report_url(self):
        _, _, _, stub = run([], report(), env={"AGENTX_CORE_URL": "https://core.example.test/"})
        self.assertEqual(stub.requests[0].full_url, "https://core.example.test/api/reports/morning-brief")


if __name__ == "__main__":
    unittest.main()
