"""Dependency preparation regressions with every external effect mocked."""

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "dependency_preparation_runner", Path(__file__).resolve().parents[1] / "coding_run.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class DependencyPreparationTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dependency-preparation-test-")
        self.addCleanup(directory.cleanup)
        self.workspace = Path(directory.name) / "workspace"
        self.workspace.mkdir()
        for name in runner.PACKAGE_DIRS:
            package = self.workspace / name
            package.mkdir()
            (package / "package.json").write_text('{"name":"fixture","version":"1.0.0"}\n')
            (package / "package-lock.json").write_text('{"lockfileVersion":3}\n')
        self.identity = {
            "nodeVersion": "v24.21.0", "modules": "137", "platform": "linux", "arch": "x64",
            "npmVersion": "11.0.0", "nodeSha256": "a" * 64, "npmSha256": "b" * 64,
            "npmCli": "lib/node_modules/npm/bin/npm-cli.js",
        }
        self.install_effect = None
        self.exit_code = 0
        self.home = runner.worker_home(self.workspace)
        self.marker = self.home / "dependencies-v2.json"
        self.legacy = self.home / "dependencies.sha256"
        self.runtime_impl = getattr(runner, "runtime_identity", None)
        self.identity_mock = self.patch("runtime_identity", self.observe_runtime, create=True)
        self.sandbox_mock = self.patch("sandbox", self.make_command)
        self.supervise_mock = self.patch("supervise", self.install)
        self.patch("run_worker", mock.Mock(side_effect=AssertionError("Worker must not run")))
        self.patch("request", mock.Mock(side_effect=AssertionError("Network request must not run")))

    def patch(self, name, effect, **kwargs):
        patch = mock.patch.object(runner, name, side_effect=effect, **kwargs)
        value = patch.start()
        self.addCleanup(patch.stop)
        return value

    def observe_runtime(self, workspace):
        self.assertEqual(workspace, self.workspace)
        return copy.deepcopy(self.identity)

    def make_command(self, workspace, home, command, **kwargs):
        self.assertEqual(workspace, self.workspace)
        self.assertEqual(home, self.home)
        return command

    def install(self, command, progress=None):
        if self.install_effect:
            self.install_effect()
        return subprocess.CompletedProcess(command, self.exit_code, stdout="fixture", stderr="")

    def prime(self):
        runner.install_dependencies(self.workspace)
        self.assertEqual(self.supervise_mock.call_count, 1)
        self.supervise_mock.reset_mock()
        self.sandbox_mock.reset_mock()
        self.identity_mock.reset_mock()

    def test_legacy_marker_does_not_skip_preparation_for_selected_runtime(self):
        self.legacy.write_text(runner.dependency_state(self.workspace) + "\n")
        self.identity["nodeVersion"] = "v26.3.0"
        runner.install_dependencies(self.workspace)
        self.assertEqual(self.supervise_mock.call_count, 1,
                         "A manifest-only legacy marker cannot prove runtime preparation")
        self.assertTrue(self.marker.is_file(), "Successful preparation must publish a v2 marker")

    def test_same_prepared_runtime_skips_install_but_is_validated_again(self):
        self.prime()
        runner.install_dependencies(self.workspace)
        self.identity_mock.assert_called()
        self.supervise_mock.assert_not_called()
        self.sandbox_mock.assert_not_called()

    def test_each_runtime_component_change_reinstalls_with_same_package_files(self):
        original_packages = runner.dependency_state(self.workspace)
        replacements = {
            "nodeVersion": "v26.3.0", "modules": "145", "platform": "darwin", "arch": "arm64",
            "npmVersion": "12.0.0", "nodeSha256": "c" * 64, "npmSha256": "d" * 64,
        }
        self.prime()
        for field, changed in replacements.items():
            with self.subTest(field=field):
                self.identity[field] = changed
                runner.install_dependencies(self.workspace)
                self.assertEqual(self.supervise_mock.call_count, 1,
                                 "A different runtime requires fresh dependency preparation")
                self.assertEqual(runner.dependency_state(self.workspace), original_packages,
                                 "The package ownership guard must remain independent of runtime")
                self.supervise_mock.reset_mock()
                runner.install_dependencies(self.workspace)
                self.supervise_mock.assert_not_called()

    def test_relocation_with_identical_runtime_contents_keeps_cache_hit(self):
        self.prime()
        with mock.patch.object(runner, "NODE_ROOT", self.workspace.parent / "relocated-runtime"):
            runner.install_dependencies(self.workspace)
        self.identity_mock.assert_called()
        self.supervise_mock.assert_not_called()

    def test_invalid_runtime_refuses_before_install_even_with_prepared_cache(self):
        self.prime()
        self.identity_mock.side_effect = RuntimeError("Selected distribution unavailable")
        with self.assertRaisesRegex(RuntimeError, "Selected distribution unavailable"):
            runner.install_dependencies(self.workspace)
        self.supervise_mock.assert_not_called()
        self.sandbox_mock.assert_not_called()

    def test_malformed_or_unknown_markers_are_cache_misses(self):
        self.prime()
        self.assertTrue(self.marker.is_file(), "Preparation must create the versioned marker")
        valid = json.loads(self.marker.read_text())
        variants = ["not json", "null", "[]", "{}", json.dumps({**valid, "schemaVersion": 3}),
                    json.dumps({**valid, "schemaVersion": 1}),
                    json.dumps({**valid, "fingerprint": "wrong"}),
                    json.dumps({**valid, "fingerprint": None})]
        for value in variants:
            with self.subTest(marker=value):
                self.marker.write_text(value)
                runner.install_dependencies(self.workspace)
                self.assertEqual(self.supervise_mock.call_count, 1)
                self.supervise_mock.reset_mock()
                runner.install_dependencies(self.workspace)
                self.supervise_mock.assert_not_called()

    def test_unreadable_marker_is_a_cache_miss(self):
        self.prime()
        original_read = Path.read_text

        def read(path, *args, **kwargs):
            if path == self.marker:
                raise PermissionError("Fixture marker unreadable")
            return original_read(path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", read):
            runner.install_dependencies(self.workspace)
        self.assertEqual(self.supervise_mock.call_count, 1)

    def test_marker_is_removed_before_failed_install_and_old_runtime_cannot_hit(self):
        self.prime()
        old_identity = copy.deepcopy(self.identity)
        self.identity["npmSha256"] = "e" * 64
        self.exit_code = 7
        self.install_effect = lambda: self.assertFalse(
            self.marker.exists(), "An install may already have changed node_modules")
        with self.assertRaises(subprocess.CalledProcessError):
            runner.install_dependencies(self.workspace)
        self.assertFalse(self.marker.exists())
        self.identity = old_identity
        self.exit_code = 0
        self.install_effect = None
        self.supervise_mock.reset_mock()
        runner.install_dependencies(self.workspace)
        self.assertEqual(self.supervise_mock.call_count, 1,
                         "Returning to an old runtime cannot reuse a cache after a failed install")

    def test_lock_finalized_during_install_is_cached_without_second_install(self):
        before = runner.dependency_state(self.workspace)
        self.install_effect = lambda: (self.workspace / "core/package-lock.json").write_text(
            '{"lockfileVersion":3,"packages":{"": {"version":"2.0.0"}}}\n')
        runner.install_dependencies(self.workspace)
        self.assertNotEqual(runner.dependency_state(self.workspace), before)
        self.supervise_mock.reset_mock()
        self.install_effect = None
        runner.install_dependencies(self.workspace)
        self.supervise_mock.assert_not_called()

    def test_runtime_drift_during_successful_install_leaves_no_valid_marker(self):
        self.prime()
        self.identity["nodeSha256"] = "e" * 64
        self.install_effect = lambda: self.identity.update({"npmSha256": "f" * 64})
        with self.assertRaises(RuntimeError):
            runner.install_dependencies(self.workspace)
        self.assertFalse(self.marker.exists())
        self.install_effect = None
        self.supervise_mock.reset_mock()
        runner.install_dependencies(self.workspace)
        self.assertEqual(self.supervise_mock.call_count, 1)

    def test_package_change_reinstalls_and_resumed_package_state_is_cached(self):
        self.prime()
        (self.workspace / "rag/package.json").write_text('{"name":"changed-fixture"}\n')
        runner.install_dependencies(self.workspace)
        self.assertEqual(self.supervise_mock.call_count, 1)
        self.supervise_mock.reset_mock()
        runner.install_dependencies(self.workspace)
        self.supervise_mock.assert_not_called()

    def test_interrupted_preparation_leaves_no_old_marker(self):
        self.prime()
        self.identity["nodeSha256"] = "f" * 64
        self.supervise_mock.side_effect = InterruptedError("Fixture preparation interrupted")
        with self.assertRaisesRegex(InterruptedError, "Fixture preparation interrupted"):
            runner.install_dependencies(self.workspace)
        self.assertFalse(self.marker.exists())
        self.supervise_mock.side_effect = self.install
        self.supervise_mock.reset_mock()
        runner.install_dependencies(self.workspace)
        self.assertEqual(self.supervise_mock.call_count, 1)

    def test_post_install_runtime_probe_failure_publishes_no_marker(self):
        self.prime()
        self.identity["npmSha256"] = "f" * 64
        self.identity_mock.side_effect = [copy.deepcopy(self.identity),
                                          RuntimeError("Fixture runtime disappeared")]
        with self.assertRaisesRegex(RuntimeError, "Fixture runtime disappeared"):
            runner.install_dependencies(self.workspace)
        self.assertEqual(self.supervise_mock.call_count, 1)
        self.assertFalse(self.marker.exists())

    def test_runtime_probe_uses_selected_node_and_npm_without_network(self):
        if self.runtime_impl is None:
            self.skipTest("The baseline does not yet expose the runtime probe API")
        observed = {key: self.identity[key] for key in
                    ("nodeVersion", "modules", "platform", "arch")}
        outputs = [subprocess.CompletedProcess([], 0, stdout=json.dumps(observed), stderr=""),
                   subprocess.CompletedProcess([], 0, stdout=self.identity["npmVersion"], stderr="")]

        def identify(root, selected_node, probe):
            self.assertEqual(probe(self.identity["npmCli"]),
                             {**observed, "npmVersion": self.identity["npmVersion"]})
            return copy.deepcopy(self.identity)

        with mock.patch.object(runner.coding_runtime, "identity", side_effect=identify), \
                mock.patch.object(runner.subprocess, "run", side_effect=outputs) as run:
            self.assertEqual(self.runtime_impl(self.workspace), self.identity)
        self.assertEqual(self.sandbox_mock.call_count, 2)
        for call in self.sandbox_mock.call_args_list:
            self.assertFalse(call.kwargs["network"])
            self.assertEqual(call.args[2][0], "/opt/node/bin/node")
            self.assertLessEqual(call.kwargs["timeout_seconds"], 10)
        self.assertEqual(self.sandbox_mock.call_args_list[1].args[2],
                         ["/opt/node/bin/node", "/opt/node/" + self.identity["npmCli"], "--version"])
        self.assertEqual(run.call_count, 2)
        self.supervise_mock.assert_not_called()

    def test_install_commands_use_explicit_runtime_with_scripts_disabled(self):
        runner.install_dependencies(self.workspace)
        args, kwargs = self.sandbox_mock.call_args
        self.assertTrue(kwargs["network"], "Only dependency preparation opens the mocked network")
        self.assertEqual(args[2][:2], ["bash", "-c"])
        script = args[2][2]
        self.assertIn("/opt/node/bin/node /opt/node/lib/node_modules/npm/bin/npm-cli.js ci --ignore-scripts --no-audit --no-fund", script)
        self.assertIn("/opt/node/bin/node /opt/node/lib/node_modules/npm/bin/npm-cli.js install --ignore-scripts --no-audit --no-fund", script)
        self.assertIn("/opt/node/bin/node /opt/prepareMongo.js", script)
        self.assertNotIn("then npm ", script)
        self.assertNotIn("&& node ", script)


if __name__ == "__main__":
    unittest.main()
