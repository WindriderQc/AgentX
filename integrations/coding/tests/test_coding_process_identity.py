import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('identity', Path(__file__).resolve().parents[1] / 'coding_process_identity.py')
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class InstallationProcessesTest(unittest.TestCase):
    def test_executable_and_script_paths_match_but_embedded_command_text_does_not(self):
        with tempfile.TemporaryDirectory() as t:
            proc = Path(t)
            for pid, exe, args in [(1, '/isolated/bin/server', ['server']),
                                   (2, '/usr/bin/python3', ['python3', '-c', "root='/isolated'; print(root)"]),
                                   (3, '/usr/bin/python3', ['python3', '/isolated/bin/control.py']),
                                   (4, '/isolated-other/server', ['server'])]:
                p = proc / str(pid); p.mkdir(); (p / 'exe').symlink_to(exe)
                (p / 'cmdline').write_bytes(b'\0'.join(x.encode() for x in args))
            self.assertEqual([x['pid'] for x in identity.installation_processes('/isolated', proc)], [1, 3])

    def test_disappearing_process_is_not_a_live_match(self):
        with tempfile.TemporaryDirectory() as t:
            (Path(t) / '1').mkdir()
            self.assertEqual(identity.installation_processes('/isolated', t), [])

    def test_unreadable_own_process_does_not_prove_termination(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as t:
            (Path(t) / '1').mkdir()
            with patch.object(os, 'readlink', side_effect=PermissionError('uncertain')):
                with self.assertRaises(PermissionError): identity.installation_processes('/isolated', t)


if __name__ == '__main__': unittest.main()
