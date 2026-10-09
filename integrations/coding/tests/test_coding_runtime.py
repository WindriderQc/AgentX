import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("coding_runtime", Path(__file__).resolve().parents[1] / "coding_runtime.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class RuntimeIdentityTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "distribution"
        (self.root / "bin").mkdir(parents=True)
        self.node = self.root / "bin/node"
        self.node.write_bytes(b"synthetic Node artifact")
        self.node.chmod(0o700)
        self.npm = self.root / "lib/node_modules/npm"
        (self.npm / "bin").mkdir(parents=True)
        (self.npm / "bin/npm-cli.js").write_text("synthetic npm CLI")
        (self.npm / "package.json").write_text(json.dumps({"name": "npm", "version": "11.0.0", "bin": {"npm": "bin/npm-cli.js"}}))
        self.deep = self.npm / "node_modules/fixture/index.js"
        self.deep.parent.mkdir(parents=True)
        self.deep.write_text("first dependency bytes")
        (self.root / "bin/npm").symlink_to("../lib/node_modules/npm/bin/npm-cli.js")
        self.observation = {"nodeVersion": "v24.21.0", "modules": "137", "platform": "linux", "arch": "x64", "npmVersion": "11.0.0"}
        self.probe = mock.Mock(side_effect=lambda _: dict(self.observation))

    def identify(self):
        return runtime.identity(self.root, self.node, self.probe)

    def test_deep_npm_content_and_node_bytes_both_change_identity(self):
        initial = self.identify()
        self.deep.write_text("changed dependency bytes")
        npm_changed = self.identify()
        self.assertNotEqual(initial["npmSha256"], npm_changed["npmSha256"])
        self.assertEqual(initial["nodeSha256"], npm_changed["nodeSha256"])
        self.node.write_bytes(b"different Node at the same declared version")
        self.assertNotEqual(npm_changed["nodeSha256"], self.identify()["nodeSha256"])

    def test_identical_distribution_can_be_relocated(self):
        initial = self.identify()
        moved = self.root.parent / "moved"
        shutil.copytree(self.root, moved, symlinks=True)
        self.assertEqual(initial, runtime.identity(moved, moved / "bin/node", self.probe))

    def test_invalid_explicit_selector_never_probes_a_default_node(self):
        for selected in [self.root / "bin/missing", self.npm / "bin/npm-cli.js"]:
            with self.subTest(selected=selected), self.assertRaises(runtime.RuntimeUnavailable):
                runtime.identity(self.root, selected, self.probe)
        self.probe.assert_not_called()

    def test_non_executable_node_or_missing_npm_blocks_before_probe(self):
        self.node.chmod(0o600)
        with self.assertRaises(runtime.RuntimeUnavailable):
            self.identify()
        self.node.chmod(0o700)
        (self.root / "bin/npm").unlink()
        with self.assertRaises(runtime.RuntimeUnavailable):
            self.identify()
        self.probe.assert_not_called()

    def test_bundle_symlink_content_is_hashed_and_escape_is_refused(self):
        target = self.root / "shared.js"
        target.write_text("shared npm dependency")
        link = self.npm / "node_modules/fixture/shared.js"
        link.symlink_to(target)
        first = self.identify()
        target.write_text("modified shared npm dependency")
        self.assertNotEqual(first["npmSha256"], self.identify()["npmSha256"])
        outside = self.root.parent / "outside.js"
        outside.write_text("outside the mounted distribution")
        link.unlink()
        link.symlink_to(outside)
        with self.assertRaises(runtime.RuntimeUnavailable):
            self.identify()

    def test_cyclic_bundle_is_refused(self):
        (self.npm / "node_modules/fixture/cycle").symlink_to(self.npm, target_is_directory=True)
        with self.assertRaises(runtime.RuntimeUnavailable):
            self.identify()
        self.probe.assert_not_called()

    def test_malformed_probes_or_npm_disagreement_are_refused(self):
        for observed in [None, [], {}, {**self.observation, "modules": "unknown"},
                         {**self.observation, "nodeVersion": "24.21.0"},
                         {**self.observation, "npmVersion": "12.0.0"},
                         {**self.observation, "arch": None}]:
            with self.subTest(observed=observed), mock.patch.object(self, "probe", return_value=observed), \
                    self.assertRaises(runtime.RuntimeUnavailable):
                self.identify()

    def test_artifact_change_during_probe_never_receives_identity(self):
        def probe(_):
            self.deep.write_text("changed while runtime was being observed")
            return self.observation
        with mock.patch.object(self, "probe", side_effect=probe), self.assertRaises(runtime.RuntimeChanged):
            self.identify()


if __name__ == "__main__":
    unittest.main()
