from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_history_decisions import digest
from history_coverage import content_hash
from native_history_restoration_scope import capture, selection, CONTRACT, MAX_RESPONSE
from retention_plan import NATIVE_GAPS


class NativeRestorationScopeTests(unittest.TestCase):
    def setUp(self):
        self.saved, self.checks, self.members, self.pins = [], [], [], []
        for n in range(2):
            source = {"system": "gmail", "messageId": f"1234567890abcde{n}",
                      "threadId": "1234567890abcdef", "sourceSha256": "a" * 64}
            self.saved.append({**source, "schema": "agentx.secretary-retention-disposition/v2"})
            proof = {"contract": "agentx.history-preservation/v2", "reference": source,
                     "scope": "selected-original-recorded-attachments-mime-and-temporary-disk-restore",
                     "status": "verified_scope", "blockers": [], "copies": [
                         {"copy": copy, "status": "available", "machineIdSha256": machine * 64,
                          "archiveIdSha256": "e" * 64, "restoration": {"temporaryCopyRemoved": True}}
                         for copy, machine in (("primary", "c"), ("mirror", "d"))]}
            check = {"entryId": str(n + 1) * 24, "requestId": str(uuid.uuid4()),
                     "snapshotHash": digest(proof), "source": source}
            self.checks.append(check)
            self.members.append({**check, "snapshot": proof})
            self.pins.append({**check, "entryRevision": 0, "basisHash": "f" * 64, "privacyHash": "9" * 64})
        self.calls = []

    def response(self, request):
        body = json.loads(request.data)
        snapshot = {"contract": CONTRACT, "sourceSetSha256": digest([check["source"] for check in self.checks]),
                    "members": deepcopy(self.members), "pins": deepcopy(self.pins)}
        return {"ok": True, "data": {"authority": "agentx.core", "contract": CONTRACT,
            "observationId": body["observationId"], "observedAt": "2026-01-01T12:00:00.000Z",
            "status": "observed_match" if "expected" in body else "observed",
            "consistency": "retained-restoration-rechecks-with-final-core-fence",
            "coverage": "complete-selected-source-set", "atomicBatch": False, "semanticAcceptance": False,
            "authenticatedPerson": None, "executionAllowed": False, "cleanupStatus": "blocked",
            "nativeValidationGaps": list(NATIVE_GAPS), "snapshot": snapshot, "fingerprint": digest(snapshot)}}

    def opener(self, mutate=None):
        def open_(request, timeout):
            self.calls.append(request)
            self.assertEqual(timeout, 960)
            self.assertTrue(request.full_url.endswith('/api/secretary/history/preservation-scope'))
            value = self.response(request)
            if mutate:
                mutate(value["data"], len(self.calls))
            return io.BytesIO(json.dumps(value).encode())
        return open_

    def run_capture(self, mutate=None, checks=None):
        return capture("http://core.invalid", self.saved, self.checks if checks is None else checks,
                       opener=self.opener(mutate))

    def test_complete_coverage_two_fresh_observations_bind_original_dispositions(self):
        result = self.run_capture(checks=list(reversed(self.checks)))
        self.assertEqual(len(self.calls), 2)
        self.assertNotEqual(result["initialObservationId"], result["observationId"])
        self.assertEqual(result["savedDispositionsSha256"], content_hash(self.saved))
        self.assertEqual(result["status"], "observed_match")
        self.assertFalse(result["executionAllowed"])
        self.assertEqual(result["nativeValidationGaps"], list(NATIVE_GAPS))
        self.assertEqual(json.loads(self.calls[1].data)["expected"], result["fingerprint"])

    def test_missing_extra_duplicate_and_wrong_source_receipts_refuse_before_http(self):
        invalid = [[], self.checks[:1], self.checks + self.checks[:1], [self.checks[0], self.checks[0]],
                   [{**self.checks[0], "source": {**self.checks[0]["source"], "sourceSha256": "b" * 64}}, self.checks[1]],
                   [{**self.checks[0], "approved": True}, self.checks[1]],
                   [{**self.checks[0], "requestId": "wrong"}, self.checks[1]]]
        for checks in invalid:
            with self.subTest(checks=checks), self.assertRaises(ValueError):
                self.run_capture(checks=checks)
        self.assertEqual(self.calls, [])

    def test_old_contracts_incomplete_members_and_false_acceptance_claims_refuse(self):
        mutations = [lambda v: v.update(contract="old"), lambda v: v.update(observationId=str(uuid.uuid4())),
                     lambda v: v.update(status="changed"), lambda v: v.update(executionAllowed=True),
                     lambda v: v.update(semanticAcceptance=True), lambda v: v.update(atomicBatch=True),
                     lambda v: v.update(authenticatedPerson="unverified"), lambda v: v.pop("authenticatedPerson"),
                     lambda v: v.update(nativeValidationGaps=[]), lambda v: v.update(fingerprint="0" * 64),
                     lambda v: v.update(observedAt="yesterday"),
                     lambda v: v["snapshot"]["members"].pop(), lambda v: v["snapshot"]["pins"].pop(),
                     lambda v: v["snapshot"].update(sourceSetSha256="0" * 64),
                     lambda v: v["snapshot"]["pins"][0].update(entryRevision=True),
                     lambda v: v["snapshot"]["members"][0].update(snapshotHash="0" * 64)]
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                self.run_capture(lambda value, _: mutate(value))

    def test_recomputed_envelope_cannot_hide_wrong_retained_proof(self):
        def change(value, _):
            value["snapshot"]["members"][0]["snapshot"]["contract"] = "agentx.history-preservation/v1"
            value["fingerprint"] = digest(value["snapshot"])
        with self.assertRaisesRegex(ValueError, "byte-only"):
            self.run_capture(change)

    def test_different_native_snapshot_on_second_observation_refuses(self):
        def change(value, count):
            if count == 2:
                value["snapshot"]["pins"][0]["basisHash"] = "0" * 64
                value["fingerprint"] = digest(value["snapshot"])
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            self.run_capture(change)

    def test_copy_failures_with_matching_retained_hashes_are_still_refused(self):
        for kind in ("same_machine", "different_archive", "not_removed", "unavailable"):
            self.setUp()
            proof = self.members[1]["snapshot"]
            if kind == "same_machine":
                proof["copies"][1]["machineIdSha256"] = proof["copies"][0]["machineIdSha256"]
            if kind == "different_archive":
                proof["copies"][0]["archiveIdSha256"] = "0" * 64
            if kind == "not_removed":
                proof["copies"][0]["restoration"]["temporaryCopyRemoved"] = False
            if kind == "unavailable":
                proof["copies"][0]["status"] = "unavailable"
            for row in (self.checks[1], self.members[1], self.pins[1]):
                row["snapshotHash"] = digest(proof)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.run_capture()

    def test_http_failure_malformed_ambiguous_and_over_capacity_responses_refuse(self):
        cases = [b'{"ok":true,"ok":false}', b'{"data":NaN}', b'bad-json', b'x' * (MAX_RESPONSE + 1)]
        for raw in cases:
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                capture("http://core.invalid", self.saved, self.checks, opener=lambda *a, **kw: io.BytesIO(raw))
        def offline(*args, **kwargs):
            raise urllib.error.URLError("Synthetic private detail")
        with self.assertRaisesRegex(ValueError, "unavailable") as caught:
            capture("http://core.invalid", self.saved, self.checks, opener=offline)
        self.assertNotIn("private detail", str(caught.exception))


if __name__ == '__main__':
    unittest.main()
