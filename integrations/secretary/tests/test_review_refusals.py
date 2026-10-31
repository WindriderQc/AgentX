import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mail_catchup import Busy, CoreClient
from review_attempts import extract_once, unsettled
from review_receipts import durable, hashed
from review_refusals import record_refusal


class RefusalRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.intent = {"pageId": "synthetic-page", "systemSha256": hashed("policy"),
                       "promptSha256": hashed("passage"), "core": "http://core.invalid",
                       "taskType": "mail_review", "lightModel": None, "lightHost": None, "light": False}
        self.directory = self.root / "review-attempts" / hashed("synthetic-page")
        self.state = {"schema": "agentx.secretary-review-attempt/v1", "requestId": "secretary-review-" + hashed(self.intent),
                      "intentSha256": hashed(self.intent), "intent": self.intent, "pageId": "synthetic-page",
                      "threadId": "synthetic-thread", "phase": "unconfirmed", "attempt": 1,
                      "startedAt": "2026-01-01T00:00:00Z", "errorType": "ReviewUncertain"}
        self.raw = json.dumps({"ok": False, "code": "RUNTIME_INFERENCE_RECOVERY_REQUIRED"}).encode()
        self.response = {"schema": "agentx.secretary-review-response/v1", "stage": "http",
                         "requestId": self.state["requestId"], "intentSha256": self.state["intentSha256"],
                         "httpStatus": 503, "truncated": False, "bytes": len(self.raw),
                         "bodySha256": hashlib.sha256(self.raw).hexdigest()}
        durable(self.directory / "attempt.json", self.state)
        durable(self.directory / "response-1-http.json", self.response)
        (self.directory / "response-1-http.txt").write_bytes(self.raw)
        durable(self.directory / "dispatch-1.json", {"requestId": self.state["requestId"]})
        self.call = MagicMock(return_value={"items": [], "pagination": {"total": 0, "hasNext": False}})

    def recover(self, state=None):
        return record_refusal(self.directory, state or self.state, reason="Inspect exact retained refusal",
                              authorization_ref="synthetic-session/task", call=self.call)

    def test_recovery_preserves_exact_evidence_and_replays_idempotently(self):
        original_files = {p.name: p.read_bytes() for p in self.directory.glob("response-*")}
        row = self.recover()
        restored = json.loads((self.directory / "attempt.json").read_text())
        self.assertEqual(restored["phase"], "refused")
        self.assertEqual(restored["requestId"], self.state["requestId"])
        self.assertEqual(row["originalAttempt"], self.state)
        self.assertEqual(row, self.recover(restored))
        self.call.assert_called_once()
        self.assertEqual(original_files, {p.name: p.read_bytes() for p in self.directory.glob("response-*")})
        self.assertEqual(unsettled(self.root), [])

    def test_refusal_recovery_resumes_only_same_request_with_new_numbered_dispatch(self):
        self.recover()
        def opener(request, timeout):
            response = MagicMock(status=200, headers={})
            response.read.return_value = json.dumps({"response": '{"summary":"Synthetic review"}', "done": True}).encode()
            response.__enter__.return_value = response
            return response
        client = CoreClient("http://core.invalid", task_type="mail_review", opener=opener)
        value = extract_once(type("Archive", (), {"root": self.root})(), client, "policy", "passage",
                             {"pageId": "synthetic-page", "threadId": "synthetic-thread"})
        self.assertEqual(value["summary"], "Synthetic review")
        self.assertTrue((self.directory / "dispatch-1.json").exists())
        self.assertTrue((self.directory / "dispatch-2.json").exists())
        result = json.loads((self.directory / "result.json").read_text())
        self.assertEqual(result["requestId"], self.state["requestId"])

    def test_future_typed_recovery_refusals_are_safe_without_reconciliation(self):
        error = urllib.error.HTTPError("http://core.invalid", 503, "busy", {}, io.BytesIO(self.raw))
        client = CoreClient("http://core.invalid", opener=MagicMock(side_effect=error))
        with self.assertRaises(Busy) as raised:
            client._call("POST", "/api/inference/generate", {})
        self.assertTrue(raised.exception.safe_to_retry)

    def test_interrupted_restoration_resumes_from_original_immutable_receipt(self):
        def interrupted(file, value, **options):
            if file.name == "attempt.json": raise OSError("simulated interruption")
            durable(file, value, **options)
        with patch("review_refusals.durable", side_effect=interrupted):
            with self.assertRaises(OSError): self.recover()
        self.assertEqual(json.loads((self.directory / "attempt.json").read_text()), self.state)
        self.recover()
        self.call.assert_called_once()
        self.assertEqual(json.loads((self.directory / "attempt.json").read_text())["phase"], "refused")

    def test_modified_reconciliation_cannot_replace_original_attempt(self):
        self.recover()
        restored = json.loads((self.directory / "attempt.json").read_text())
        file = self.directory / "refusal-reconciliation-1.json"
        row = json.loads(file.read_text())
        row["originalAttempt"]["attempt"] = 99
        durable(file, row)
        with self.assertRaises(ValueError): self.recover(restored)
        self.assertEqual(json.loads((self.directory / "attempt.json").read_text()), restored)

    def test_unknown_errors_truncation_and_changed_identity_remain_fenced(self):
        for field, value in [("httpStatus", 200), ("httpStatus", 500), ("truncated", True),
                             ("requestId", "other"), ("bodySha256", "0" * 64), ("bytes", 0)]:
            with self.subTest(field=field):
                durable(self.directory / "response-1-http.json", {**self.response, field: value})
                with self.assertRaises(ValueError): self.recover()
                self.assertFalse((self.directory / "refusal-reconciliation-1.json").exists())
        durable(self.directory / "response-1-http.json", self.response)
        for logs in [{"items": [{"status": "success"}], "pagination": {"total": 1, "hasNext": False}},
                     {"items": [], "pagination": {"total": 0, "hasNext": True}}, {}]:
            self.call.return_value = logs
            with self.assertRaises(ValueError): self.recover()
        self.assertEqual(json.loads((self.directory / "attempt.json").read_text()), self.state)

    def test_unrecognized_response_code_and_retained_result_are_never_retried(self):
        raw = json.dumps({"code": "UPSTREAM_RESPONSE_LOST"}).encode()
        (self.directory / "response-1-http.txt").write_bytes(raw)
        durable(self.directory / "response-1-http.json", {**self.response, "bytes": len(raw),
                                                        "bodySha256": hashlib.sha256(raw).hexdigest()})
        with self.assertRaises(ValueError): self.recover()
        (self.directory / "response-1-http.txt").write_bytes(self.raw)
        durable(self.directory / "response-1-http.json", self.response)
        durable(self.directory / "result.json", {"value": {"summary": "Retained"}})
        with self.assertRaises(ValueError): self.recover()


if __name__ == "__main__":
    unittest.main()
