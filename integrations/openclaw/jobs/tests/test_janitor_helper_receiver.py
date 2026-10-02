import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "janitor" / "openclaw_janitor_helper_receiver.py"
SPEC = importlib.util.spec_from_file_location("openclaw_janitor_helper_receiver", SCRIPT)
RECEIVER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(RECEIVER)

PAYLOAD = b'print("synthetic helper")\n'


def request(action="install", payload=PAYLOAD, **overrides):
    header = {
        "protocol": RECEIVER.PROTOCOL,
        "action": action,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "size": len(payload),
    }
    header.update(overrides)
    return io.BytesIO(json.dumps(header).encode("ascii") + b"\n" + payload)


class Runner:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        if self.fail:
            raise subprocess.CalledProcessError(1, argv)
        return subprocess.CompletedProcess(argv, 0)


class ReceiverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.target = pathlib.Path(self.tmp.name) / "lib" / "openclaw_shared_drive_janitor.py"

    def tearDown(self):
        self.tmp.cleanup()

    def serve(self, stdin, runner=None, original_command=None):
        out, err = io.StringIO(), io.StringIO()
        code = RECEIVER.serve(
            stdin, out, err, target=self.target, original_command=original_command, runner=runner or Runner()
        )
        return code, out.getvalue(), err.getvalue()

    def test_install_then_unchanged(self):
        runner = Runner()
        code, out, _ = self.serve(request(), runner)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["status"], "updated")
        self.assertEqual(self.target.read_bytes(), PAYLOAD)
        self.assertEqual(runner.calls[-1][1:], [str(self.target), "--help"])
        code, out, _ = self.serve(request(), runner)
        self.assertEqual(json.loads(out)["status"], "unchanged")

    def test_check_reports_drift_without_writing(self):
        code, out, _ = self.serve(request(action="check"))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"ok": True, "status": "drift", "sha256": None})
        self.assertFalse(self.target.exists())

    def test_failed_validation_keeps_previous_helper(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b"previous\n")
        code, out, err = self.serve(request(), Runner(fail=True))
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("--help validation failed", err)
        self.assertEqual(self.target.read_bytes(), b"previous\n")
        self.assertEqual(list(self.target.parent.glob(".*candidate-*")), [])

    def test_rejects_ssh_command_and_bad_headers(self):
        code, _, err = self.serve(request(), original_command="cat /etc/passwd")
        self.assertEqual(code, 1)
        self.assertIn("SSH commands are forbidden", err)
        for stdin, message in (
            (request(protocol="other"), "unsupported protocol"),
            (request(action="delete"), "unsupported action"),
            (request(sha256="0" * 64), "does not match"),
            (request(size=True), "size must be an integer"),
            (io.BytesIO(request().getvalue() + b"x"), "exceeds the declared size"),
            (io.BytesIO(b'{"protocol": 1}'), "missing or exceeds"),
        ):
            code, _, err = self.serve(stdin)
            self.assertEqual(code, 1, message)
            self.assertIn(message, err)

    def test_rejects_invalid_python(self):
        payload = b"def broken(:\n"
        code, _, err = self.serve(request(payload=payload))
        self.assertEqual(code, 1)
        self.assertIn("candidate validation failed", err)


class TargetResolutionTest(unittest.TestCase):
    def test_defaults_to_sibling_checkout_script(self):
        self.assertEqual(RECEIVER.resolve_target([], {}), SCRIPT.parent / "openclaw_shared_drive_janitor.py")

    def test_argument_beats_environment(self):
        env_target = str(pathlib.Path(tempfile.gettempdir()) / "env" / "helper.py")
        arg_target = str(pathlib.Path(tempfile.gettempdir()) / "arg" / "helper.py")
        env = {RECEIVER.TARGET_ENV: env_target}
        self.assertEqual(RECEIVER.resolve_target([], env), pathlib.Path(env_target))
        self.assertEqual(RECEIVER.resolve_target(["--target", arg_target], env), pathlib.Path(arg_target))

    def test_relative_target_is_refused(self):
        with self.assertRaises(RECEIVER.ReceiverError):
            RECEIVER.resolve_target(["--target", "relative/helper.py"], {})

    def test_main_reports_bad_target(self):
        err = io.StringIO()
        with mock.patch.object(RECEIVER.sys, "stderr", err):
            self.assertEqual(RECEIVER.main(["--target", "relative.py"]), 1)
        self.assertIn("absolute path", err.getvalue())


if __name__ == "__main__":
    unittest.main()
