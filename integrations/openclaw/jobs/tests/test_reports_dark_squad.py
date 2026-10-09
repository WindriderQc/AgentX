import contextlib
import io
import os
import unittest
from unittest import mock

from reports_stubs import FakeOpener, RouteStub
from reports import openclaw_dark_squad_report as dark_squad


RESOURCES = {"disk_used_pct": 40.0, "disk_free_gib": 120.0, "memory_available_gib": 8.0}


def routes(**overrides):
    base = {
        "/api/agent-ops": {"status": "success", "data": {
            "work": {"counts": {"queued": 0, "in_progress": 1, "review": 2, "blocked": 0}},
            "sources": {"tasks": {"status": "ok"}, "openclaw": {"status": "ok"}},
            "automations": [
                {"confidence": "live", "enabled": True, "health": "ok"},
                {"confidence": "declared", "health": "error"},
            ],
        }},
        "/api/openclaw/status": {"status": "online", "gateway": {"reachable": True},
                                 "runtimeVersion": "1.2.3", "sessions": 4},
        "/api/budget/status": {"data": {
            "local_requests": 10, "local_tokens": 5000, "cloud_requests": 0, "usage_ratio": 0.4,
            "cloud_health": "green", "cloud_spend_observability": "attributed",
        }},
    }
    base.update(overrides)
    return base


def run(argv, route_map, env=None):
    stub = RouteStub(route_map)
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env or {}, clear=True), \
            mock.patch.object(dark_squad.urllib.request, "build_opener", lambda *_: FakeOpener(stub)), \
            mock.patch.object(dark_squad, "host_resources", lambda: dict(RESOURCES)), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = dark_squad.main(argv)
    return code, out.getvalue(), err.getvalue(), stub


class DarkSquadReportTests(unittest.TestCase):
    def test_healthy_report(self):
        code, out, _, stub = run(["--host-label", "core-a"], routes())
        self.assertEqual(code, 0)
        lines = out.strip().splitlines()
        self.assertEqual(lines[0], "Dark Squad — OK")
        self.assertIn("1/1 jobs OpenClaw observés sains; runtime 1.2.3, gateway joignable, 4 sessions.", lines[3])
        self.assertEqual(lines[4], "• Runtime — 2/2 sources Agent Ops saines.")
        self.assertEqual(lines[-1], "• Hôte core-a — disque 40% (120.0 Gio libres), mémoire disponible 8.0 Gio.")
        self.assertTrue(stub.requests[0].full_url.startswith("http://127.0.0.1:3180/"))

    def test_host_label_is_optional(self):
        _, out, _, _ = run([], routes())
        self.assertTrue(out.strip().splitlines()[-1].startswith("• Hôte — disque 40%"))

    def test_attention_on_blocked_work_and_unattributed_cloud(self):
        route_map = routes()
        route_map["/api/agent-ops"]["data"]["work"]["counts"]["blocked"] = 1
        route_map["/api/budget/status"]["data"].update(cloud_requests=3, cloud_spend_observability="none-recorded")
        code, out, _, _ = run([], route_map)
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("Dark Squad — ATTENTION"))
        self.assertIn("Action : arbitrer les blocages", out)
        self.assertIn("Action : vérifier le budget cloud", out)

    def test_invalid_schema_fails(self):
        route_map = routes()
        route_map["/api/openclaw/status"] = {"status": "maybe"}
        code, out, err, _ = run([], route_map)
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("Dark Squad — FAILED: OpenClaw returned an invalid runtime status", err)

    def test_http_error_fails(self):
        code, _, err, _ = run([], routes(**{"/api/agent-ops": 500}))
        self.assertEqual(code, 1)
        self.assertIn("HTTP 500", err)

    def test_env_configures_core_and_label(self):
        code, out, _, stub = run([], routes(), env={
            "AGENTX_CORE_URL": "http://core.example.test:4000",
            "AGENTX_REPORT_HOST_LABEL": "lab",
        })
        self.assertEqual(code, 0)
        self.assertEqual(stub.requests[0].full_url, "http://core.example.test:4000/api/agent-ops")
        self.assertIn("• Hôte lab — disque", out)

    def test_route_outside_origin_is_refused(self):
        with self.assertRaises(dark_squad.OpenClawReportError):
            dark_squad.get_json("http://core.example.test", "//other.example.test/api")


if __name__ == "__main__":
    unittest.main()
