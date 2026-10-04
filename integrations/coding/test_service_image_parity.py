import datetime as dt
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("service-image-parity.py")
SPEC = importlib.util.spec_from_file_location("service_image_parity", SCRIPT)
PARITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PARITY)


class ServiceImageParityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, body in {
            "docker/core.Dockerfile": "FROM node:24\nCOPY core/ /app/\n",
            "core/app.js": "module.exports = 1;\n",
            "docker-compose.yml": "services: {}\n",
            ".dockerignore": "node_modules\n",
            "README.md": "before\n",
            "instance.env": "SECRET=fixture\n",
            "instance.yml": "services: {}\n",
        }.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
        self.run_git("init")
        self.run_git("config", "user.email", "test@example.invalid")
        self.run_git("config", "user.name", "Test")
        self.run_git("add", ".")
        self.run_git("commit", "-m", "initial")
        self.running_revision = self.run_git("rev-parse", "HEAD")
        (self.root / "README.md").write_text("after\n", encoding="utf-8")
        self.run_git("add", "README.md")
        self.run_git("commit", "-m", "docs")
        self.checkout = self.run_git("rev-parse", "HEAD")
        self.created = dt.datetime.now(dt.timezone.utc).timestamp() + 60

    def run_git(self, *args):
        return subprocess.run(
            ["git", "-C", str(self.root), *args],
            check=True, capture_output=True, text=True,
        ).stdout.strip()

    def args(self):
        created = dt.datetime.fromtimestamp(self.created, dt.timezone.utc).isoformat()
        return [str(self.root), "core", self.running_revision, self.checkout,
                created, str(self.root / "instance.env"), str(self.root / "instance.yml")]

    def test_unrelated_commit_keeps_running_image_equivalent(self):
        self.assertTrue(PARITY.prove(self.args()))

    def test_image_source_change_invalidates_equivalence(self):
        (self.root / "core/app.js").write_text("module.exports = 2;\n", encoding="utf-8")
        self.run_git("add", "core/app.js")
        self.run_git("commit", "-m", "change image")
        args = self.args()
        args[3] = self.run_git("rev-parse", "HEAD")
        self.assertFalse(PARITY.prove(args))

    def test_newer_configuration_invalidates_equivalence(self):
        config = self.root / "instance.env"
        os.utime(config, (self.created + 30, self.created + 30))
        self.assertFalse(PARITY.prove(self.args()))

    def test_unknown_revision_and_missing_configuration_fail_closed(self):
        args = self.args()
        args[2] = "0" * 40
        self.assertFalse(PARITY.prove(args))
        args = self.args()
        args[-1] = str(self.root / "missing.yml")
        self.assertFalse(PARITY.prove(args))


if __name__ == "__main__":
    unittest.main()
