import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("coding_progress", Path(__file__).resolve().parents[1] / "coding_progress.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
KEY = "11111111-2222-4333-8444-555555555555"


class ProgressTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        module.git(self.workspace, "init", "--quiet")
        (self.workspace / "README.md").write_text("Source A")
        module.git(self.workspace, "add", "README.md")
        self.clock = [0]
        self.heartbeats = []
        self.progress = module.Progress("0001", KEY, receipts=self.root / "receipts", now=lambda: self.clock[0],
                                        heartbeat=lambda: self.heartbeats.append(self.clock[0]))
        self.progress.phase = "running"
        self.progress.baseline(self.root, self.workspace)

    def test_model_liveness_does_not_extend_budget_without_useful_progress(self):
        self.clock[0] = 7199
        self.progress.event({"type": "assistant/chunk", "data": {"chunk": "Synthetic private model text"}})
        self.clock[0] = 7200
        self.assertEqual(self.progress.tick(), "soft_budget_no_progress")
        self.assertEqual(self.progress.last_useful, 0)

    def test_new_source_extends_soft_budget_but_cannot_cross_hard_ceiling(self):
        self.clock[0] = 7100
        self.progress.set_stage("model_wait")
        (self.workspace / "README.md").write_text("Source B")
        self.progress.tick(self.root, self.workspace)
        self.clock[0] = 7201
        self.assertIsNone(self.progress.tick())
        self.assertEqual(self.progress.extensions, 1)
        self.assertGreater(self.progress.soft_deadline, 7201)
        self.clock[0] = 14400
        self.assertEqual(self.progress.tick(), "hard_budget")

    def test_cache_churn_touches_and_repeated_source_states_are_not_progress(self):
        for name in [".npmcache/cache", ".lab/probe", "nested/session.jsonl"]:
            path = self.workspace / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("Private fixture")
        self.clock[0] = 10
        os.utime(self.workspace / "README.md", None)
        self.progress.tick(self.root, self.workspace)
        self.assertEqual(self.progress.last_useful, 0)
        (self.workspace / "README.md").write_text("Source B")
        self.progress.tick(self.root, self.workspace)
        self.clock[0] = 20
        (self.workspace / "README.md").write_text("Source A")
        self.progress.tick(self.root, self.workspace)
        self.assertEqual(self.progress.last_useful, 10)

    def call(self, call_id="1", command="node scripts/run-jest.js tests/unit/fixture.test.js"):
        self.progress.event({"type": "tool/call", "data": {"callId": call_id, "name": "bash",
                            "arguments": json.dumps({"command": command})}})

    def result(self, call_id="1", content="3 passed", error=False):
        self.progress.event({"type": "tool/result", "data": {"message": {
            "source": {"callId": call_id}, "content": [{"type": "tool-result", "isError": error,
            "content": [{"type": "text", "text": content}]}]}}})

    def test_installed_dsh_json_arguments_and_nested_test_results_are_correlated(self):
        self.clock[0] = 10
        self.call()
        self.assertEqual((self.progress.stage, self.progress.current_test), ("test", "jest"))
        self.result("another-call", "irrelevant")
        self.assertEqual(self.progress.stage, "test")
        self.result(content="Synthetic private fixture\n[exit code: 1]")
        self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "failed"})
        self.assertEqual(self.progress.last_useful, 10)
        self.clock[0] = 20
        self.call("2")
        self.result("2", "Same failure, different timing\n[exit code: 1]")
        self.assertEqual(self.progress.last_useful, 10)
        self.progress.write()
        self.assertNotIn("private", self.progress.path.read_text())
        self.assertNotIn("command", self.progress.path.read_text())

    def test_v4_session_generation_and_first_class_tool_results_are_observed(self):
        directory = self.root / '.dsh/progress-sessions/project/session'
        directory.mkdir(parents=True)
        stale = {'type': 'tool/call', 'data': {'callId': 'stale', 'name': 'bash',
                                             'arguments': {'command': 'node --test stale.test.js'}}}
        (directory / 'session.jsonl').write_text(json.dumps(stale) + '\n')
        events = [
            {'type': 'tool/call', 'data': {'callId': 'current', 'name': 'bash',
                'arguments': {'command': 'node --test current.test.js'}}},
            {'type': 'tool/result', 'data': {'message': {'role': 'tool', 'toolCallId': 'current',
                'source': {'kind': 'tool', 'callId': 'current'}, 'isError': False,
                'content': [{'type': 'text', 'text': '# pass 3\n# fail 0'}]}}},
        ]
        log = directory / 'session.v4.jsonl'
        log.write_text(''.join(json.dumps(event) + '\n' for event in events))
        self.clock[0] = 10
        self.progress.scan(self.root, self.workspace)
        self.assertEqual(self.progress.last_test, {'name': 'node_test', 'outcome': 'passed'})
        self.assertFalse(self.progress.pending_tests)
        self.assertEqual(self.progress.last_useful, 10)
        self.clock[0] = 20
        self.progress.baseline(self.root, self.workspace)
        self.progress.scan(self.root, self.workspace)
        self.assertEqual(self.progress.last_useful, 10)
        self.assertTrue(module.artifact('nested/session.v4.jsonl'))
        self.assertTrue(module.artifact('nested/session.v4.jsonl.zstd'))
        self.assertFalse(module.artifact('nested/session-source.jsonl'))
        self.assertTrue(module.artifact('.review-work/DOCUMENTATION_PEER_REVIEW.md'))
        self.assertTrue(module.artifact('nested/.review-work/REVIEW.md'))
        self.assertFalse(module.artifact('docs/review-work.md'))

    def test_v4_invalid_call_identity_cannot_credit_a_test(self):
        self.call('expected')
        for call_id, source in [('expected', {'callId': 'different'}), (['expected'], {})]:
            self.progress.event({'type': 'tool/result', 'data': {'message': {
                'toolCallId': call_id, 'source': source, 'content': [{'type': 'text', 'text': 'OK'}]}}})
        self.assertEqual(self.progress.last_test, None)
        self.assertTrue(self.progress.pending_tests)

    def test_native_jest_and_encoded_harness_results_charge_tests_without_masking_failure(self):
        command = "/opt/node/bin/node benchmark/node_modules/jest/bin/jest.js --config /opt/coding/jest.benchmark.config.cjs --runInBand 2>&1 | tail -60"
        self.clock[0] = 10
        self.call(command=command)
        self.assertEqual((self.progress.stage, self.progress.current_test), ("test", "jest"))
        self.clock[0] = 13
        content = json.dumps([{"type": "tool-result", "isError": False, "content": [
            {"type": "text", "text": "FAIL synthetic.test.js\nTests: 7 failed, 38 passed\nPrivate fixture"}]}])
        self.progress.event({"type": "tool/result", "data": {"message": {
            "source": {"callId": "1"}, "content": content}}})
        self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "failed"})
        self.assertEqual(self.progress.usage()["testSeconds"], 3)
        self.assertEqual(self.progress.last_useful, 13)
        self.progress.write()
        self.assertNotIn("Private fixture", self.progress.path.read_text())
        self.assertNotIn("--config", self.progress.path.read_text())

    def test_encoded_tool_error_cannot_be_reported_as_passing_from_successful_shell(self):
        self.call()
        content = json.dumps([{"type": "tool-result", "isError": True,
                               "content": [{"type": "text", "text": "Synthetic execution error"}]}])
        self.progress.event({"type": "tool/result", "data": {"message": {
            "source": {"callId": "1"}, "content": content}}})
        self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "failed"})

    def test_output_filters_and_log_paths_cannot_credit_the_same_test_failure_again(self):
        self.progress.carry({"remaining": {"workSeconds": 5000, "modelSeconds": 600,
                                           "modelCalls": 40, "testSeconds": 100},
                             "limits": {"noProgressSeconds": 60}})
        invocation = ("cd /workspace && /opt/node/bin/node benchmark/node_modules/jest/bin/jest.js "
                      "--config /opt/coding/jest.benchmark.config.cjs --runInBand")
        suffixes = [" 2>&1 | tail -60", " 2>&1 | grep -E '^Tests:|Suites:' | head -100",
                    " 2>&1 > /tmp/second.log; wc -l /tmp/second.log", " > '/tmp/third log' 2>&1",
                    " > /tmp/first\\ log 2>&1", " > /tmp/second\\ log 2>&1"]
        for index, suffix in enumerate(suffixes):
            self.clock[0] = 10 + index * 15
            self.call(str(index), invocation + suffix)
            self.clock[0] += 3
            self.result(str(index), "FAIL synthetic.test.js\nTests: 15 failed, 44 passed")
            self.assertEqual(self.progress.last_useful, 13)
        self.assertEqual(self.progress.usage()["testSeconds"], 18)
        self.assertEqual(len(self.progress.seen_tests), 1)
        self.clock[0] = 95
        self.assertEqual(self.progress.tick(), "no_useful_progress")

    def test_changed_selectors_and_source_keep_useful_test_progress(self):
        for index, pattern in enumerate(["'a|b'", "'>'", "'<'"]):
            self.clock[0] = 10 + index * 10
            self.call(str(index), "node scripts/run-jest.js --testNamePattern " + pattern + " 2>&1 | tail -60")
            self.result(str(index), "FAIL synthetic.test.js")
            self.assertEqual(self.progress.last_useful, self.clock[0])
        (self.workspace / "README.md").write_text("Source B")
        self.progress.scan(self.root, self.workspace)
        self.clock[0] = 40
        self.call("changed-source", "node scripts/run-jest.js --testNamePattern '<' 2>&1 | head -20")
        self.result("changed-source", "FAIL synthetic.test.js")
        self.assertEqual(self.progress.last_useful, 40)

    def test_test_arguments_after_redirection_and_execution_context_are_preserved(self):
        pairs = [
            ("node scripts/run-jest.js --seed 2 > /tmp/a", "node scripts/run-jest.js --seed 3 > /tmp/b"),
            ("node scripts/run-jest.js > /tmp/a --testNamePattern one",
             "node scripts/run-jest.js > /tmp/a --testNamePattern two"),
            ("MODE=one node scripts/run-jest.js", "MODE=two node scripts/run-jest.js"),
            ("cd one && node scripts/run-jest.js", "cd two && node scripts/run-jest.js"),
            ("node scripts/run-jest.js < input-one", "node scripts/run-jest.js < input-two"),
            ("node scripts/run-jest.js | node other-test.js", "node scripts/run-jest.js | tail -20"),
        ]
        for left, right in pairs:
            with self.subTest(left=left):
                self.assertNotEqual(module.test_identity(left), module.test_identity(right))

    def test_expansions_and_additional_executors_cannot_be_deduplicated_as_display(self):
        prefix = "node scripts/run-jest.js "
        pairs = [
            ("--testNamePattern '$CASE'", '--testNamePattern "$CASE"'),
            ("tests/*.test.js", "'tests/*.test.js'"),
            ("tests/{a,b}.test.js", "'tests/{a,b}.test.js'"),
            ("--testNamePattern #case", "--testNamePattern '#case'"),
            ("--testNamePattern one&node other-test.js", "--testNamePattern 'one&node' other-test.js"),
            ("--testNamePattern case(foo)", "--testNamePattern 'case(foo)'"),
            ("0>&1", ""),
            ("3>&1", ""),
            ("10>&1", ""),
            ("| tail -20|node other-test.js", "| tail -20"),
            ("| tail -20\nnode other-test.js", "| tail -20"),
            ("| awk 'BEGIN {system(\"node other-test.js\")}'", "| tail -20"),
            ("| sed 'e node other-test.js'", "| tail -20"),
            ("| ./tail -20", "| tail -20"),
        ]
        for left, right in pairs:
            with self.subTest(left=left):
                self.assertNotEqual(module.test_identity(prefix + left), module.test_identity(prefix + right))

    def test_timed_native_jest_charges_budget_while_a_filtered_result_stays_unknown(self):
        command = ("cd /workspace && TEST_RUN_ID=synthetic timeout 240 /opt/node/bin/node "
                   "core/node_modules/jest/bin/jest.js --runInBand > /tmp/synthetic-test.log 2>&1; "
                   "echo status=$?")
        self.clock[0] = 10
        self.call(command=command)
        self.assertEqual((self.progress.stage, self.progress.current_test), ("test", "jest"))
        self.clock[0] = 250
        self.result(content="[timed out after 240 seconds]")
        self.assertEqual(self.progress.usage()["testSeconds"], 240)
        self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "unknown"})
        self.assertIsNone(self.progress.progress_at)

    def test_timeout_wrappers_recognize_tests_without_promoting_mentions_or_bad_options(self):
        for prefix in ["timeout 240", "/usr/bin/timeout -k 30 4m", "timeout --signal TERM -- 240",
                       "timeout --foreground --preserve-status --kill-after=30s --signal=9 240"]:
            with self.subTest(prefix=prefix):
                self.assertEqual(module.test_kind(prefix + " node core/node_modules/jest/bin/jest.js"), "jest")
                self.assertEqual(module.test_kind(prefix + " python3 -m unittest"), "unittest")
        for command in ["echo timeout 240 node core/node_modules/jest/bin/jest.js",
                        "timeout 240 echo node core/node_modules/jest/bin/jest.js",
                        "timeout --help node core/node_modules/jest/bin/jest.js",
                        "timeout --signal=NOTASIGNAL 240 node core/node_modules/jest/bin/jest.js",
                        "timeout --kill-after=bad 240 node core/node_modules/jest/bin/jest.js",
                        "timeout -k 30", "timeout nope node core/node_modules/jest/bin/jest.js",
                        "timeout 240 node synthetic.js core/node_modules/jest/bin/jest.js"]:
            with self.subTest(command=command):
                self.assertIsNone(module.test_kind(command))

    def test_running_timed_test_stops_at_the_remaining_native_test_budget(self):
        self.progress.carry({"remaining": {"workSeconds": 5000, "modelSeconds": 600,
                                           "modelCalls": 40, "testSeconds": 30},
                             "limits": {"noProgressSeconds": 2700}})
        self.call(command="timeout 240 node core/node_modules/jest/bin/jest.js --runInBand")
        self.clock[0] = 29
        self.assertIsNone(self.progress.tick())
        self.clock[0] = 30
        self.assertEqual(self.progress.tick(), "hard_budget")
        self.assertEqual(self.progress.usage()["testSeconds"], 30)
        self.assertIsNone(self.progress.progress_at)

    def test_native_timeout_exit_cannot_credit_progress_or_discard_real_test_failures(self):
        for index, code in enumerate([124, 125, 126, 127, 137, 143]):
            with self.subTest(code=code):
                self.call(str(index), "timeout 240 node core/node_modules/jest/bin/jest.js --runInBand")
                self.clock[0] += 10
                self.result(str(index), f"Synthetic wrapper termination\n[exit code: {code}]", error=True)
                self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "unknown"})
                self.assertIsNone(self.progress.progress_at)
        self.assertEqual(self.progress.usage()["testSeconds"], 60)
        self.call("real-test", "timeout 240 node core/node_modules/jest/bin/jest.js --runInBand")
        self.result("real-test", "FAIL synthetic.test.js\n[exit code: 1]", error=True)
        self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "failed"})
        self.assertEqual(self.progress.last_useful, 60)
        self.call("unwrapped", "node core/node_modules/jest/bin/jest.js --runInBand")
        self.result("unwrapped", "[exit code: 124]", error=True)
        self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "failed"})

    def test_oversized_native_exit_marker_releases_the_correlated_test_stage(self):
        self.call(command="timeout 240 node core/node_modules/jest/bin/jest.js --runInBand")
        self.clock[0] = 10
        self.result(content="[exit code: " + "9" * 5000 + "]", error=True)
        self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "unknown"})
        self.assertEqual(self.progress.pending_tests, {})
        self.assertIsNone(self.progress.current_test)
        self.assertEqual(self.progress.stage, "model_wait")
        self.assertEqual(self.progress.usage()["testSeconds"], 10)
        self.assertIsNone(self.progress.progress_at)

    def test_native_jest_detection_and_json_decoder_do_not_promote_mentions_or_arbitrary_json(self):
        for command in ["echo node benchmark/node_modules/jest/bin/jest.js",
                        "node synthetic.js benchmark/node_modules/jest/bin/jest.js"]:
            self.assertIsNone(module.test_kind(command))
        content = json.dumps({"output": "Test Suites: 3 passed"})
        self.assertEqual(module.message_text({"content": content}), content)
        self.assertEqual(module.test_outcome(content, False, False), "unknown")
        # JSON decoder depth varies across Python versions. Exercise its refusal
        # deterministically; the real accepted/deep harness case is tested below.
        with mock.patch.object(module.json, "loads", side_effect=RecursionError):
            self.assertEqual(module.tool_message({"content": "synthetic"}), ("", False, False))

    def test_deep_encoded_harness_is_unknown_without_stopping_session_scan(self):
        content = [{"type": "text", "text": "OK"}]
        for _ in range(350):
            content = [{"type": "tool-result", "content": content}]
        encoded = json.dumps(content)
        self.assertIsInstance(json.loads(encoded), list)
        log = self.root / ".dsh/progress-sessions/project/session/session.jsonl"
        log.parent.mkdir(parents=True)
        events = [
            {"type": "tool/call", "data": {"callId": "1", "name": "bash", "arguments": {
                "command": "node benchmark/node_modules/jest/bin/jest.js --runInBand"}}},
            {"type": "tool/result", "data": {"message": {"source": {"callId": "1"}, "content": encoded}}},
            {"type": "assistant/chunk", "data": {"chunk": "Synthetic private text"}},
        ]
        log.write_text("".join(json.dumps(event) + "\n" for event in events))
        self.clock[0] = 10
        self.progress.scan(self.root, self.workspace)
        self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "unknown"})
        self.assertEqual(self.progress.stage, "model_generation")
        self.assertIsNone(self.progress.progress_at)

    def test_invalid_text_and_blocks_cannot_receive_successful_exit_credit(self):
        for index, content in enumerate([
            [{"type": "text", "text": 7}], [{"type": "text", "text": {"output": "OK"}}],
            [{"type": "text", "text": "OK"}, 7], [{"type": [], "text": "OK"}],
            [{"type": "tool-result", "isError": "false", "content": "OK"}],
        ]):
            with self.subTest(content=content):
                self.call(str(index))
                self.progress.event({"type": "tool/result", "data": {"message": {
                    "source": {"callId": str(index)}, "content": json.dumps(content)}}})
                self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "unknown"})
                self.assertIsNone(self.progress.progress_at)

    def test_nested_harness_error_is_retained_and_text_remains_private(self):
        self.call()
        content = [{"type": "tool-result", "content": [{"type": "tool-result", "isError": True,
                   "content": [{"type": "text", "text": "Synthetic private error"}]}]}]
        self.progress.event({"type": "tool/result", "data": {"message": {
            "source": {"callId": "1"}, "content": json.dumps(content)}}})
        self.assertEqual(self.progress.last_test, {"name": "jest", "outcome": "failed"})
        self.progress.write()
        self.assertNotIn("Synthetic private error", self.progress.path.read_text())

    def test_incomplete_session_record_is_retried_and_old_history_is_not_replayed(self):
        log = self.root / ".dsh/progress-sessions/project/session/session.jsonl"
        log.parent.mkdir(parents=True)
        log.write_text(json.dumps({"type": "tool/call", "data": {"name": "bash", "callId": "old", "arguments": "{}"}}) + "\n")
        self.progress.baseline(self.root, self.workspace)
        event = json.dumps({"type": "assistant/chunk", "data": {"chunk": "Private fixture"}})
        with log.open("a") as stream:
            stream.write(event[:20])
        self.progress.scan(self.root, self.workspace)
        self.assertEqual(self.progress.stage, "preparing")
        with log.open("a") as stream:
            stream.write(event[20:] + "\n")
        self.progress.scan(self.root, self.workspace)
        self.assertEqual(self.progress.stage, "model_generation")

    def test_actual_relay_requests_have_a_bound_and_heartbeat_is_independent(self):
        for _ in range(128):
            self.progress.model_events.put("model_request")
        self.assertEqual(self.progress.tick(), "model_call_limit")
        self.assertEqual(self.progress.model_calls, 128)
        self.assertEqual(self.heartbeats, [0])
        self.assertIsNone(self.progress.progress_at)

    def test_stage_limits_allow_a_long_test_and_stop_a_stalled_tool(self):
        self.call()
        self.clock[0] = 1800
        self.assertIsNone(self.progress.tick())
        self.clock[0] = 2400
        self.assertEqual(self.progress.tick(), "test_inactive")

    def test_reading_and_new_model_waits_cannot_reset_useful_progress_limit(self):
        for minute in range(45):
            self.clock[0] = minute * 60
            self.progress.model_events.put("model_request")
            self.progress.event({"type": "tool/call", "data": {"name": "bash", "arguments": {"command": "cat README.md"}}})
            self.progress.event({"type": "tool/result", "data": {"message": {}}})
            self.assertIsNone(self.progress.tick())
        self.clock[0] = 45 * 60
        self.progress.model_events.put("model_request")
        self.assertEqual(self.progress.tick(), "no_useful_progress")
        self.assertEqual(self.progress.extensions, 0)

    def test_stop_receipt_matches_both_identities_and_survives_budget_checks(self):
        self.progress.stop_path.write_text(json.dumps({"requestId": KEY, "pipelineId": "0002"}))
        self.assertIsNone(self.progress.tick())
        self.progress.stop_path.write_text(json.dumps({"requestId": KEY, "pipelineId": "0001"}))
        self.clock[0] = 15000
        self.assertEqual(self.progress.tick(), "operator_stop")
        self.progress.finish("blocked")
        self.assertEqual(module.safe_progress(json.loads(self.progress.path.read_text()), KEY, "0001")["stopReason"], "operator_stop")

    def test_projection_rejects_foreign_identity_and_removes_unknown_nested_data(self):
        self.progress.finish("blocked", "worker_exit", "a" * 40)
        value = json.loads(self.progress.path.read_text())
        value.update(command="private-fixture", checkpoint="/private/fixture", rawOutput="private-fixture")
        value["lastTest"] = {"name": "jest", "outcome": "passed", "output": "private-fixture"}
        safe = module.safe_progress(value, KEY, "0001")
        self.assertNotIn("private-fixture", json.dumps(safe))
        self.assertIsNone(safe["checkpoint"])
        self.assertIsNone(module.safe_progress(value, KEY, "0002"))
        self.assertEqual(self.progress.path.stat().st_mode & 0o777, 0o600)
        value.update(stopReason={}, currentTest=[])
        value["lastTest"] = {"name": [], "outcome": {}}
        self.assertIsNone(module.safe_progress(value, KEY, "0001")["lastTest"])
        value["stage"] = []
        self.assertIsNone(module.safe_progress(value, KEY, "0001"))

    def test_echoing_test_names_is_not_test_evidence(self):
        self.assertIsNone(module.test_kind("echo pytest"))
        self.assertEqual(module.test_kind("cd core && node scripts/run-jest.js fixture.test.js"), "jest")

    def test_a_piped_failure_is_not_a_pass_from_tail_exit_zero(self):
        self.call(command="python3 -m unittest discover -v 2>&1 | tail -40")
        self.result(content="Ran 31 tests in 2.9s\n\nFAILED (failures=1)", error=False)
        self.assertEqual(self.progress.last_test["outcome"], "failed")
        for summary in ["Test Suites: 1 failed, 2 passed, 3 total", "Tests: 1 failed, 2 passed, 3 total",
                        "=== 1 failed, 2 passed in 1s ===", "# fail 1"]:
            self.assertEqual(module.test_outcome(summary, False, False), "failed")

    def test_a_filtered_test_needs_an_observed_summary(self):
        self.call(command="python3 -m unittest discover -v 2>&1 | head -2")
        self.result(content="test_fixture ...")
        self.assertEqual(self.progress.last_test["outcome"], "unknown")
        self.assertIsNone(self.progress.progress_at)
        self.call("2", "python3 -m unittest discover -v 2>&1 | tail -40")
        self.result("2", "Ran 31 tests in 2.9s\n\nOK")
        self.assertEqual(self.progress.last_test["outcome"], "passed")

    def test_model_reserve_stops_worker_before_cumulative_hard_ceiling(self):
        self.progress.model_worker_active = True
        self.progress.carry({"remaining": {"workSeconds": 5000, "modelSeconds": 600, "modelCalls": 40, "testSeconds": 500},
            "limits": {"noProgressSeconds": 2700}})
        self.progress.set_stage("model_wait")
        self.clock[0] = 479
        self.assertIsNone(self.progress.tick())
        self.clock[0] = 480
        self.assertEqual(self.progress.tick(), "model_budget_reserve")
        self.assertEqual(self.progress.model_remaining(), 120)
        self.assertEqual(self.progress.usage()["modelSeconds"], 480)

    def test_explicit_progress_window_changes_only_timer_without_adding_work_credit(self):
        self.progress.carry({"remaining": {"workSeconds": 5000, "modelSeconds": 600, "modelCalls": 40, "testSeconds": 500},
            "limits": {"noProgressSeconds": 2700}, "spent": {"workSeconds": 5000},
            "lastUsefulWorkSeconds": 100, "progressWindowStartedAtWorkSeconds": 5000})
        self.assertIsNone(self.progress.tick())
        self.assertEqual(self.progress.prior_work, 5000)
        self.assertEqual(self.progress.useful_work, 100)
        self.assertEqual(json.loads(self.progress.path.read_text())["lastUsefulWorkSeconds"], 100)
        self.assertEqual(self.progress.usage()["workSeconds"], 0)

    def test_independent_verification_can_run_without_spending_model_reserve(self):
        self.progress.carry({"remaining": {"workSeconds": 5000, "modelSeconds": 600, "modelCalls": 40, "testSeconds": 500},
            "limits": {"noProgressSeconds": 2700}})
        self.progress.stage_spent["modelSeconds"] = 500
        self.progress.set_stage("test")
        self.clock[0] = 10
        self.assertIsNone(self.progress.tick())
        self.assertEqual(self.progress.model_remaining(), 100)
        self.assertEqual(self.progress.usage()["testSeconds"], 10)

    def test_live_budget_guidance_tracks_time_without_granting_progress_or_changing_accounting(self):
        self.progress.phase='preparing'
        self.assertIsNone(self.progress.model_guidance())
        self.progress.phase='running'
        self.progress.carry({"remaining": {"workSeconds": 5000, "modelSeconds": 600, "modelCalls": 40, "testSeconds": 500},
                             "limits": {"noProgressSeconds": 2700}})
        self.progress.set_stage("model_wait")
        self.clock[0] = 100
        before = (self.progress.accounted_at, dict(self.progress.stage_spent), self.progress.last_useful)
        text = self.progress.model_guidance()
        remaining = json.loads(text[text.index("{"):text.index("}") + 1])
        self.assertEqual(remaining, {"workSeconds": 4900, "modelSeconds": 500, "modelCalls": 40,
                                     "testSeconds": 500, "noProgressSeconds": 2600})
        self.assertEqual(before, (self.progress.accounted_at, self.progress.stage_spent, self.progress.last_useful))
        self.assertIsNone(self.progress.progress_at)
        self.clock[0] = 200
        self.progress.set_stage("test")
        self.clock[0] = 230
        text = self.progress.model_guidance()
        remaining = json.loads(text[text.index("{"):text.index("}") + 1])
        self.assertEqual((remaining["modelSeconds"], remaining["testSeconds"]), (400, 470))
        self.progress.stop_reason = "operator_stop"
        self.assertIsNone(self.progress.model_guidance())

    def test_manual_code_advice_exposes_independent_call_and_time_limits_without_granting_progress(self):
        self.progress.phase='running';self.progress.model_calls=123;self.clock[0]=100
        before=(self.progress.accounted_at,dict(self.progress.stage_spent),self.progress.last_useful,self.progress.hard_deadline,self.progress.path.read_bytes())
        advice=self.progress.model_guidance();remaining=json.loads(advice[advice.index('{'):advice.index('}')+1])
        self.assertEqual(remaining['modelCalls'],5);self.assertIn('end now',advice);self.assertIn('count can lag',advice)
        self.assertNotIn('Core enforces',advice)
        self.assertEqual(before,(self.progress.accounted_at,dict(self.progress.stage_spent),self.progress.last_useful,self.progress.hard_deadline,self.progress.path.read_bytes()))

    def test_report_advice_exposes_call_limit_and_time_without_crediting_progress(self):
        self.progress.report_mode = True
        self.progress.set_stage("model_wait")
        self.clock[0] = 100
        before = (self.progress.accounted_at, dict(self.progress.stage_spent), self.progress.last_useful,
                  self.progress.hard_deadline, self.progress.soft_deadline, self.progress.path.read_bytes())
        for calls, expected in [(117, 11), (127, 1), (128, 0), (129, 0)]:
            self.progress.model_calls = calls
            text = self.progress.model_guidance()
            remaining = json.loads(text[text.index("{"):text.index("}") + 1])
            self.assertEqual(remaining, {"workSeconds": 14300, "softSeconds": 7100,
                                         "modelCalls": expected, "noProgressSeconds": 2600})
            self.assertIn("estimate", text); self.assertIn("count can lag", text)
            self.assertIn("read-only", text); self.assertIn("private Markdown report", text)
            self.assertNotIn("source correction", text); self.assertNotIn("focused tests", text)
            self.assertEqual("end now" in text, expected <= 8)
            self.assertEqual(self.progress.model_calls, calls)
            self.assertEqual(before, (self.progress.accounted_at, self.progress.stage_spent, self.progress.last_useful,
                                     self.progress.hard_deadline, self.progress.soft_deadline, self.progress.path.read_bytes()))
        self.assertIsNone(self.progress.progress_at)
        self.assertEqual(self.heartbeats, [])

    def test_report_advice_does_not_change_stops_or_expose_negative_allowances(self):
        self.progress.report_mode = True
        self.clock[0] = 14401
        text = self.progress.model_guidance()
        remaining = json.loads(text[text.index("{"):text.index("}") + 1])
        self.assertEqual(remaining["workSeconds"], 0)
        self.assertEqual(remaining["softSeconds"], 0)
        self.assertEqual(remaining["noProgressSeconds"], 0)
        self.assertIsNone(self.progress.stop_reason)
        self.progress.model_calls = 128
        self.clock[0] = 100
        self.assertEqual(self.progress.tick(), "model_call_limit")
        self.assertIsNone(self.progress.model_guidance())
        self.progress.stop_reason = None
        for phase in ["preparing", "delivering", "finished"]:
            self.progress.phase = phase
            self.assertIsNone(self.progress.model_guidance())

    def test_report_override_controls_advice_and_stop_without_extending_time(self):
        self.progress.report_mode=True;self.progress.report_model_call_limit=256
        deadlines=(self.progress.soft_deadline,self.progress.hard_deadline)
        self.progress.model_calls=128
        self.assertIsNone(self.progress.tick())
        text=self.progress.model_guidance();remaining=json.loads(text[text.index('{'):text.index('}')+1])
        self.assertEqual(remaining['modelCalls'],128)
        self.progress.model_calls=248;self.assertIn('end now',self.progress.model_guidance())
        self.progress.model_calls=256;self.assertEqual(self.progress.tick(),'model_call_limit')
        self.assertEqual((self.progress.soft_deadline,self.progress.hard_deadline),deadlines)
        safe=module.safe_progress(json.loads(self.progress.path.read_text()),KEY,'0001')
        self.assertEqual(safe['modelCallLimit'],256)

    def test_a_report_budget_attribute_does_not_expand_an_ordinary_manual_task(self):
        self.progress.report_model_call_limit=256;self.progress.model_calls=128
        self.assertEqual(self.progress.tick(),'model_call_limit')

    def test_native_harness_output_limit_is_explicit_without_replacing_an_operator_stop(self):
        self.progress.event({"type": "turn/end", "data": {"reason": {"kind": "completed"}}})
        self.assertIsNone(self.progress.stop_reason)
        self.progress.event({"type": "turn/end", "data": {"reason": {"kind": "max-tokens"}}})
        self.assertEqual(self.progress.stop_reason, "model_output_limit")
        self.assertIsNone(self.progress.progress_at)
        self.progress.finish("blocked")
        self.assertEqual(module.safe_progress(json.loads(self.progress.path.read_text()), KEY, "0001")["stopReason"], "model_output_limit")
        self.progress.stop_reason = "operator_stop"
        self.progress.event({"type": "turn/end", "data": {"reason": {"kind": "max-tokens"}}})
        self.assertEqual(self.progress.stop_reason, "operator_stop")


