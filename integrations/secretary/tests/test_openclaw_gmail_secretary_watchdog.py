import argparse
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "openclaw_gmail_secretary_watchdog.py"
SPEC = importlib.util.spec_from_file_location("openclaw_gmail_secretary_watchdog", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class GmailSecretaryWatchdogTest(unittest.TestCase):
    def args(self, password_file: Path) -> argparse.Namespace:
        return argparse.Namespace(
            account="owner@example.com",
            gog="/usr/local/bin/gog",
            keyring_password_file=str(password_file),
            audit_log=str(password_file.parent / "audit.jsonl"),
            timeout_seconds=20,
            audit_stale_seconds=7200,
            incomplete_grace_seconds=300,
            openclaw="/usr/local/bin/openclaw",
            triage_job_id="triage-job",
            watchdog_job_id="watchdog-job",
            revive_retry_seconds=3600,
            catchup_every="5m",
            steady_every="1h",
            evidence_status="unused-native-status.json",
        )

    def test_probe_is_read_only_and_returns_a_bounded_count(self):
        with tempfile.TemporaryDirectory() as directory:
            password_file = Path(directory) / "keyring-password"
            password_file.write_text("secret\n", encoding="utf-8")
            completed = subprocess.CompletedProcess([], 0, stdout='[{"id":"m1"}]\n', stderr="")
            with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run:
                self.assertEqual(MODULE.run_probe(self.args(password_file)), 1)

            command = run.call_args.args[0]
            self.assertIn("--readonly", command)
            self.assertIn("--gmail-no-send", command)
            self.assertIn("--select=id", command)
            self.assertIn("--max=1", command)
            self.assertIn(MODULE.MAILBOX_BACKLOG_QUERY, command)
            self.assertNotIn("--include-body", command)

    def test_invalid_grant_is_reported_without_raw_transport_output(self):
        with tempfile.TemporaryDirectory() as directory:
            password_file = Path(directory) / "keyring-password"
            password_file.write_text("secret\n", encoding="utf-8")
            completed = subprocess.CompletedProcess(
                [],
                1,
                stdout="",
                stderr='oauth2: "invalid_grant" "Token has been expired or revoked."',
            )
            with mock.patch.object(MODULE.subprocess, "run", return_value=completed):
                with self.assertRaisesRegex(
                    MODULE.GmailSecretaryProbeError,
                    "Gmail OAuth grant expired or revoked",
                ):
                    MODULE.run_probe(self.args(password_file))

    def test_missing_keyring_authorization_names_the_owner_action(self):
        detail = MODULE.failure_detail("", "No auth for gmail owner@example.com.\n\nOAuth (browser flow):\n  gog auth add", 1)
        self.assertIn("authorization is missing", detail)
        self.assertNotIn("owner@example.com", detail)

    def test_completed_triage_audit_is_healthy(self):
        with tempfile.TemporaryDirectory() as directory:
            audit = Path(directory) / "audit.jsonl"
            audit.write_text(
                "\n".join(
                    [
                        '{"at":"2026-08-20T01:00:00Z","tool":"gmail_secretary_backlog_next","status":"ok","outcome":"ready"}',
                        '{"at":"2026-08-20T01:00:10Z","tool":"gmail_secretary_apply_triage","status":"ok"}',
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            self.assertEqual(
                MODULE.check_audit_health(
                    audit,
                    now=datetime(2026, 8, 20, 1, 10, tzinfo=timezone.utc),
                ),
                "complete",
            )

            self.assertEqual(
                MODULE.check_audit_health(
                    audit,
                    now=datetime(2026, 8, 20, 1, 1, tzinfo=timezone.utc),
                ),
                "complete",
            )

    def test_action_receipts_are_not_read_as_tool_outcomes(self):
        now = datetime(2026, 10, 3, 6, 40, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            audit = Path(directory) / "audit.jsonl"
            audit.write_text("\n".join([
                '{"at":"2026-10-03T06:38:11.465Z","tool":"gmail_secretary_backlog_next","status":"ok","outcome":"empty"}',
                '{"at":"2026-10-03T06:38:11.506Z","schema":"agentx.tool-action-receipt/v1","tool":"gmail_secretary_backlog_next","phase":"observed","status":"observed"}',
                "not json",
            ]), encoding="utf-8")
            records = MODULE.read_audit_records(audit)
        self.assertEqual([record["status"] for record in records], ["ok"])
        MODULE.check_audit_records_health(records, now=now)

    def test_incomplete_triage_audit_fails_after_grace(self):
        with tempfile.TemporaryDirectory() as directory:
            audit = Path(directory) / "audit.jsonl"
            audit.write_text(
                '{"at":"2026-08-20T01:00:00Z","tool":"gmail_secretary_backlog_next","status":"ok","outcome":"ready"}\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                MODULE.GmailSecretaryProbeError,
                "found a thread but did not complete triage",
            ):
                MODULE.check_audit_health(
                    audit,
                    now=datetime(2026, 8, 20, 1, 10, tzinfo=timezone.utc),
                )

    def test_empty_backlog_does_not_require_apply_record(self):
        with tempfile.TemporaryDirectory() as directory:
            audit = Path(directory) / "audit.jsonl"
            audit.write_text(
                '{"at":"2026-08-20T01:00:00Z","tool":"gmail_secretary_backlog_next","status":"ok","outcome":"empty"}\n',
                encoding="utf-8",
            )
            self.assertEqual(
                MODULE.check_audit_health(
                    audit,
                    now=datetime(2026, 8, 20, 1, 10, tzinfo=timezone.utc),
                ),
                "empty",
            )

    def test_historical_cursor_uses_catchup_cadence(self):
        self.assertEqual(
            MODULE.desired_cadence(
                {"outcome": "ready", "cursorMonth": "2015-10"},
                now=datetime(2026, 8, 20, tzinfo=timezone.utc),
            ),
            "5m",
        )

    def test_current_month_with_pending_mail_still_requires_catchup(self):
        now = datetime(2026, 8, 20, tzinfo=timezone.utc)
        self.assertEqual(
            MODULE.desired_cadence(
                {"outcome": "ready", "cursorMonth": "2026-08"}, now=now
            ),
            "5m",
        )
        self.assertEqual(
            MODULE.desired_cadence(
                {"outcome": "empty", "cursorMonth": "2015-10"}, now=now
            ),
            "1h",
        )

    def test_watchdog_uses_live_pending_mail_not_the_last_lookup_mode(self):
        for pending, previous_outcome, expected in [(1, "empty", "5m"), (0, "ready", "1h")]:
            args = self.args(Path("unused"))
            with mock.patch.object(MODULE, "parse_args", return_value=args), \
                 mock.patch.object(MODULE, "revive_auto_disabled", return_value=None), \
                 mock.patch.object(MODULE, "run_probe", return_value=pending), \
                 mock.patch.object(MODULE, "read_audit_records", return_value=[{"outcome": previous_outcome}]), \
                 mock.patch.object(MODULE, "check_audit_records_health", return_value="complete"), \
                 mock.patch.object(MODULE, "check_evidence_health", return_value=False), \
                 mock.patch.object(MODULE, "reconcile_cadence", return_value=expected) as reconcile:
                self.assertEqual(MODULE.main(), 0)
                self.assertEqual(reconcile.call_args.kwargs["desired"], expected)

    def test_deep_review_keeps_catchup_when_triage_is_empty(self):
        with mock.patch.object(MODULE, "parse_args", return_value=self.args(Path("unused"))), \
             mock.patch.object(MODULE, "revive_auto_disabled", return_value=None), \
             mock.patch.object(MODULE, "run_probe", return_value=0), \
             mock.patch.object(MODULE, "read_audit_records", return_value=[]), \
             mock.patch.object(MODULE, "check_audit_records_health", return_value="empty"), \
             mock.patch.object(MODULE, "check_evidence_health", return_value=True), \
             mock.patch.object(MODULE, "reconcile_cadence", return_value="5m") as reconcile:
            self.assertEqual(MODULE.main(), 0)
            self.assertEqual(reconcile.call_args.kwargs["desired"], "5m")

    def test_deep_review_stall_is_not_hidden_by_successful_triage(self):
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory) / "status.json"
            status.write_text('{"at":"2026-09-16T12:00:00Z","pending":true}')
            record = {"tool": "gmail_secretary_evidence", "action": "next", "status": "ok",
                      "outcome": "ready", "at": "2026-09-16T12:00:00Z"}
            with self.assertRaisesRegex(MODULE.GmailSecretaryProbeError, "without recording"):
                MODULE.check_evidence_health([record], status, now=datetime(2026, 9, 16, 12, 11, tzinfo=timezone.utc))
            repeated = {**record, "at": "2026-09-16T12:10:00Z"}
            with self.assertRaisesRegex(MODULE.GmailSecretaryProbeError, "without recording"):
                MODULE.check_evidence_health([record, repeated], status, now=datetime(2026, 9, 16, 12, 11, tzinfo=timezone.utc))

    def job(self, **state):
        return subprocess.CompletedProcess([], 0, stdout=MODULE.json.dumps(state), stderr="")

    def test_auto_disabled_triage_is_revived_after_the_retry_period(self):
        disabled = {"enabled": False, "state": {"lastError": "request failed (HTTP 409).", "autoDisabled": {
            "reason": "consecutive-failures", "consecutiveErrors": 10,
            "atMs": int(datetime(2026, 9, 16, 23, 48, tzinfo=timezone.utc).timestamp() * 1000)}}}
        with mock.patch.object(MODULE.subprocess, "run", side_effect=[self.job(**disabled), self.job()]) as run:
            note = MODULE.revive_auto_disabled(openclaw="openclaw", job_id="triage-job",
                                               now=datetime(2026, 9, 17, 1, 0, tzinfo=timezone.utc))
        self.assertEqual(run.call_args_list[1].args[0], ["openclaw", "cron", "enable", "triage-job"])
        self.assertIn("HTTP 409", note)
        self.assertIn("re-enabled now", note)
        # Inside the retry period it only reports; a broken dependency is not hammered.
        with mock.patch.object(MODULE.subprocess, "run", side_effect=[self.job(**disabled)]) as run:
            note = MODULE.revive_auto_disabled(openclaw="openclaw", job_id="triage-job",
                                               now=datetime(2026, 9, 17, 0, 0, tzinfo=timezone.utc))
        self.assertIn("retry pending", note)
        run.assert_called_once()

    def test_owner_pause_and_enabled_jobs_are_never_touched(self):
        for job in ({"enabled": False, "state": {}}, {"enabled": True, "state": {}},
                    {"enabled": False, "state": {"autoDisabled": {"reason": "schedule-errors", "atMs": 0}}}):
            with mock.patch.object(MODULE.subprocess, "run", side_effect=[self.job(**job)]) as run:
                self.assertIsNone(MODULE.revive_auto_disabled(openclaw="openclaw", job_id="triage-job"))
            run.assert_called_once()

    def test_sustained_failure_yields_before_openclaw_disables_the_watchdog(self):
        for streak, expected in [(0, 1), (7, 1), (8, 0), (9, 0)]:
            with mock.patch.object(MODULE.subprocess, "run",
                                   side_effect=[self.job(state={"consecutiveErrors": streak})]):
                self.assertEqual(MODULE.failure_exit_code(openclaw="openclaw", job_id="watchdog-job"), expected)
        failed = subprocess.CompletedProcess([], 1, stdout="", stderr="gateway down")
        with mock.patch.object(MODULE.subprocess, "run", side_effect=[failed]):
            self.assertEqual(MODULE.failure_exit_code(openclaw="openclaw", job_id="watchdog-job"), 1)

    def test_failure_report_names_the_auto_disable_cause(self):
        note = "OpenClaw auto-disabled the triage job after 10 failures (HTTP 409); re-enabled now"
        with mock.patch.object(MODULE, "parse_args", return_value=self.args(Path("unused"))), \
             mock.patch.object(MODULE, "revive_auto_disabled", return_value=note), \
             mock.patch.object(MODULE, "run_probe", side_effect=MODULE.GmailSecretaryProbeError("audit is stale")), \
             mock.patch.object(MODULE, "failure_exit_code", return_value=1), \
             mock.patch.object(MODULE.sys, "stderr") as stderr:
            self.assertEqual(MODULE.main(), 1)
        written = "".join(call.args[0] for call in stderr.write.call_args_list)
        self.assertIn("audit is stale; OpenClaw auto-disabled", written)

    def test_cadence_reconciliation_is_a_noop_when_already_correct(self):
        current = subprocess.CompletedProcess(
            [], 0, stdout='{"schedule":{"kind":"every","everyMs":300000}}', stderr=""
        )
        with mock.patch.object(MODULE.subprocess, "run", return_value=current) as run:
            result = MODULE.reconcile_cadence(
                openclaw="/usr/local/bin/openclaw",
                job_id="triage-job",
                desired="5m",
            )
        self.assertEqual(result, "5m")
        run.assert_called_once()

    def test_cadence_reconciliation_updates_a_different_interval(self):
        current = subprocess.CompletedProcess(
            [], 0, stdout='{"schedule":{"kind":"every","everyMs":3600000}}', stderr=""
        )
        edited = subprocess.CompletedProcess([], 0, stdout="{}", stderr="")
        with mock.patch.object(
            MODULE.subprocess, "run", side_effect=[current, edited]
        ) as run:
            result = MODULE.reconcile_cadence(
                openclaw="/usr/local/bin/openclaw",
                job_id="triage-job",
                desired="5m",
            )
        self.assertEqual(result, "5m")
        self.assertEqual(run.call_count, 2)
        self.assertEqual(
            run.call_args_list[1].args[0],
            [
                "/usr/local/bin/openclaw",
                "cron",
                "edit",
                "triage-job",
                "--every",
                "5m",
            ],
        )


if __name__ == "__main__":
    unittest.main()
