import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_store import load
from mail_catchup import CoreClient
from review_attempts import ReviewUncertain, extract_once, hashed, unsettled, blocked_phase
from review_response import ReviewInvalidOutput


class RetainedResponseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.archive = SimpleNamespace(root=Path(self.temp.name))
        self.page = {"pageId": "synthetic-page-1", "threadId": "thread001"}
        self.directory = self.archive.root / "review-attempts" / hashed(self.page["pageId"])
        self.calls = []

    def client(self, raw, budget=None, thinking=False):
        def opener(request, timeout):
            self.calls.append(json.loads(request.data))
            if isinstance(raw, Exception):
                raise raw
            response = MagicMock(status=200, headers={"content-type": "application/json"})
            response.read.return_value = raw
            response.__enter__.return_value = response
            return response
        return CoreClient("http://core.invalid", task_type="mail_review", opener=opener, max_output_tokens=budget, thinking=thinking)

    def run_once(self, client):
        return extract_once(self.archive, client, "Synthetic policy", "Synthetic source page", self.page)

    def test_http_and_model_text_are_durable_before_their_respective_json_parses(self):
        text = '{"summary":"Source fictive é 👋", "moments": []}'
        raw = json.dumps({"response": text, "done": True, "done_reason": "stop"}, ensure_ascii=False).encode()
        client = self.client(raw, 8192)
        original = json.loads
        checked = []
        def parse(value, *args, **kwargs):
            if value == raw:
                self.assertEqual((self.directory / "response-1-http.txt").read_bytes(), raw); checked.append("http")
            if value == text:
                self.assertEqual((self.directory / "response-1-model.txt").read_text(), text); checked.append("model")
            return original(value, *args, **kwargs)
        with patch("json.loads", side_effect=parse):
            self.assertEqual(self.run_once(client)["summary"], "Source fictive é 👋")
        self.assertEqual(checked, ["http", "model"])
        self.assertEqual(self.calls[0]["options"], {"temperature": 0, "num_predict": 8192})
        self.assertNotIn("num_ctx", self.calls[0]["options"]); self.assertNotIn("model", self.calls[0])
        self.assertEqual(load(self.directory / "attempt.json")["intent"]["maxOutputTokens"], 8192)

    def test_truncated_model_output_is_known_invalid_and_never_reissued_automatically(self):
        text = '{"summary":"Source fictive", "moments": ['
        raw = json.dumps({"response": text, "done": True, "done_reason": "length", "eval_count": 4096,
                          "agentx_contract": {"contextBudget": {"output": {"reservedTokens": 4096}}}}).encode()
        client = self.client(raw, 8192)
        for _ in range(2):
            with self.assertRaises(ReviewInvalidOutput) as caught:
                self.run_once(client)
            self.assertEqual(caught.exception.reason, "incomplete-model-output")
        state = load(self.directory / "attempt.json")
        self.assertEqual(state["phase"], "invalid-output"); self.assertTrue(state["limits"]["atOutputLimit"])
        self.assertEqual((self.directory / "response-1-model.txt").read_text(), text)
        self.assertFalse((self.directory / "result.json").exists()); self.assertEqual(len(self.calls), 1)
        self.assertEqual(blocked_phase(unsettled(self.archive.root)), "validation-error")

    def test_invalid_http_json_retains_the_exact_received_text_without_model_content(self):
        raw = b'<html>Unexpected complete response</html>'
        client = self.client(raw)
        with self.assertRaises(ReviewInvalidOutput) as caught:
            self.run_once(client)
        self.assertEqual(caught.exception.reason, "invalid-core-http-json")
        self.assertEqual((self.directory / "response-1-http.txt").read_bytes(), raw)
        self.assertFalse((self.directory / "response-1-model.txt").exists())
        self.assertEqual(load(self.directory / "attempt.json")["phase"], "invalid-output")

    def test_an_empty_http_response_is_retained_as_empty_instead_of_inventing_an_object(self):
        client = self.client(b'')
        with self.assertRaises(ReviewInvalidOutput): self.run_once(client)
        self.assertEqual((self.directory / "response-1-http.txt").read_bytes(), b'')
        self.assertEqual(load(self.directory / "response-1-http.json")["bytes"], 0)

    def test_successfully_received_but_invalid_model_json_is_not_a_transport_uncertainty(self):
        client = self.client(json.dumps({"response": '{"broken":', "done": True, "done_reason": "stop"}).encode())
        with self.assertRaises(ReviewInvalidOutput) as caught:
            self.run_once(client)
        self.assertEqual(caught.exception.reason, "invalid-model-json")
        self.assertEqual(load(self.directory / "attempt.json")["phase"], "invalid-output")

    def test_a_changed_output_budget_cannot_silently_replace_a_completed_invalid_call(self):
        client = self.client(json.dumps({"response": '{"broken":'}).encode(), 4096)
        with self.assertRaises(ReviewInvalidOutput): self.run_once(client)
        before = (self.directory / "attempt.json").read_bytes()
        client.max_output_tokens = 8192
        with self.assertRaises(ReviewUncertain): self.run_once(client)
        self.assertEqual(len(self.calls), 1); self.assertEqual((self.directory / "attempt.json").read_bytes(), before)

    def test_a_tampered_capture_or_transport_loss_keeps_the_uncertainty_fence(self):
        client = self.client(json.dumps({"response": '{"broken":'}).encode())
        with self.assertRaises(ReviewInvalidOutput): self.run_once(client)
        (self.directory / "response-1-http.txt").write_bytes(b'corrupted capture')
        self.assertEqual(blocked_phase(unsettled(self.archive.root)), "uncertain")
        with self.assertRaises(ReviewUncertain): self.run_once(client)
        self.assertEqual(len(self.calls), 1)

    def test_timeout_is_never_a_known_terminal_result(self):
        client = self.client(urllib.error.URLError("Synthetic connection loss"))
        with self.assertRaises(ReviewUncertain): self.run_once(client)
        self.assertEqual(load(self.directory / "attempt.json")["phase"], "unconfirmed")
        self.assertEqual(blocked_phase(unsettled(self.archive.root)), "uncertain")

    def test_failed_durable_capture_preserves_uncertainty_and_does_not_retry(self):
        client = self.client(json.dumps({"response": '{}'}).encode())
        def failure(*_): raise OSError("Synthetic unavailable response storage")
        with patch("review_attempts.capture_response", return_value=failure):
            with self.assertRaises(ReviewUncertain): self.run_once(client)
        self.assertEqual(load(self.directory / "attempt.json")["phase"], "unconfirmed")
        self.assertIsNone(client.review_response_sink)
        with self.assertRaises(ReviewUncertain): self.run_once(client)
        self.assertEqual(len(self.calls), 1)

    def test_valid_json_still_rejects_a_native_length_stop(self):
        client = self.client(json.dumps({"response": '{}', "done_reason": "length"}).encode())
        with self.assertRaises(ReviewInvalidOutput): self.run_once(client)
        self.assertFalse((self.directory / "result.json").exists())

    def test_an_output_budget_is_explicit_bounded_and_never_a_concrete_model(self):
        for value in (0, -1, True, 1.5, 65537):
            with self.assertRaises(ValueError): self.client(b'{}', value)

    def test_default_thinking_false_preserves_the_legacy_intent_and_request_body(self):
        client = self.client(json.dumps({"response": '{}'}).encode())
        self.assertEqual(self.run_once(client), {})
        state = load(self.directory / "attempt.json")
        self.assertFalse(self.calls[0]["think"])
        self.assertNotIn("thinking", state["intent"])
        self.assertEqual(self.run_once(self.client(b'not-called', thinking=False)), {})
        self.assertEqual(len(self.calls), 1)

    def test_explicit_thinking_is_sent_to_core_and_bound_to_the_retained_identity(self):
        client = self.client(json.dumps({"response": '{}'}).encode(), 16384, thinking=True)
        self.assertEqual(self.run_once(client), {})
        state = load(self.directory / "attempt.json")
        self.assertIs(state["intent"]["thinking"], True)
        self.assertTrue(self.calls[0]["think"])
        self.assertEqual(self.calls[0]["taskType"], "mail_review")
        self.assertEqual(self.calls[0]["options"]["num_predict"], 16384)
        self.assertNotIn("model", self.calls[0]); self.assertNotIn("num_ctx", self.calls[0]["options"])
        before = (self.directory / "attempt.json").read_bytes()
        client.thinking = False
        with self.assertRaises(ReviewUncertain): self.run_once(client)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual((self.directory / "attempt.json").read_bytes(), before)

    def test_enabling_thinking_cannot_replace_a_legacy_dispatch(self):
        client = self.client(json.dumps({"response": '{}'}).encode())
        self.run_once(client); client.thinking = True
        with self.assertRaises(ReviewUncertain): self.run_once(client)
        self.assertEqual(len(self.calls), 1)

    def test_thinking_refuses_non_boolean_options(self):
        for value in (None, "true", 0, 1, {}, []):
            with self.subTest(value=value), self.assertRaises(ValueError): self.client(b'{}', thinking=value)


if __name__ == "__main__":
    unittest.main()
