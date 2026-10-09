import contextlib
import io
import json
import os
import unittest
from unittest import mock

from reports_stubs import RouteStub
from reports import agentx_planning_ops as ops


BUDGET = {"data": {"budget_health": "green", "usage_ratio": 0.5, "cloud_spend_observability": "none-recorded"}}


def run(argv, routes, env=None):
    stub = RouteStub(routes)
    env = {"AGENTX_MCP_TOKEN": "synthetic-mcp", "AGENTX_OPERATOR_TOKEN": "synthetic-op", **(env or {})}
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env, clear=True), \
            mock.patch.object(ops.urllib.request, "urlopen", stub), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = ops.main(argv)
    return code, out.getvalue(), err.getvalue(), stub


class PlanningOpsTests(unittest.TestCase):
    def test_reconcile_reports_totals_with_mcp_token(self):
        code, out, _, stub = run(["reconcile", "--dry-run"], {
            "/api/planning/automation/reconcile": {"data": {"totals": {"scanned": 4, "updated": 1, "skipped": 3}}},
        })
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "Planning reconcile OK: mode=dry-run, scanned=4, updated=1, skipped=3")
        request = stub.requests[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("X-agentx-mcp-token"), "synthetic-mcp")
        self.assertEqual(json.loads(request.data), {"dryRun": True, "force": False})

    def test_reconcile_failure_exits_nonzero(self):
        code, out, err, _ = run(["reconcile"], {
            "/api/planning/automation/reconcile": {"data": {"totals": {"failed": 2}}},
        })
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("2 metric refresh(es) failed", err)

    def test_daily_digest_uses_operator_token_and_budget(self):
        code, out, _, stub = run(["daily-digest"], {
            "/api/reports/daily-digest": {"data": {
                "analytics": {"messages": 12},
                "performance": {"error_rate": 0.1, "requests": 30, "avg_latency_ms": 420},
                "rag": {"documents": 9},
            }},
            "/api/budget/status": BUDGET,
        })
        self.assertEqual(code, 0)
        lines = out.strip().splitlines()
        self.assertEqual(lines[0], "RED Daily digest: 12 messages, 10.00% inference errors")
        self.assertIn("Performance: 30 requests, 420ms avg", lines)
        self.assertIn("Cloud cost: unobserved; $0 recorded is not proof of zero cloud use", lines)
        self.assertEqual(lines[-1], "RAG: 9 documents [ok]")
        self.assertTrue(all(r.get_header("X-agentx-operator-token") == "synthetic-op" for r in stub.requests))

    def test_weekly_review_renders_planning_and_qualified_leader(self):
        code, out, _, _ = run(["weekly-review"], {
            "/api/reports/weekly-review": {"data": {
                "benchmark": {"leaderboard": [{
                    "model": "model-a", "fullScopeEligible": True,
                    "evidenceStatus": "qualified", "generalistScore": 8.5,
                }]},
                "costs": {"week_total_usd": 0.25, "messages": 40},
                "profiler": {"hosts_healthy": 2, "total_hosts": 3},
                "planning": {
                    "pulse": {"active": 3, "blocked": 1},
                    "decisions": [{"title": "Choose a path", "status": "proposed"}],
                    "nextActions": [{"label": "Ship the first step"}],
                },
            }},
            "/api/budget/status": BUDGET,
        })
        self.assertEqual(code, 0)
        self.assertIn("Benchmark quality: qualified leader model-a, score 8.50", out)
        self.assertIn("Recorded costs: $0.2500 this week across 40 messages", out)
        self.assertIn("Profiler: 2/3 hosts healthy", out)
        self.assertIn("Planning: 3 active, 1 blocked, 0 at risk, 0 evidence added", out)
        self.assertIn("Decisions needed: Choose a path", out)
        self.assertIn("Next: Ship the first step", out)

    def test_unqualified_benchmark_is_not_a_quality_ranking(self):
        text = ops.format_benchmark_evidence({"total_tests": 5, "leaderboard": []})
        self.assertEqual(text, "Benchmark quality: no qualified winner in this report; 5 historical rows; "
                               "latency inventory is not a quality ranking")

    def test_base_url_comes_from_core_url_env(self):
        _, _, _, stub = run(["reconcile"], {
            "/api/planning/automation/reconcile": {"data": {"totals": {}}},
        }, env={"AGENTX_CORE_URL": "http://core.example.test:4000/"})
        self.assertEqual(stub.requests[0].full_url, "http://core.example.test:4000/api/planning/automation/reconcile")

    def test_missing_operator_token_fails_closed(self):
        with mock.patch.object(ops, "OPERATOR_TOKEN_FILES", ()):
            code, _, err, stub = run(["daily-digest"], {}, env={"AGENTX_OPERATOR_TOKEN": ""})
        self.assertEqual(code, 1)
        self.assertIn("AGENTX_OPERATOR_TOKEN is unavailable", err)
        self.assertEqual(stub.requests, [])

    def test_http_error_detail_is_bounded(self):
        code, _, err, _ = run(["daily-digest"], {"/api/reports/daily-digest": 503})
        self.assertEqual(code, 1)
        self.assertIn("AgentX HTTP 503", err)


if __name__ == "__main__":
    unittest.main()
