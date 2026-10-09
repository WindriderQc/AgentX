import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "subscriptions" / "openclaw_subscription_audit.py"
SPEC = importlib.util.spec_from_file_location("openclaw_subscription_audit", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)

REAL_RUN = subprocess.run
ACCOUNT = "family@example.invalid"
GMAIL_ROWS = [
    {
        "id": "m1",
        "from": "Example Stream <billing@example-stream.invalid>",
        "subject": "Your subscription renewal receipt",
        "date": "2026-05-01",
        "labels": ["CATEGORY_UPDATES"],
        "snippet": "full body text that must not be kept",
    },
    {
        "id": "m2",
        "from": "Example Shop <news@example-shop.invalid>",
        "subject": "Weekly newsletter - unsubscribe anytime",
        "date": "2026-05-02",
        "labels": ["CATEGORY_PROMOTIONS"],
    },
]


class FakeRunner:
    """Answers gog calls with synthetic rows and runs the real Node audit."""

    def __init__(self, gog_result):
        self.gog_result = gog_result
        self.gog_calls = []

    def __call__(self, command, **kwargs):
        if command[0] == "fake-gog":
            self.gog_calls.append((command, kwargs))
            return self.gog_result
        return REAL_RUN(command, **kwargs)


class SubscriptionAuditJobTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.keyring = self.root / "keyring-password"
        self.keyring.write_text("synthetic-password\n", encoding="utf-8")
        self.workspace = self.root / "workspace"
        self.report_dir = self.workspace / "reports" / "subscription-audit"

    def tearDown(self):
        self.tmp.cleanup()

    def argv(self, *extra):
        return [
            "--workspace", str(self.workspace),
            "--account", ACCOUNT,
            "--gog", "fake-gog",
            "--keyring-password-file", str(self.keyring),
            *extra,
        ]

    def run_main(self, runner, argv):
        out = io.StringIO()
        with mock.patch.object(MODULE.subprocess, "run", side_effect=runner), \
                contextlib.redirect_stdout(out):
            code = MODULE.main(argv)
        return code, out.getvalue()

    def test_account_is_required(self):
        with mock.patch.dict(os.environ, {"GMAIL_SECRETARY_ACCOUNT": ""}), \
                contextlib.redirect_stderr(io.StringIO()), \
                self.assertRaises(SystemExit):
            MODULE.parse_args([])

    def test_environment_supplies_gmail_settings(self):
        env = {
            "GMAIL_SECRETARY_ACCOUNT": ACCOUNT,
            "GMAIL_SECRETARY_GOG": "/opt/gog",
            "GMAIL_SECRETARY_KEYRING_FILE": "/opt/keyring",
            "GMAIL_SECRETARY_TIMEZONE": "Europe/Paris",
            "SUBSCRIPTION_AUDIT_WORKSPACE": "/opt/workspace",
        }
        with mock.patch.dict(os.environ, env):
            args = MODULE.parse_args([])
        self.assertEqual(args.account, ACCOUNT)
        self.assertEqual(args.gog, "/opt/gog")
        self.assertEqual(args.keyring_password_file, "/opt/keyring")
        self.assertEqual(args.timezone, "Europe/Paris")
        self.assertEqual(args.workspace, "/opt/workspace")
        self.assertEqual(Path(args.audit_script), SCRIPT.with_name("subscription-audit.js"))

    def test_sanitized_messages_keep_summary_fields_only(self):
        rows = MODULE.sanitized_messages({"messages": GMAIL_ROWS + ["skip"] + GMAIL_ROWS * 30})
        self.assertEqual(len(rows), 49)
        self.assertEqual(set(rows[0]), {"from", "subject", "date", "labels"})
        with self.assertRaises(MODULE.GmailAccessError):
            MODULE.sanitized_messages("not a list")

    def test_gmail_rows_produce_report(self):
        runner = FakeRunner(subprocess.CompletedProcess([], 0, stdout=json.dumps(GMAIL_ROWS), stderr=""))
        code, out = self.run_main(runner, self.argv("--timezone", "Europe/Paris"))

        self.assertEqual(code, 0, out)
        self.assertIn("Status: OK / Gmail read-only", out)
        self.assertIn("Messages reviewed: 2", out)
        self.assertIn("Vendors: 2", out)
        command, kwargs = runner.gog_calls[0]
        self.assertIn("--readonly", command)
        self.assertIn("--gmail-no-send", command)
        self.assertIn("--enable-commands-exact=gmail.messages.search", command)
        self.assertEqual(command[command.index("--account") + 1], ACCOUNT)
        self.assertEqual(command[command.index("--timezone") + 1], "Europe/Paris")
        self.assertEqual(kwargs["env"]["GOG_KEYRING_PASSWORD"], "synthetic-password")
        self.assertEqual(kwargs["env"]["GOG_KEYRING_BACKEND"], "file")
        stored = json.loads((self.report_dir / "input-gmail.json").read_text(encoding="utf-8"))
        self.assertNotIn("snippet", stored[0])
        summary = json.loads((self.report_dir / "latest.summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["source"], MODULE.SOURCE)
        self.assertTrue((self.report_dir / "latest.html").is_file())

    def test_gmail_failure_falls_back_to_fixture(self):
        runner = FakeRunner(subprocess.CompletedProcess([], 1, stdout="", stderr="token expired"))
        code, out = self.run_main(runner, self.argv())

        self.assertEqual(code, 2)
        self.assertIn("Status: FIXTURE-ONLY / BLOCKED ON GMAIL ACCESS", out)
        self.assertIn("Reason: token expired", out)
        summary = json.loads((self.report_dir / "latest.summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["source"], MODULE.FIXTURE_SOURCE)
        self.assertTrue(summary["dryRun"])

    def test_missing_keyring_falls_back_without_calling_gog(self):
        self.keyring.unlink()
        runner = FakeRunner(None)
        code, out = self.run_main(runner, self.argv())

        self.assertEqual(code, 2)
        self.assertIn("cannot read gog keyring password", out)
        self.assertEqual(runner.gog_calls, [])


if __name__ == "__main__":
    unittest.main()