if __name__ == "__main__":
    unittest.main()


class ReportStepProgressTest(unittest.TestCase):
    def test_a_step_limit_ends_the_session_without_a_stop_reason(self):
        clock = [100.0]
        progress = module.Progress('0001', '11111111-2222-4333-8444-555555555555', now=lambda: clock[0])
        progress.phase = 'running'
        progress.begin_step(4, 60, '/home/agent/deliverables/x/step-01.json')
        self.assertIsNone(progress.tick())
        progress.model_calls += 4
        self.assertEqual(progress.tick(), 'step_limit')
        self.assertIsNone(progress.stop_reason)
        progress.end_step()
        self.assertIsNone(progress.tick())
        progress.begin_step(10, 60, '/out/step-02.json')
        clock[0] += 61
        self.assertEqual(progress.step_due(), 'step_limit')

    def test_report_steps_reach_core_only_through_the_whitelist(self):
        value = {'requestId': 'r', 'pipelineId': '0001', 'phase': 'running', 'stage': 'model_wait',
                 'reportSteps': {'done': 3, 'failed': 1, 'findings': 2, 'stepContext': 16384, 'budgetSource': 'agent_workload',
                                 'counts': {'reviewed': 5, 'partial': 1, 'blocked': 0, 'pending': 9, 'secret': 'x'}, 'extra': 'drop'}}
        safe = module.safe_progress(value, 'r', '0001')
        self.assertEqual(safe['reportSteps'], {'done': 3, 'failed': 1, 'findings': 2, 'stepContext': 16384,
            'budgetSource': 'agent_workload', 'counts': {'reviewed': 5, 'partial': 1, 'blocked': 0, 'pending': 9}})
        value['reportSteps']['budgetSource'] = 'invented'
        self.assertIsNone(module.safe_progress(value, 'r', '0001')['reportSteps']['budgetSource'])
