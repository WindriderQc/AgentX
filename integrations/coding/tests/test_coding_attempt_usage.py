import unittest
from integrations.coding.coding_attempt_usage import attempt_usage
from integrations.coding.coding_dispatch_evidence import build_attempt_evidence


class CodingAttemptUsageTests(unittest.TestCase):
    def test_failed_attempt_keeps_tokens_and_core_effective_model_without_money(self):
        evidence = build_attempt_evidence(duration_ms=123, verification_status="failed",
            failures=["worker_process_failed"], cost_observation={"calls": 2, "models": ["agentx-pipeline"],
                "inputTokens": 30, "outputTokens": 5, "cacheReadTokens": 0, "totalTokens": 35,
                "costStatus": "unknown", "tokenStatus": "complete"},
            attribution_lease={"requestCount": 2, "effectiveModel": "actual-model"})
        self.assertEqual(evidence["usage"]["effectiveModel"], "actual-model")
        self.assertEqual(evidence["usage"]["modelCalls"], 2)
        self.assertEqual(evidence["usage"]["totalTokens"], 35)
        self.assertIsNone(evidence["usage"]["costNanodollars"])

    def test_unknown_usage_never_turns_into_zero_or_a_planned_model(self):
        self.assertEqual(attempt_usage(None), {"inputTokens": None, "outputTokens": None,
            "cacheReadTokens": None, "totalTokens": None, "modelCalls": None,
            "tokenStatus": "unknown", "effectiveModel": None})
        self.assertIsNone(attempt_usage({"models": ["agentx-pipeline"]})["effectiveModel"])
        self.assertIsNone(attempt_usage({"models": ["a", "b"]}, attribution={
            "requestCount": 1, "effectiveModel": "a"})["effectiveModel"])
