import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('coding_run', HERE / 'coding_run.py')
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


@unittest.skipUnless(shutil.which('node'), 'Node is required for the worker CLI bootstrap')
class WorkerPromptTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.workspace, self.home = self.root/'task-0001', self.root/'.home-task-0001'
        self.workspace.mkdir(); self.home.mkdir()
        self.cli = self.root/'fixture-worker.mjs'
        self.cli.write_text("import { createHash } from 'node:crypto';\n"
            "const args = process.argv.slice(2); const task = args.pop();\n"
            "console.log(JSON.stringify({args, bytes:Buffer.byteLength(task), "
            "sha256:createHash('sha256').update(task).digest('hex')}));\n")
        self.prompt = "Literal $HOME $(false) `false` ' \" — 漢字\n" * 5000
        self.progress = SimpleNamespace(request_id='11111111-2222-4333-8444-555555555555')
        self.on_stop = object()
        self.captured = {}

    def sandbox(self, workspace, home, command, **kwargs):
        self.assertEqual((workspace, home), (self.workspace, self.home))
        path = kwargs['prompt_file']
        self.captured.update(kwargs, path=path)
        self.assertFalse(path.is_relative_to(home))
        self.assertEqual(path.read_bytes(), self.prompt.encode('utf-8'))
        if os.name == 'posix':
            self.assertEqual(path.stat().st_mode & 0o777, 0o400)
        self.assertFalse(kwargs['network'])
        self.assertTrue(all(len(arg.encode('utf-8')) < 131072 for arg in command))
        self.assertNotIn(self.prompt, command)
        return command

    def supervise(self, command, progress, home, workspace, *, on_stop):
        self.assertIs(on_stop, self.on_stop)
        self.assertIs(progress, self.progress)
        index = command.index('node')
        self.assertEqual(command[index+1:index+4], [
            '/opt/coding/coding_worker_prompt.cjs', runner.coding_worker_prompt.SANDBOX_PROMPT,
            '/opt/dsh/node_modules/.bin/dsh'])
        return subprocess.run([shutil.which('node'), str(HERE/'coding_worker_prompt.cjs'),
            str(self.captured['path']), str(self.cli), *command[index+4:]],
            text=True, capture_output=True, timeout=10)

    def test_large_literal_utf8_prompt_reaches_cli_unchanged_without_large_exec_arguments(self):
        if sys.platform.startswith('linux'):
            with self.assertRaises(OSError) as raised:
                subprocess.run(['/bin/true', self.prompt], capture_output=True)
            self.assertEqual(raised.exception.errno, errno.E2BIG)
        r = SimpleNamespace(sandbox=self.sandbox, supervise=self.supervise, relay_port=8377)
        result = runner.coding_worker_prompt.run(r, self.workspace, self.home, self.prompt, 600,
            self.progress, read_only=True, on_stop=self.on_stop)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value, {'args': ['--profile', 'headless', '--patch',
            '/home/agent/.dsh/agentx.patch.json', '--patch', '/opt/coding/guard.patch.yml', '--'],
            'bytes': len(self.prompt.encode('utf-8')),
            'sha256': hashlib.sha256(self.prompt.encode('utf-8')).hexdigest()})
        self.assertTrue(self.captured['read_only'])
        self.assertEqual(self.captured['report_request_id'], self.progress.request_id)
        self.assertFalse(self.captured['path'].parent.exists())

    def test_startup_error_removes_only_the_temporary_prompt(self):
        self.home.joinpath('keep.txt').write_text('Existing worker state')
        def fail(*args, **kwargs):
            raise OSError(errno.EIO, 'fixture startup failed')
        r = SimpleNamespace(sandbox=self.sandbox, supervise=fail, relay_port=8377)
        with self.assertRaisesRegex(OSError, 'fixture startup failed'):
            runner.coding_worker_prompt.run(r, self.workspace, self.home, self.prompt, 600,
                None, read_only=False, on_stop=self.on_stop)
        self.assertEqual(self.captured['report_request_id'], '')
        self.assertFalse(self.captured['read_only'])
        self.assertFalse(self.captured['path'].parent.exists())
        self.assertEqual(self.home.joinpath('keep.txt').read_text(), 'Existing worker state')

    def test_sandbox_binds_prompt_read_only_and_retains_source_and_network_isolation(self):
        path = self.root/'private-input.txt'
        path.write_text('Review')
        command = runner.sandbox(self.workspace, self.home, ['true'], network=False, timeout_seconds=600,
            read_only=True, report_request_id=self.progress.request_id, prompt_file=path)
        self.assertIn('--unshare-all', command)
        self.assertNotIn('--share-net', command)
        for source, target in [(str(path), runner.coding_worker_prompt.SANDBOX_PROMPT),
                               (str(self.workspace), '/workspace')]:
            self.assertTrue(any(command[i:i+3] == ['--ro-bind', source, target]
                                for i in range(len(command)-2)))
        self.assertEqual(command[-1], 'true')


if __name__ == '__main__':
    unittest.main()
