import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "secretary_mail_desk.py"
SPEC = importlib.util.spec_from_file_location("secretary_mail_desk", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)

THREAD = "1a0a72c7f639bccf"
LABEL_ROWS = [{"id": "Label_36", "name": "Secretary/Urgent"}, {"id": "Label_37", "name": "Secretary/Needs Reply"}]


def completed(payload, returncode=0, stderr=""):
    return subprocess.CompletedProcess([], returncode, stdout=json.dumps(payload), stderr=stderr)


def thread_payload(*label_ids):
    return {"thread": {"id": THREAD, "messages": [{"id": "m1", "labelIds": list(label_ids)}]}}


class SecretaryMailDeskTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.password_file = Path(self.directory.name) / "keyring-password"
        self.password_file.write_text("secret\n", encoding="utf-8")

    def test_native_settings_reuse_existing_owner_and_allow_overrides(self):
        config = Path(self.directory.name) / "openclaw.json"
        config.write_text(json.dumps({"plugins": {"entries": {"gmail-secretary": {"config": {
            "account": "native@example.com", "gogPath": "/opt/gog", "keyringPasswordFile": "/private/keyring", "timezone": "UTC"
        }}}}}), encoding="utf-8")
        with mock.patch.dict(MODULE.os.environ, {"OPENCLAW_CONFIG_PATH": str(config)}, clear=True):
            args = MODULE.parse_args(["backlog"])
            self.assertEqual((args.account, args.gog, args.keyring_password_file), ("native@example.com", "/opt/gog", "/private/keyring"))
            self.assertEqual(MODULE.parse_args(["--account", "explicit@example.com", "backlog"]).account, "explicit@example.com")
            with mock.patch.dict(MODULE.os.environ, {"GMAIL_SECRETARY_ACCOUNT": "env@example.com"}):
                self.assertEqual(MODULE.parse_args(["backlog"]).account, "env@example.com")
        config.write_text("invalid", encoding="utf-8")
        with mock.patch.dict(MODULE.os.environ, {"OPENCLAW_CONFIG_PATH": str(config)}, clear=True):
            self.assertIsNone(MODULE.parse_args(["backlog"]).account)

    def run_main(self, *argv, responses):
        calls = []

        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            return responses[len(calls) - 1]

        output = io.StringIO()
        with mock.patch.object(MODULE.subprocess, "run", side_effect=fake_run), contextlib.redirect_stdout(output):
            code = MODULE.main(["--gog", "/usr/local/bin/gog", "--account", "owner@example.com",
                                "--keyring-password-file", str(self.password_file), *argv])
        return code, json.loads(output.getvalue()), calls

    def test_threads_lists_metadata_only_through_a_read_only_exact_command(self):
        code, payload, calls = self.run_main("threads", "--label", "needs-reply", responses=[completed({
            "nextPageToken": "next",
            "threads": [
                {"id": THREAD, "from": "Nathalie <n@example.com>", "subject": "Horaire", "date": "2026-09-15 12:48",
                 "labels": ["UNREAD", "INBOX", "Secretary/Needs Reply"], "messageCount": 2},
                {"id": "not a thread id", "subject": "dropped"},
            ],
        })])
        self.assertEqual(code, 0)
        self.assertEqual(payload["status"], "success")
        self.assertEqual(payload["data"]["count"], 1)
        self.assertTrue(payload["data"]["more"])
        self.assertEqual(payload["data"]["threads"][0], {
            "threadId": THREAD, "from": "Nathalie <n@example.com>", "subject": "Horaire", "date": "2026-09-15 12:48",
            "unread": True, "inbox": True, "messageCount": 2, "gmailUrl": f"https://mail.google.com/mail/#all/{THREAD}",
        })
        command, kwargs = calls[0]
        self.assertIn("--readonly", command)
        self.assertIn("--gmail-no-send", command)
        self.assertIn("--enable-commands-exact=gmail.search", command)
        self.assertIn('label:"Secretary/Needs Reply"', command)
        self.assertEqual(kwargs["env"]["GOG_KEYRING_BACKEND"], "file")
        self.assertEqual(kwargs["env"]["GOG_KEYRING_PASSWORD"], "secret")

    def test_handled_removes_one_label_and_reads_the_thread_back(self):
        code, payload, calls = self.run_main("handled", "--label", "urgent", "--thread", THREAD.upper(), responses=[
            completed(LABEL_ROWS),
            completed(thread_payload("INBOX", "Label_36", "Label_44")),
            completed({"modified": [THREAD]}),
            completed(thread_payload("INBOX", "Label_44")),
        ])
        self.assertEqual(code, 0)
        self.assertEqual(payload["data"], {"threadId": THREAD, "label": "urgent", "removed": True, "verified": True})
        modify = calls[2][0]
        self.assertNotIn("--readonly", modify)
        self.assertIn("--gmail-no-send", modify)
        self.assertIn("--enable-commands-exact=gmail.labels.modify", modify)
        self.assertEqual(modify[-4:], ["labels", "modify", THREAD, "--remove=Secretary/Urgent"])
        # Every other call is read-only, and nothing archives, trashes or sends.
        for index in (0, 1, 3):
            self.assertIn("--readonly", calls[index][0])
        self.assertFalse({"archive", "trash", "send"} & set(modify))
        self.assertFalse(any(token.startswith("--add") for token in modify))

    def test_handled_is_idempotent_and_refuses_an_unverified_removal(self):
        code, payload, calls = self.run_main("handled", "--label", "urgent", "--thread", THREAD, responses=[
            completed(LABEL_ROWS), completed(thread_payload("INBOX")),
        ])
        self.assertEqual(payload["data"]["removed"], False)
        self.assertEqual(len(calls), 2, "an already handled thread is never modified")

        code, payload, _ = self.run_main("handled", "--label", "urgent", "--thread", THREAD, responses=[
            completed(LABEL_ROWS), completed(thread_payload("Label_36")), completed({}), completed(thread_payload("Label_36")),
        ])
        self.assertEqual(code, 0)
        self.assertEqual((payload["status"], payload["code"], payload["statusCode"]), ("error", "SECRETARY_MAIL_NOT_APPLIED", 502))

    def test_a_thread_id_never_reaches_gog_unvalidated(self):
        for bad in ("123", "1a0a72c7f639bccf;reboot", "$(reboot)"):
            code, payload, calls = self.run_main("handled", "--label", "urgent", "--thread", bad, responses=[])
            self.assertEqual((code, payload["code"], payload["statusCode"]), (0, "SECRETARY_MAIL_BAD_THREAD", 400))
            self.assertEqual(calls, [])
        # A value shaped like an option is refused by the parser itself, still as an envelope.
        with contextlib.redirect_stderr(io.StringIO()):
            code, payload, calls = self.run_main("handled", "--label", "urgent", "--thread", "--query=in:anywhere", responses=[])
        self.assertEqual((code, payload["code"], calls), (0, "SECRETARY_MAIL_BAD_REQUEST", []))

    def test_senders_rank_review_mail_by_address_from_metadata_only(self):
        rows = [{"id": str(i), "from": "CI Bot <bot@ci.example>", "subject": f"Run {i} failed"} for i in range(3)]
        rows += [{"id": "a", "from": "news@shop.example", "subject": "Sale"}, {"id": "b", "from": "No address"}]
        code, payload, calls = self.run_main("senders", responses=[completed({"messages": rows, "nextPageToken": "n"})])
        self.assertEqual(code, 0)
        data = payload["data"]
        self.assertEqual((data["sampled"], data["more"]), (5, True))
        self.assertEqual(data["senders"][0], {"address": "bot@ci.example", "domain": "ci.example", "name": "CI Bot",
                                              "count": 3, "sampleSubject": "Run 0 failed"})
        self.assertEqual([entry["address"] for entry in data["senders"]], ["bot@ci.example", "news@shop.example"])
        command = calls[0][0]
        self.assertIn("--readonly", command)
        self.assertIn("--enable-commands-exact=gmail.messages.search", command)
        self.assertIn('label:"Secretary/Review"', command)
        self.assertIn("--max=300", command)

    def test_backlog_counts_recent_unlabelled_inbox_mail_and_flags_the_cap(self):
        code, payload, calls = self.run_main("backlog", responses=[completed([{"id": str(i)} for i in range(61)])])
        self.assertEqual(payload["data"], {
            "query": 'in:inbox -label:"Secretary/Processed" newer_than:7d', "days": 7, "unlabelled": 61, "capped": False,
        })
        self.assertIn("--readonly", calls[0][0])
        self.assertIn("--max=100", calls[0][0])
        _, payload, _ = self.run_main("backlog", responses=[completed([{"id": str(i)} for i in range(100)])])
        self.assertEqual((payload["data"]["unlabelled"], payload["data"]["capped"]), (100, True))

    def test_a_missing_authorization_is_named_without_leaking_gog_output(self):
        code, payload, _ = self.run_main("threads", "--label", "urgent", responses=[
            completed({}, returncode=1, stderr="No auth for gmail owner@example.com.\n\nOAuth (browser flow):\n  gog auth add"),
        ])
        self.assertEqual(code, 0)
        self.assertEqual(payload["code"], "SECRETARY_MAIL_AUTH")
        self.assertIn("gog auth add", payload["message"])
        self.assertNotIn("owner@example.com", payload["message"])

    def test_catchup_reports_counts_only_without_a_gmail_account(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "catchup-status.json").write_text(json.dumps({"phase": "reviewing", "reviewed": 3, "remaining": 7,
                "failed": 0, "pagesPerHour": 400.0, "etaHours": 0.1, "lane": "contact", "summary": "private text",
                "paused": {"reason": "benchmark running", "since": "2026-10-02T19:00:00Z"}}))
            (root / "catchup-proposals.json").write_text(json.dumps([{"state": "pending", "text": "private"}, {"state": "queued"}, {"state": "queued"}]))
            (root / "catchup.lock").write_text("{}")
            data = MODULE.catchup(None, root)
            self.assertEqual((data["known"], data["running"], data["reviewed"], data["proposalsPending"], data["proposalsQueued"]), (True, True, 3, 1, 2))
            self.assertEqual(data["paused"]["reason"], "benchmark running")
            self.assertNotIn("private", json.dumps(data))
            self.assertEqual(MODULE.catchup(None, root / "missing")["known"], False)
        out = io.StringIO()
        with mock.patch.dict(MODULE.os.environ, {"GMAIL_SECRETARY_ACCOUNT": "", "GMAIL_SECRETARY_KEYRING_FILE": ""}),              mock.patch.object(MODULE, "native_settings", return_value={}), contextlib.redirect_stdout(out):
            MODULE.main(["catchup"])
        self.assertEqual(json.loads(out.getvalue())["status"], "success")


if __name__ == "__main__":
    unittest.main()
