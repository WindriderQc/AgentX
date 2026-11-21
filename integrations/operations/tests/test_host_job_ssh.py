import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_job_ssh import request_arguments
from host_jobs.store import JobError
from host_jobs.transport import posix_command


class SshEntryTests(unittest.TestCase):
    def setUp(self):
        self.request = str(uuid.uuid4())
        self.host = {"python": "/usr/bin/python3", "root": "/opt/a path/operations", "stateRoot": "/var/lib/a state"}
        self.parse = lambda command: request_arguments(command, self.host["stateRoot"],
                                                       "/opt/a path/operations/host_job_worker.py", "/usr/bin/python3")

    def test_transport_requests_round_trip_without_shell_execution(self):
        for verb in ("run", "status", "inventory"):
            command = posix_command(self.host, verb, "security-plan" if verb == "run" else None,
                                    self.request if verb != "inventory" else None)
            result = self.parse(command)
            self.assertEqual(result[:3], ["--root", self.host["stateRoot"], verb])

    def test_rejects_shells_substitution_extra_paths_duplicates_and_missing_fields(self):
        valid = posix_command(self.host, "run", "security-plan", self.request)
        cases = ["", "sh", "cat /etc/shadow", valid + "; reboot", valid + " && true", valid + " --root /tmp/other",
                 valid + " --request " + self.request, valid.replace("security-plan", "$(touch /tmp/effect)"),
                 valid.replace("--request", "--unknown"), valid.replace("/usr/bin/python3", "/bin/sh"),
                 shlex.join([self.host['python'], '/opt/a path/operations/host_job_worker.py', '--root', self.host['stateRoot'], 'run']),
                 valid + " --source-at not-a-date"]
        for command in cases:
            with self.subTest(command=command), self.assertRaises(JobError):
                self.parse(command)

    def test_read_verbs_cannot_smuggle_run_parameters(self):
        for verb in ("status", "inventory"):
            command = posix_command(self.host, verb, "security-plan", self.request)
            with self.assertRaises(JobError):
                self.parse(command)

    def test_forced_entry_refuses_before_creating_worker_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "not-created"
            script = Path(__file__).resolve().parents[1] / "host_job_ssh.py"
            result = subprocess.run([sys.executable, str(script), "--root", str(root)],
                                    env={**os.environ, "SSH_ORIGINAL_COMMAND": "id"}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("SSH_COMMAND_REFUSED", result.stdout)
            self.assertFalse(root.exists())
