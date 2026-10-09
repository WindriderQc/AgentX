import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

JOBS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(JOBS))

from janitor import client  # noqa: E402

SCRIPT = JOBS / "janitor" / "openclaw_shared_drive_janitor.py"
SPEC = importlib.util.spec_from_file_location("openclaw_shared_drive_janitor", SCRIPT)
CLI = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(CLI)

BASE = "http://data.test/api/v1"


class FakeData:
    def __init__(self, scan_status="complete"):
        self.scan_status = scan_status
        self.calls = []

    def __call__(self, url, *, method="GET", payload=None, timeout=120):
        self.calls.append((method, url, payload))
        route = url[len(BASE):]
        if route == "/storage/agent-scans":
            return {"data": {"scan_id": f"scan-{payload['source']}"}}
        if route.startswith("/storage/status/"):
            return {"data": {"status": self.scan_status}}
        if route == "/janitor/profiles/shared-drive/strategy":
            return {"data": {"report": {"status": "ready", "maintenance": {"proposals": [], "executableActions": []}}}}
        if route.startswith("/storage/summary"):
            return {"data": {"totalFiles": 3, "evidenceLimitations": {"lowerBound": True}}}
        return {"data": {}}


class CliTest(unittest.TestCase):
    def run_main(self, argv, fake):
        out = io.StringIO()
        with mock.patch.object(client, "http_json", fake), mock.patch.object(client.time, "sleep"), \
                redirect_stdout(out):
            code = CLI.main(argv)
        return code, out.getvalue()

    def test_refresh_writes_report_and_prints_notification(self):
        fake = FakeData()
        with tempfile.TemporaryDirectory() as tmp:
            code, out = self.run_main(
                ["--base-url", BASE, "--refresh", "--metadata-only", "--report-dir", tmp,
                 "--dashboard-url", "https://dashboard.test/data-toolbox#janitor"],
                fake,
            )
            latest = json.loads((Path(tmp) / "latest.json").read_text(encoding="utf-8"))
            reports = list(Path(tmp).glob("shared-drive-assessment-*.json"))
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("Shared-drive Janitor: OK - ready (read-only)."))
        self.assertIn("Dashboard + complete report: https://dashboard.test/data-toolbox#janitor", out)
        self.assertEqual(len(reports), 1)
        self.assertEqual(latest["mode"], "read-only-assessment")
        self.assertEqual(latest["scans"]["media"]["status"], "complete")
        self.assertEqual(latest["evidencePolicy"]["perRoot"]["datalake"], {"lowerBound": True})
        posts = [(url, payload) for method, url, payload in fake.calls if method == "POST"]
        self.assertEqual(
            [url[len(BASE):] for url, _ in posts],
            ["/storage/agent-scans", "/storage/agent-scans", "/janitor/profiles/shared-drive/strategy"],
        )
        self.assertEqual(posts[0][1]["hash_mode"], "none")
        self.assertFalse(any("approve" in url or "/run" in url for _, url, _ in fake.calls))

    def test_failed_scan_exits_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out = self.run_main(
                ["--base-url", BASE, "--refresh", "--sources", "media", "--report-dir", tmp],
                FakeData(scan_status="partial"),
            )
        self.assertEqual(code, 1)
        self.assertEqual(out.strip(), "Shared-drive janitor failed: media scan ended as partial")

    def test_verbose_summary_without_refresh(self):
        fake = FakeData()
        with tempfile.TemporaryDirectory() as tmp:
            code, out = self.run_main(["--base-url", BASE, "--report-dir", tmp, "--verbose-summary"], fake)
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("Shared-drive janitor assessment OK (read-only)."))
        self.assertFalse(any(url.endswith("/storage/agent-scans") for _, url, _ in fake.calls))

    def test_environment_supplies_instance_values(self):
        env = {
            "AGENTX_JANITOR_BASE_URL": "http://env.test/api/v1",
            "AGENTX_JANITOR_DASHBOARD_URL": "https://env.test/data-toolbox#janitor",
            "AGENTX_JANITOR_REPORT_DIR": "reports-env",
        }
        with mock.patch.dict(os.environ, env):
            args = CLI.parser().parse_args([])
        self.assertEqual(args.base_url, env["AGENTX_JANITOR_BASE_URL"])
        self.assertEqual(args.dashboard_url, env["AGENTX_JANITOR_DASHBOARD_URL"])
        self.assertEqual(args.report_dir, Path("reports-env"))
        with mock.patch.dict(os.environ, {}, clear=True):
            defaults = CLI.parser().parse_args([])
        self.assertEqual(defaults.base_url, CLI.DEFAULT_BASE_URL)
        self.assertEqual(defaults.sources, ["media", "datalake"])
        self.assertEqual(defaults.hash_max_bytes, 50 * 1024**3)


if __name__ == "__main__":
    unittest.main()
