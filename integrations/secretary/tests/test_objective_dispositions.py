import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_dispositions as dispositions
import objective_review as worker
from evidence_store import load, save
import test_objective_review as fixtures


class DispositionTests(unittest.TestCase):
    setUp = fixtures.ObjectiveTests.setUp
    mail = fixtures.ObjectiveTests.mail
    prepare = fixtures.ObjectiveTests.prepare
    run_worker = fixtures.ObjectiveTests.run_worker

    def two_sources(self):
        self.mail("message01", "Un fichier.pdf est envoyé.")
        self.mail("message02", "Aucune étape personnelle dans ce second passage.")
        self.config["selection"]["gmailMessageIds"].append("message02")
        save(self.file, self.config)

    def client(self, output=None):
        calls = []

        def opener(request, timeout):
            if request.full_url.endswith("/api/inference/generate"):
                prompt = json.loads(json.loads(request.data)["messages"][-1]["content"])
                calls.append(prompt)
                value = {"summary": "Un passage fictif lu.", "classification": "no-life-event", "moments": [], "gaps": []}
                if "fichier.pdf" in prompt["untrustedContent"]:
                    value.update(classification="life-events", moments=[fixtures.moment("Nouvelles fictives")])
                reply = {"response": json.dumps(value), "done": True, "done_reason": "stop", "eval_count": 200}
                if output:
                    reply = output(prompt, reply)
            else:
                reply = {"data": {}}
            response = MagicMock(status=200, headers={})
            response.read.return_value = json.dumps(reply).encode()
            response.__enter__.return_value = response
            return response

        return worker.CoreClient("http://core.invalid", opener=opener, schema=worker.SCHEMA), calls

    def disposition(self):
        objective, manifest = self.prepare()
        file = next((objective / "page-dispositions").glob("*.json"))
        return objective, manifest, file, load(file)

    def test_retained_subject_quote_is_skipped_without_reinference_or_coverage(self):
        self.two_sources()
        client, calls = self.client()
        self.assertEqual(self.run_worker(client)["phase"], "validation-error")
        objective, _ = self.prepare()
        result_file = next((objective / "review-attempts").glob("*/result.json"))
        original_result = result_file.read_bytes()
        original_http = result_file.with_name("response-1-http.txt").read_bytes()
        retained = self.run_worker(client, retain_rejected_pages=True, max_pages=1)
        self.assertEqual(retained["inferenceCalls"], 0)
        self.assertEqual(retained["newlyRejectedPages"], 1)
        self.assertEqual(retained["newlyReviewedPages"], 0)
        self.assertEqual(retained["processedPages"], 1)
        self.assertEqual(len(calls), 1)
        objective, manifest, file, row = self.disposition()
        before = file.read_bytes()
        self.assertEqual(row["failure"]["message"], "Every claim must quote the exact supplied passage")
        self.assertFalse(row["textCovered"])
        self.assertEqual(row["proof"]["requestId"], "secretary-review-" + row["proof"]["intentSha256"])
        self.assertEqual(row["identity"]["contentSha256"], hashlib.sha256(row["body"].encode()).hexdigest())
        self.assertEqual(dispositions.read(objective, manifest, row["pageId"]), row)
        next_run = self.run_worker(client, retain_rejected_pages=True)
        counts = next_run["coverage"]["counts"]
        self.assertEqual(len(calls), 2)
        self.assertEqual(counts["rejectedPages"], 1)
        self.assertEqual(counts["sourcesWithRejectedPages"], 1)
        self.assertEqual(counts["reviewedPages"], 1)
        self.assertEqual(counts["sourcesTextCovered"], 1)
        self.assertEqual(counts["pendingPagesKnown"], 0)
        self.assertFalse(next_run["coverage"]["allTargetTextCovered"])
        rejected_source = next(r for r in next_run["coverage"]["sources"] if r["rejectedPages"])
        self.assertEqual(rejected_source["gaps"][0]["code"], "model-output-rejected")
        self.assertFalse(rejected_source["textReviewComplete"])
        self.assertEqual(load(objective / "findings.json"), [])
        self.assertEqual(load(objective / "sources.json"), [])
        self.assertEqual(file.read_bytes(), before)
        self.assertEqual(result_file.read_bytes(), original_result)
        self.assertEqual(result_file.with_name("response-1-http.txt").read_bytes(), original_http)
        self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(len(calls), 2)

    def test_new_rejection_and_accepted_page_share_the_page_budget(self):
        self.two_sources()
        client, calls = self.client()
        first = self.run_worker(client, retain_rejected_pages=True, max_pages=1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(first["processedPages"], 1)
        self.assertEqual(first["newlyRejectedPages"], 1)
        self.assertEqual(first["newlyReviewedPages"], 0)
        second = self.run_worker(client, retain_rejected_pages=True, max_pages=1)
        self.assertEqual(second["processedPages"], 1)
        self.assertEqual(second["newlyReviewedPages"], 1)
        self.assertEqual(len(calls), 2)

    def test_known_received_truncated_json_is_retained_then_other_sources_continue(self):
        self.two_sources()
        def truncated(prompt, reply):
            if "fichier.pdf" in prompt["untrustedContent"]:
                reply.update(response='{"moments":', done_reason="length")
            return reply
        client, calls = self.client(truncated)
        self.assertEqual(self.run_worker(client)["phase"], "validation-error")
        result = self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(result["inferenceCalls"], 1)
        self.assertEqual(result["newlyRejectedPages"], 1)
        self.assertEqual(result["newlyReviewedPages"], 1)
        self.assertEqual(len(calls), 2)
        _, _, _, row = self.disposition()
        self.assertEqual(row["failure"], {"type": "ReviewInvalidOutput", "message": "incomplete-model-output"})
        self.assertEqual(row["proof"]["phase"], "invalid-output")
        self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(len(calls), 2)

    def test_transport_uncertainty_always_blocks_even_with_retain_policy(self):
        client = fixtures.Client(fail=True)
        first = self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(first["phase"], "uncertain")
        second = self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(second["phase"], "uncertain")
        self.assertEqual(len(client.calls), 1)
        objective, _ = self.prepare()
        self.assertFalse((objective / "page-dispositions").exists())

    def test_unknown_terminal_status_cannot_be_dispositioned(self):
        self.two_sources()
        client, calls = self.client(lambda prompt, reply: {**reply, "done": None})
        with self.assertRaisesRegex(ValueError, "explicit terminal"):
            self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(len(calls), 1)
        objective, _ = self.prepare()
        self.assertFalse((objective / "page-dispositions").exists())

    def test_complete_fake_result_without_native_envelope_cannot_be_dispositioned(self):
        with self.assertRaisesRegex(ValueError, "certain retained native"):
            self.run_worker(fixtures.Client(invalid=True), retain_rejected_pages=True)

    def test_integrity_and_source_failures_are_never_absorbed(self):
        self.two_sources()
        client, calls = self.client()
        self.run_worker(client, retain_rejected_pages=True, max_pages=1)
        objective, manifest, file, original = self.disposition()
        for key, mutation in [("body", "A different source passage"), ("offset", 17), ("pageId", "f" * 64)]:
            changed = copy.deepcopy(original)
            changed[key] = mutation
            save(file, changed)
            with self.assertRaises(ValueError):
                self.run_worker(client, retain_rejected_pages=True)
            self.assertEqual(len(calls), 1)
        save(file, original)
        raw = objective / original["proof"]["artifacts"][1]["path"]
        raw.write_text("corrupt exact HTTP bytes")
        with self.assertRaisesRegex(ValueError, "certain retained native"):
            worker.coverage(objective, manifest)
        self.assertEqual(len(calls), 1)

    def test_original_source_hash_failure_remains_source_error(self):
        (self.root / self.message["path"]).write_bytes(b"changed original")
        client, calls = self.client()
        result = self.run_worker(client, retain_rejected_pages=True)
        self.assertEqual(result["phase"], "source-error")
        self.assertEqual(len(calls), 0)
        objective, _ = self.prepare()
        self.assertFalse((objective / "page-dispositions").exists())

    def test_every_saved_artifact_hash_and_exact_page_scope_are_rechecked(self):
        self.two_sources()
        client, calls = self.client()
        self.run_worker(client, retain_rejected_pages=True, max_pages=1)
        objective, manifest, _, row = self.disposition()
        for artifact in row["proof"]["artifacts"]:
            file = objective / artifact["path"]
            original = file.read_bytes()
            file.write_bytes(original + b" ")
            with self.assertRaises(ValueError):
                dispositions.read(objective, manifest, row["pageId"])
            file.write_bytes(original)
        changed_identity = {**row["identity"], "offset": 9}
        with self.assertRaisesRegex(ValueError, "identity or source integrity"):
            dispositions.read(objective, manifest, row["pageId"], expected_identity=changed_identity)
        self.assertEqual(len(calls), 1)

    def test_existing_default_still_stops_on_first_rejected_result(self):
        self.two_sources()
        client, calls = self.client()
        first = self.run_worker(client)
        second = self.run_worker(client)
        self.assertEqual(first["phase"], "validation-error")
        self.assertEqual(second["phase"], "validation-error")
        self.assertEqual(len(calls), 1)
        objective, _ = self.prepare()
        self.assertFalse((objective / "page-dispositions").exists())


if __name__ == "__main__":
    unittest.main()
