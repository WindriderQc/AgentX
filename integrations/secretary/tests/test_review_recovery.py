import copy
from datetime import datetime, timezone, timedelta
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_store import load
from mail_catchup import CoreClient
from review_attempts import extract_once, hashed, durable, unsettled, blocked_phase, result_file, ReviewUncertain
from review_recovery import record_terminal, authorize_retry, terminal_at, selection
from review_response import ReviewInvalidOutput


class LinkedReviewRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = SimpleNamespace(root=self.root)
        self.body = "Synthetic quoted source.\r\nMore context."
        self.identity = {"objectiveSha256": "f" * 64, "contentSha256": hashlib.sha256(self.body.encode()).hexdigest()}
        self.page = {"pageId": hashed(self.identity), "threadId": "synthetic-thread"}
        self.directory = self.root / "review-attempts" / hashed(self.page["pageId"])
        self.calls = []
        self.client = self.make_client({"response": '{"summary":', "done": True, "done_reason": "length"})
        with self.assertRaises(ReviewInvalidOutput):
            self.run_once(self.client)
        self.original = (self.directory / "attempt.json").read_bytes()
        self.state = load(self.directory / "attempt.json")
        self.queue_id, self.dispatch = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
        self.status = {"queueRequestId": self.queue_id, "dispatchId": self.dispatch, "pageId": self.page["pageId"], "phase": "validation-error"}
        self.terminal_file, self.status_file = self.root / "terminal.json", self.root / "status.json"
        self.terminal = {"contract": "agentx.operator-heavy-work/v1", "queueRequestId": self.queue_id,
            "dispatchId": self.dispatch, "actor": "synthetic-operator", "receiptRef": str(self.terminal_file),
            "state": "failed", "runtimeReleased": True, "observedAt": (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat()}
        self.queue = {"id": self.queue_id, "dispatchId": self.dispatch, "state": "failed", "executor": {"mode": "operator", "receiptRef": str(self.terminal_file)},
            "releaseReceipt": {"authority": "operator-attestation", "operationId": self.dispatch, "state": "failed",
                "receiptRef": str(self.terminal_file), "actor": "synthetic-operator", "confirmation": "EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED"}}
        self.log = {"_id": "0123456789abcdef01234567", "correlationId": self.state["requestId"], "status": "success",
            "timestamp": datetime.now(timezone.utc).isoformat(), "taskType": "mail_review", "tokensOut": 4096}
        self.active = {"maintenance": None, "workloads": [], "inferences": [], "drain": None}
        self.refresh_receipts()
        self.reads = []

    def refresh_receipts(self):
        # Exact CRLF bytes ensure the evidence hash never uses newline-translated text.
        raw = json.dumps(self.status, indent=2).replace("\n", "\r\n").encode()
        self.status_file.write_bytes(raw)
        self.terminal["workerStatusSha256"] = hashlib.sha256(raw).hexdigest()
        raw = json.dumps(self.terminal, indent=2).replace("\n", "\r\n").encode()
        self.terminal_file.write_bytes(raw)
        self.queue["releaseReceipt"]["receiptSha256"] = hashlib.sha256(raw).hexdigest()

    def make_client(self, value, budget=None):
        def opener(request, timeout):
            self.calls.append(json.loads(request.data))
            if isinstance(value, Exception): raise value
            response = MagicMock(status=200, headers={})
            response.read.return_value = json.dumps(value).encode()
            response.__enter__.return_value = response
            return response
        return CoreClient("http://core.invalid", task_type="mail_review", opener=opener, max_output_tokens=budget)

    def run_once(self, client, system="Synthetic policy", prompt="Synthetic passage"):
        return extract_once(self.archive, client, system, prompt, self.page)

    def native(self, path):
        self.reads.append(path)
        if path.endswith("runtime-coordination/active"): return copy.deepcopy(self.active)
        if path.startswith("/api/cluster/schedule/work-queue/"): return copy.deepcopy(self.queue)
        if path.startswith("/api/analytics/inference/logs?"): return {"items": [copy.deepcopy(self.log)], "pagination": {"hasNext": False}}
        raise AssertionError(path)

    def reconcile(self):
        return record_terminal(self.directory, self.state, queue_id=self.queue_id, inference_log_id=self.log["_id"],
            terminal_file=self.terminal_file, status_file=self.status_file,
            reason="Native completion observed; unusable output retained.", authorization_ref="synthetic-session/task", call=self.native)

    def authorize(self, budget=8192):
        return authorize_retry(self.directory, self.state, max_output_tokens=budget,
            reason="Explicit linked retry with a measured output budget.", authorization_ref="synthetic-session/task")

    def test_terminal_reconciliation_preserves_exact_release_bytes_and_original_fence(self):
        row = self.reconcile()
        self.assertIn("\r\n", row["evidence"]["terminalReceiptText"])
        self.assertEqual(row, terminal_at(self.directory, self.state))
        self.assertEqual(row, self.reconcile())
        self.assertEqual(len(self.reads), 3)  # idempotence needs no additional query or model call
        self.assertEqual((self.directory / "attempt.json").read_bytes(), self.original)
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(list(self.directory.glob("terminal-check-*")))

    def test_a_terminal_native_result_can_resolve_an_old_uncaptured_format_failure(self):
        state = {**self.state, "phase": "unconfirmed", "errorType": "JSONDecodeError"}
        durable(self.directory / "attempt.json", state); self.state = state
        self.reconcile()
        held = unsettled(self.root)
        self.assertEqual(blocked_phase(held), "validation-error")
        self.assertEqual(held[0]["outcome"], "completed-invalid-output")
        with self.assertRaises(ReviewInvalidOutput): self.run_once(self.client)
        self.assertEqual(len(self.calls), 1)

    def test_a_retry_requires_explicit_terminal_reconciliation(self):
        with self.assertRaisesRegex(ValueError, "Reconcile"): self.authorize()
        self.assertFalse((self.directory / "retry-plan.json").exists())
        self.assertEqual(len(self.calls), 1)

    def test_an_authorized_child_is_a_new_linked_identity_and_replays_its_saved_result(self):
        self.reconcile(); plan = self.authorize()
        self.assertNotEqual(plan["requestId"], self.state["requestId"])
        self.assertEqual(plan, self.authorize())
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(unsettled(self.root), [])  # no child dispatch has started
        client = self.make_client({"response": '{"summary":"Synthetic retained result"}', "done": True}, 8192)
        for _ in range(2): self.assertEqual(self.run_once(client)["summary"], "Synthetic retained result")
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[-1]["telemetry"]["correlationId"], plan["requestId"])
        self.assertEqual(self.calls[-1]["options"]["num_predict"], 8192)
        self.assertEqual((self.directory / "attempt.json").read_bytes(), self.original)
        child, expected = selection(self.directory)
        self.assertEqual(child, self.directory / "retries" / hashed(plan["intent"]))
        self.assertEqual(result_file(self.root, self.page["pageId"]), child / "result.json")
        self.assertEqual(load(child / "attempt.json")["intent"], expected)
        self.assertEqual(unsettled(self.root), [])

    def test_changed_budget_policy_or_source_cannot_replace_the_authorized_child(self):
        self.reconcile(); self.authorize()
        for budget, system, prompt in ((4096, "Synthetic policy", "Synthetic passage"),
                                        (8192, "Changed policy", "Synthetic passage"),
                                        (8192, "Synthetic policy", "Changed passage")):
            with self.subTest(budget=budget, system=system, prompt=prompt), self.assertRaises(ReviewUncertain):
                self.run_once(self.make_client({"response": "{}"}, budget), system, prompt)
        self.assertEqual(len(self.calls), 1)

    def test_an_uncertain_child_blocks_every_following_dispatch(self):
        self.reconcile(); plan = self.authorize()
        client = self.make_client(TimeoutError("Synthetic transport loss"), 8192)
        for _ in range(2):
            with self.assertRaises(ReviewUncertain): self.run_once(client)
        self.assertEqual(len(self.calls), 2)
        held = unsettled(self.root)
        self.assertEqual((len(held), held[0]["requestId"], blocked_phase(held)), (1, plan["requestId"], "uncertain"))
        self.assertEqual((self.directory / "attempt.json").read_bytes(), self.original)

    def test_wrong_native_identity_status_release_or_interval_refuses_before_write(self):
        variants = [lambda: self.log.update(correlationId="secretary-review-" + "0" * 64),
                    lambda: self.log.update(status="error"), lambda: self.log.update(taskType="other"),
                    lambda: self.log.update(timestamp="2000-01-01T00:00:00Z"),
                    lambda: self.log.update(timestamp="2099-01-01T00:00:00Z"),
                    lambda: self.queue.update(state="dispatching"),
                    lambda: self.queue["releaseReceipt"].update(receiptSha256="0" * 64),
                    lambda: self.queue["releaseReceipt"].update(actor="other"),
                    lambda: self.queue["releaseReceipt"].update(operationId="other"),
                    lambda: self.queue["releaseReceipt"].update(receiptRef="other"),
                    lambda: self.queue["releaseReceipt"].update(state="completed"),
                    lambda: self.status.update(pageId="wrong-page"),
                    lambda: self.terminal.update(runtimeReleased=False),
                    lambda: self.terminal.update(contract="wrong-contract")]
        originals = copy.deepcopy((self.queue, self.log, self.status, self.terminal))
        for index, modify in enumerate(variants):
            self.queue, self.log, self.status, self.terminal = copy.deepcopy(originals)
            modify()
            # Re-sign fixture files except the intentionally bad release hash.
            if index != 6: self.refresh_receipts()
            with self.subTest(index=index), self.assertRaises(ValueError): self.reconcile()
            self.assertFalse((self.directory / "terminal-reconciliation.json").exists())

    def test_active_or_missing_native_runtime_evidence_prevents_reconciliation(self):
        for active in ({}, {**self.active, "workloads": [{"kind": "other"}]},
                       {**self.active, "inferences": [{"requestId": self.state["requestId"]}]},
                       {**self.active, "maintenance": {"actor": "other"}}):
            self.active = active
            with self.subTest(active=active), self.assertRaises(ValueError): self.reconcile()
        self.assertFalse((self.directory / "terminal-reconciliation.json").exists())

    def test_retained_structured_result_must_be_recovered_instead_of_replaced(self):
        durable(self.directory / "result.json", {"retained": True})
        with self.assertRaisesRegex(ValueError, "existing structured"): self.reconcile()
        self.assertEqual(self.reads, [])

    def test_retry_plan_and_terminal_evidence_tampering_never_dispatches(self):
        self.reconcile(); self.authorize()
        file = self.directory / "retry-plan.json"; plan = load(file)
        durable(file, {**plan, "maxOutputTokens": 16384})
        with self.assertRaises(ReviewUncertain): self.run_once(self.make_client({"response": "{}"}, 16384))
        self.assertEqual(blocked_phase(unsettled(self.root)), "uncertain")
        durable(file, plan)
        terminal = self.directory / "terminal-reconciliation.json"; row = load(terminal)
        row["evidence"]["inferenceLog"]["status"] = "error"; durable(terminal, row)
        with self.assertRaises(ReviewUncertain): self.run_once(self.make_client({"response": "{}"}, 8192))
        self.assertEqual(len(self.calls), 1)

    def test_a_different_retry_plan_cannot_overwrite_an_existing_authorization(self):
        self.reconcile(); first = self.authorize()
        with self.assertRaisesRegex(ValueError, "another intent"): self.authorize(16384)
        self.assertEqual(load(self.directory / "retry-plan.json"), first)

    def test_an_exclusive_write_race_never_overwrites_a_different_reconciliation(self):
        from review_recovery import durable as original_durable
        def race(file, row, exclusive=False):
            competing = {**row, "reason": "Other explicit operator instructions"}
            original_durable(file, competing, exclusive=True)
            original_durable(file, row, exclusive=exclusive)
        with patch("review_recovery.durable", side_effect=race), self.assertRaisesRegex(ValueError, "concurrently"):
            self.reconcile()
        self.assertEqual(load(self.directory / "terminal-reconciliation.json")["reason"], "Other explicit operator instructions")
        self.assertEqual((self.directory / "attempt.json").read_bytes(), self.original)

    def test_objective_representation_receipt_reads_the_exact_linked_child_result(self):
        import objective_review as worker
        from objective_schema import normalize_representation
        self.reconcile(); self.authorize()
        result = {"summary": "A synthetic event.", "classification": "life-events", "gaps": [], "moments": [{
            "title": "Synthetic moment", "description": "Synthetic event described by its source.", "category": "daily",
            "startDate": None, "startPrecision": "unknown", "endDate": None, "endPrecision": "unknown", "ongoing": False,
            "originalDate": "", "subject": "owner", "subjectName": "Synthetic owner", "occurrenceStatus": "reported",
            "claimType": "direct", "uncertainty": "Date unknown.", "rationale": "Explicit synthetic declaration.",
            "quotes": [self.body.replace("\r\n", "\n")], "relationHints": []}]}
        client = self.make_client({"response": json.dumps(result), "done": True}, 8192)
        self.assertEqual(self.run_once(client), result)
        normalized, changes = normalize_representation(result, self.body)
        row = {"schema": worker.CONTRACT, "objectiveSha256": self.identity["objectiveSha256"],
            "pageId": self.page["pageId"], "identity": self.identity,
            "sourceRecord": {"body": self.body, "bodySha256": self.identity["contentSha256"]}, "result": normalized,
            "resultProcessing": {"contract": "secretary.objective-representation/v1", "rawResultSha256": hashed(result), "changes": changes}}
        file = self.root / "page-reviews" / (self.page["pageId"] + ".json"); durable(file, row)
        self.assertEqual(worker.read_receipt(file, {"objectiveSha256": self.identity["objectiveSha256"]}), row)
        self.assertEqual(len(self.calls), 2)
        self.assertFalse((self.directory / "result.json").exists())


if __name__ == "__main__":
    unittest.main()
