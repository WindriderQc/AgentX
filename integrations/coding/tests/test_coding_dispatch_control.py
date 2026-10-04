import subprocess
import multiprocessing
import os
import tempfile
import threading
import unittest
from pathlib import Path

from integrations.coding.coding_dispatch_control import HostControl, ControlError
from integrations.coding.tests.test_coding_dispatcher import config, task

FIRST = "10000000-0000-4000-8000-000000000001"
SECOND = "10000000-0000-4000-8000-000000000002"


def process_launch(directory, key, results):
    state = Path(directory)
    def start(run):
        (state / "active").write_text(run["requestId"])
    control = HostControl(state_root=state, config=config(), read_tasks=lambda: [task()],
                          unit_reader=lambda: {"ActiveState": "active" if (state / "active").exists() else "inactive"},
                          starter=start, work_busy=lambda: False)
    try:
        results.put(control.launch("0700", key, 0)["run"]["phase"])
    except ControlError as error:
        results.put(error.code)


class HostControlTests(unittest.TestCase):
    def test_catalog_reads_deployed_revision_without_moving_worker_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "source"
            worker = Path(directory) / "worker"
            root.mkdir()
            def git(repo, *args):
                return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()
            git(root, "init", "--quiet")
            git(root, "config", "user.email", "test@example.invalid")
            git(root, "config", "user.name", "Test")
            (root / "AGENTS.md").write_text("Read the task")
            git(root, "add", "AGENTS.md")
            git(root, "commit", "--quiet", "-m", "Base")
            base = git(root, "rev-parse", "HEAD")
            git(root, "clone", "--quiet", str(root), str(worker))
            (root / "new.js").write_text("new source")
            git(root, "add", "new.js")
            git(root, "commit", "--quiet", "-m", "Deployed source")
            revision = git(root, "rev-parse", "HEAD")
            selected = config()
            selected["policies"]["agentx.reviewed-code/v1"]["repository"] = "agentx"
            selected["executionProfiles"]["clawdx-file-tools/v1"]["remoteRepo"] = str(worker)
            catalog = HostControl(root=root, config=selected).catalog()
            self.assertIn("new.js", catalog["projects"][0]["files"])
            self.assertEqual(git(worker, "rev-parse", "HEAD"), base)
            self.assertEqual(git(worker, "status", "--porcelain"), "")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tasks = [task(), task("0701", automation=None), task("0702", service="personal")]
        self.lock = threading.Lock()
        self.active = False
        self.starts = []
        self.executions = []
        self.control = self.new_control()

    def start(self, run):
        self.starts.append(run["requestId"])
        self.active = True

    def execute(self, run):
        self.executions.append(run["requestId"])
        self.tasks[0].update(status="blocked", automationAttemptCount=1)
        self.active = False
        return 3

    def new_control(self, **options):
        defaults = dict(config=config(), read_tasks=lambda: self.tasks,
                        unit_reader=lambda: {"ActiveState": "active" if self.active else "inactive"},
                        starter=self.start, executor=self.execute,
                        lock_factory=lambda: self.lock, work_busy=lambda: False)
        defaults.update(options)
        return HostControl(state_root=Path(self.temp.name), **defaults)

    def test_default_executor_passes_only_the_exact_request_reference_to_the_claim(self):
        from unittest.mock import patch
        control = HostControl(root=Path(self.temp.name), state_root=Path(self.temp.name), config=config(),
                              read_tasks=lambda: self.tasks, lock_factory=lambda: self.lock)
        with patch("integrations.coding.coding_dispatch_control.subprocess.run") as run:
            run.return_value.returncode = 0
            self.assertEqual(control._execute({"requestId": FIRST, "pipelineId": "0700"}), 0)
        self.assertEqual(run.call_args.kwargs["env"]["AGENTX_CODING_DISPATCH_REQUEST_ID"], FIRST)
        self.assertEqual(run.call_args.args[0][-1], "0700")
        with self.assertRaises(ControlError):
            control._execute({"requestId": "../not-a-request", "pipelineId": "0700"})

    def test_request_id_accepts_exact_lowercase_and_rejects_case_length_hex_and_path_forms(self):
        from integrations.coding.coding_dispatch_control import request_id
        self.assertEqual(request_id("abcdefab-0000-4000-8000-000000000001"), "abcdefab-0000-4000-8000-000000000001")
        for rejected in ("ABCDEFAB-0000-4000-8000-000000000001",
                         "abc-0000",
                         "ghijklkl-0000-4000-8000-000000000001",
                         "../not-a-request"):
            with self.subTest(rejected=rejected):
                with self.assertRaises(ControlError):
                    request_id(rejected)

    def test_status_uses_dispatcher_admission_and_keeps_private_tasks_out(self):
        result = self.control.status()
        self.assertEqual([t["pipelineId"] for t in result["candidates"]], ["0700"])
        self.assertEqual(result["summary"], dict(queuedTasks=3, eligibleTasks=1, privateQueuedTasks=1))
        self.assertEqual([t["pipelineId"] for t in result["excluded"]], ["0701"])
        self.assertTrue(result["excluded"][0]["reasons"])
        self.assertFalse(self.starts)

    def test_duplicate_after_adapter_restart_reuses_receipt_and_executor_runs_once(self):
        self.control.launch("0700", FIRST, 0)
        fresh = self.new_control()
        self.assertTrue(fresh.launch("0700", FIRST, 0)["replayed"])
        self.assertEqual(self.starts, [FIRST])
        self.assertEqual(fresh.execute(FIRST), 3)
        self.assertEqual(fresh.execute(FIRST), 0)
        self.assertEqual(self.executions, [FIRST])
        observed = fresh.status(FIRST)["run"]
        self.assertEqual(observed["phase"], "finished")
        self.assertEqual(observed["exitCode"], 3)
        self.assertEqual(observed["task"]["status"], "blocked")

    def test_two_process_controls_cannot_accept_different_requests_concurrently(self):
        self.tasks.append(task("0703"))
        results = []
        def launch(control, pipeline_id, key):
            try:
                results.append(control.launch(pipeline_id, key, 0))
            except ControlError as error:
                results.append(error.code)
        threads = [threading.Thread(target=launch, args=(self.control, "0700", FIRST)),
                   threading.Thread(target=launch, args=(self.new_control(), "0703", SECOND))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
            self.assertFalse(thread.is_alive())
        self.assertEqual(len(self.starts), 1)
        self.assertIn("CODING_DISPATCH_BUSY", results)

    def test_request_identity_cannot_change_task_or_observed_attempt(self):
        self.control.launch("0700", FIRST, 0)
        for pipeline_id, count in [("0703", 0), ("0700", 1)]:
            with self.assertRaisesRegex(ControlError, "different selection"):
                self.new_control().launch(pipeline_id, FIRST, count)
        self.assertEqual(self.starts, [FIRST])

    @unittest.skipIf(os.name == "nt", "Production uses POSIX flock; exercised in Linux CI")
    def test_real_host_file_lock_serializes_separate_processes(self):
        context = multiprocessing.get_context("spawn")
        results = context.Queue()
        processes = [context.Process(target=process_launch, args=(self.temp.name, key, results)) for key in (FIRST, SECOND)]
        try:
            for process in processes:
                process.start()
            observed = [results.get(timeout=15) for _ in processes]
            for process in processes:
                process.join(15)
                self.assertEqual(process.exitcode, 0)
            self.assertCountEqual(observed, ["accepted", "CODING_DISPATCH_BUSY"])
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                    process.join(5)
            results.close()

    def test_lost_acceptance_is_observed_without_starting_another_worker(self):
        def uncertain(run):
            self.start(run)
            raise subprocess.TimeoutExpired("systemd-run", 10)
        control = self.new_control(starter=uncertain)
        result = control.launch("0700", FIRST, 0)
        self.assertFalse(result["accepted"])
        self.assertFalse(control.status(FIRST)["run"]["canRetry"])
        control.launch("0700", FIRST, 0)
        control.execute(FIRST)
        self.assertEqual(self.starts, [FIRST])
        self.assertEqual(self.executions, [FIRST])

    def test_unstarted_uncertain_request_can_be_explicitly_resubmitted_with_same_id(self):
        def unavailable(run):
            raise subprocess.TimeoutExpired("systemd-run", 10)
        self.new_control(starter=unavailable).launch("0700", FIRST, 0)
        self.assertTrue(self.control.status(FIRST)["run"]["canRetry"])
        self.assertFalse(self.starts)
        self.control.launch("0700", FIRST, 0)
        self.control.execute(FIRST)
        self.control.execute(FIRST)
        self.assertEqual(self.starts, [FIRST])
        self.assertEqual(self.executions, [FIRST])

    def test_finished_request_never_becomes_new_attempt_after_requeue(self):
        self.control.launch("0700", FIRST, 0)
        self.control.execute(FIRST)
        self.tasks[0].update(status="queued", automationAttemptCount=1)
        self.control.launch("0700", FIRST, 0)
        self.control.execute(FIRST)
        self.assertEqual(self.executions, [FIRST])
        with self.assertRaises(ControlError):
            self.control.launch("0700", SECOND, 0)
        third = "10000000-0000-4000-8000-000000000003"
        self.control.launch("0700", third, 1)
        self.control.execute(third)
        self.assertEqual(self.executions, [FIRST, third])

    def test_delayed_executor_rechecks_attempt_and_eligibility(self):
        for updates in [dict(automationAttemptCount=1), dict(status="blocked"), dict(assignee="someone")]:
            with self.subTest(updates=updates):
                with tempfile.TemporaryDirectory() as directory:
                    self.active = False
                    self.tasks[0] = task()
                    control = self.new_control()
                    control.receipts = Path(directory)
                    control.launch("0700", FIRST, 0)
                    self.tasks[0].update(updates)
                    control.execute(FIRST)
                    self.assertEqual(control.status(FIRST)["run"]["phase"], "rejected")
        self.assertFalse(self.executions)

    def test_collected_unit_does_not_fabricate_success_or_retry_started_request(self):
        self.control.launch("0700", FIRST, 0)
        self.active = False
        observed = self.control.status(FIRST)["run"]
        self.assertEqual(observed["phase"], "stopped")
        self.assertNotIn("exitCode", observed)
        self.assertFalse(observed["canRetry"])

    def test_known_host_rejection_is_durable_and_readable(self):
        def refused(run):
            raise subprocess.CalledProcessError(1, "systemd-run", stderr="private output")
        with self.assertRaises(ControlError) as error:
            self.new_control(starter=refused).launch("0700", FIRST, 0)
        self.assertEqual(error.exception.code, "CODING_DISPATCH_HOST_REJECTED")
        self.assertNotIn("private", str(error.exception))
        self.assertEqual(self.control.status(FIRST)["run"]["phase"], "rejected")


if __name__ == "__main__":
    unittest.main()
