"""Native restoration means copied files, an actual reread and proven cleanup."""
from contextlib import redirect_stdout
from copy import deepcopy
from email.message import EmailMessage
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive_preservation as preservation
import archive_restoration as native
import secretary_mail_desk as desk
import test_archive_preservation as fixtures

MID, TID = fixtures.MID, fixtures.TID


@unittest.skipUnless(hasattr(os, 'O_NOFOLLOW') and os.open in os.supports_dir_fd,
                     'Native restoration requires POSIX no-follow directory descriptors')
class NativeRestorationTests(unittest.TestCase):
    save = fixtures.NativePreservationTests.save
    set_raw = fixtures.NativePreservationTests.set_raw

    def setUp(self):
        fixtures.NativePreservationTests.setUp(self)
        self.scratch_base = Path(self.temp.name) / 'scratch'; self.scratch_base.mkdir(mode=0o700)
        temporary = patch.dict(os.environ, {'TMPDIR': str(self.scratch_base)})
        temporary.start(); self.addCleanup(temporary.stop)

    def probe(self, **changes):
        fields = {'root': self.root, 'message_id': MID, 'thread_id': TID,
                  'source_sha256': self.sha, 'request_id': self.request, **changes}
        return native.probe(**fields)

    def preserve(self):
        return preservation.probe(self.root, MID, TID, self.sha, self.request)

    def refused(self, **changes):
        with self.assertRaises(native.RestorationError) as raised:
            self.probe(**changes)
        self.assertNotIn(str(self.root), str(raised.exception))
        self.assertNotIn('private', str(raised.exception))
        self.assertNotIn('synthetic', str(raised.exception))
        return raised.exception

    def empty_scratch(self):
        self.assertEqual(list(self.scratch_base.iterdir()), [])

    def attachment_at(self, parts):
        old = self.attachment
        relative = '/'.join(parts)
        target = self.root.joinpath(*parts); target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(old.read_bytes()); old.unlink(); self.attachment = target
        for item in self.message['attachments']:
            item['path'] = relative
        self.save(self.manifest_file, self.manifest)

    def many_attachments(self, count, *, deep=True):
        mail = EmailMessage(); mail['Message-ID'] = '<synthetic@example.invalid>'
        mail.set_content('Synthetic complete restored source')
        content = b'same copied bytes'
        records = []
        for number in range(count):
            mail.add_attachment(content, maintype='application', subtype='octet-stream', filename=f'{number}.bin')
            relative = f'branch-{number}/a/b/c/file.bin' if deep else f'files/{number}.bin'
            file = self.root / relative; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(content)
            records.append({'partId': str(number), 'path': relative,
                            'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
        mail.set_boundary('synthetic-restoration-boundary')
        self.message['attachments'] = records
        self.set_raw(mail.as_bytes())

    def test_real_copy_rereads_complete_files_and_strict_mime_then_removes_them_before_success(self):
        original = self.preserve()
        expected = {file.relative_to(self.root).as_posix(): file.read_bytes()
                    for file in (self.receipt_file, self.manifest_file, self.raw, self.attachment)}
        before = {file: (file.read_bytes(), preservation.stamp(file.stat())) for file in self.root.rglob('*') if file.is_file()}
        copy = native.copy_files
        seen = {}

        def observed(files, root_fd):
            path = Path(os.readlink(f'/proc/self/fd/{root_fd}'))
            self.assertFalse(path.is_relative_to(self.root))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
            result = copy(files, root_fd)
            seen.update({file.relative_to(path).as_posix(): file.read_bytes() for file in path.rglob('*') if file.is_file()})
            self.assertTrue(all(stat.S_IMODE(file.stat().st_mode) == 0o600 for file in path.rglob('*') if file.is_file()))
            return result

        with patch.object(native, 'copy_files', observed), patch.object(preservation, 'mime_scope', wraps=preservation.mime_scope) as mime:
            value = self.probe()
        self.assertEqual(mime.call_count, 2)
        self.assertEqual(seen, expected)
        self.assertEqual(set(value), set(original) | {'restoration'})
        self.assertEqual({**value, 'contract': preservation.CONTRACT} | {'restoration': None}, original | {'restoration': None})
        self.assertEqual(value['contract'], native.CONTRACT)
        proof = value['restoration']
        self.assertEqual(proof['sourceFilesSha256'], proof['restoredFilesSha256'])
        self.assertRegex(proof['sourceFilesSha256'], r'^[a-f0-9]{64}$')
        self.assertEqual(proof['filesCopied'], len(expected))
        self.assertEqual(proof['bytesCopied'], sum(len(data) for data in expected.values()))
        self.assertTrue(proof['temporaryCopyRemoved'])
        self.empty_scratch()
        self.assertEqual({file: (file.read_bytes(), preservation.stamp(file.stat())) for file in before}, before)
        for hidden in (str(self.root), str(self.scratch_base), 'private', 'synthetic@example.invalid'):
            self.assertNotIn(hidden, json.dumps(value))

    def test_hashes_ignore_nonce_and_scratch_identity_but_include_full_metadata_file_bytes(self):
        first = self.probe()
        second = self.probe(request_id=str(uuid4()))
        self.assertEqual(first['restoration'], second['restoration'])
        self.manifest_file.write_text(json.dumps(self.manifest, indent=2))
        reformatted = self.probe()
        self.assertEqual(first['metadataSha256'], reformatted['metadataSha256'])
        self.assertNotEqual(first['restoration']['sourceFilesSha256'], reformatted['restoration']['sourceFilesSha256'])
        self.empty_scratch()

    def test_fsync_applies_to_private_copied_files_and_directories_only(self):
        fsync = os.fsync
        targets = []
        def synced(fd):
            target = Path(os.readlink(f'/proc/self/fd/{fd}'))
            self.assertTrue(target.is_relative_to(self.scratch_base))
            targets.append(target)
            return fsync(fd)
        with patch.object(native.os, 'fsync', synced):
            self.probe()
        self.assertGreater(len(targets), 10)
        self.empty_scratch()

    def test_partial_system_writes_are_completed_but_zero_progress_refuses(self):
        write = os.write
        def partial(fd, data):
            return write(fd, data[:max(1, len(data) // 2)])
        with patch.object(native.os, 'write', partial):
            self.probe()
        self.empty_scratch()
        with patch.object(native.os, 'write', return_value=0):
            self.assertEqual(self.refused().status, 503)
        self.empty_scratch()

    def test_partial_copy_and_write_or_fsync_errors_never_succeed_and_clean_their_partial_tree(self):
        copy = native.copy_files
        def partial(files, root_fd):
            first = next(iter(files.files.items()))
            copy(SimpleNamespace(files=dict([first])), root_fd)
            raise OSError('synthetic private I/O error')
        with patch.object(native, 'copy_files', partial):
            self.assertEqual(self.refused().status, 503)
        self.empty_scratch()
        def unreported_partial(files, root_fd):
            first = next(iter(files.files.items()))
            return copy(SimpleNamespace(files=dict([first])), root_fd)
        with patch.object(native, 'copy_files', unreported_partial):
            self.refused()
        self.empty_scratch()
        with patch.object(native.os, 'write', side_effect=OSError('synthetic private write failure')):
            self.refused()
        self.empty_scratch()
        fsync, calls = os.fsync, 0
        def failed(fd):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise OSError('synthetic private fsync failure')
            return fsync(fd)
        with patch.object(native.os, 'fsync', failed):
            self.refused()
        self.empty_scratch()

    def test_source_mutation_during_copy_or_replacement_by_identical_metadata_refuses(self):
        copy = native.copy_files
        old = self.raw.read_bytes()
        def changed(files, fd):
            result = copy(files, fd); self.raw.write_bytes(old + b'changed'); return result
        with patch.object(native, 'copy_files', changed):
            self.refused()
        self.raw.write_bytes(old); self.empty_scratch()
        def replaced(files, fd):
            result = copy(files, fd)
            replacement = self.manifest_file.with_suffix('.replacement')
            replacement.write_bytes(self.manifest_file.read_bytes()); os.replace(replacement, self.manifest_file)
            return result
        with patch.object(native, 'copy_files', replaced):
            self.refused()
        self.empty_scratch()

    def test_restored_read_io_failure_is_closed_and_removes_the_temporary_copy(self):
        read = os.read
        def failed(fd, count):
            target = Path(os.readlink(f'/proc/self/fd/{fd}'))
            if target.is_relative_to(self.scratch_base):
                raise OSError('synthetic private restored read failure')
            return read(fd, count)
        with patch.object(native.os, 'read', failed):
            self.assertEqual(self.refused().code, 'SECRETARY_RESTORATION_IO')
        self.empty_scratch()

    def test_source_mutation_during_cleanup_is_fenced_after_the_temporary_copy_is_removed(self):
        remove = native.remove_contents
        changed = False
        def cleanup(fd, **options):
            nonlocal changed
            result = remove(fd, **options)
            if not options.get('depth') and not changed:
                changed = True; self.raw.write_bytes(self.raw.read_bytes() + b'changed')
            return result
        with patch.object(native, 'remove_contents', cleanup):
            self.refused()
        self.assertTrue(changed); self.empty_scratch()

    def test_destination_byte_mutation_identical_replacement_and_extra_member_refuse(self):
        copy = native.copy_files
        for mutation in ('bytes', 'replace', 'missing-file', 'extra-file', 'extra-directory'):
            def changed(files, fd, mutation=mutation):
                result = copy(files, fd); path = Path(os.readlink(f'/proc/self/fd/{fd}'))
                target = path / self.raw.relative_to(self.root)
                if mutation == 'bytes':
                    target.write_bytes(target.read_bytes() + b'changed')
                elif mutation == 'replace':
                    other = target.with_suffix('.replacement'); other.write_bytes(target.read_bytes()); other.chmod(0o600)
                    os.replace(other, target)
                elif mutation == 'missing-file':
                    target.unlink()
                elif mutation == 'extra-file':
                    (path / 'extra').write_bytes(b'synthetic extra')
                else:
                    (path / 'extra').mkdir(mode=0o700)
                return result
            with self.subTest(mutation=mutation), patch.object(native, 'copy_files', changed):
                self.refused()
            self.empty_scratch()

    def test_destination_symlink_or_hardlink_never_redirects_the_reader_or_cleanup(self):
        copy = native.copy_files
        original = self.raw.read_bytes()
        for kind in ('symlink', 'hardlink'):
            def linked(files, fd, kind=kind):
                result = copy(files, fd); path = Path(os.readlink(f'/proc/self/fd/{fd}'))
                target = path / self.raw.relative_to(self.root)
                if kind == 'symlink':
                    target.unlink(); target.symlink_to(self.raw)
                else:
                    os.link(target, path / 'extra-hardlink')
                return result
            with self.subTest(kind=kind), patch.object(native, 'copy_files', linked):
                self.refused()
            self.assertEqual(self.raw.read_bytes(), original); self.empty_scratch()

    def test_late_destination_mutation_during_native_validation_refuses(self):
        finish = preservation.SourceFiles.finish
        changed = False
        def late(files):
            nonlocal changed
            if files.root != self.root and not changed:
                changed = True
                target = files.root / self.raw.relative_to(self.root)
                target.write_bytes(target.read_bytes() + b'changed')
            return finish(files)
        with patch.object(preservation.SourceFiles, 'finish', late):
            self.refused()
        self.assertTrue(changed); self.empty_scratch()

    def test_cleanup_error_or_false_removal_ack_never_reports_a_success(self):
        with patch.object(native, 'remove_contents', side_effect=OSError('synthetic private cleanup failure')):
            error = self.refused()
        self.assertEqual(error.code, 'SECRETARY_RESTORATION_CLEANUP')
        self.assertTrue(all(stat.S_IMODE(path.stat().st_mode) == 0o700 for path in self.scratch_base.iterdir()))
        # The outer fixture owns fault-created scratch leftovers. No success
        # claims they were removed when filesystem cleanup was unavailable.
        import shutil
        for path in self.scratch_base.iterdir():
            shutil.rmtree(path)
        rmdir = os.rmdir
        def not_removed(name, **options):
            if str(name).startswith('agentx-restoration-'):
                return None
            return rmdir(name, **options)
        with patch.object(native.os, 'rmdir', not_removed):
            self.assertEqual(self.refused().code, 'SECRETARY_RESTORATION_CLEANUP')

    def test_temporary_root_replacement_cannot_delete_the_original_archive(self):
        copy = native.copy_files
        original = {file: file.read_bytes() for file in self.root.rglob('*') if file.is_file()}
        def redirected(files, fd):
            result = copy(files, fd); path = Path(os.readlink(f'/proc/self/fd/{fd}'))
            moved = self.scratch_base / 'moved-owned-copy'; path.rename(moved); path.symlink_to(self.root, target_is_directory=True)
            return result
        with patch.object(native, 'copy_files', redirected):
            self.assertEqual(self.refused().code, 'SECRETARY_RESTORATION_CLEANUP')
        self.assertEqual({file: file.read_bytes() for file in original}, original)

    def test_temp_location_inside_archive_refuses_without_an_archive_write(self):
        original = sorted(path.relative_to(self.root).as_posix() for path in self.root.rglob('*'))
        with patch.dict(os.environ, {'TMPDIR': str(self.root)}):
            self.assertEqual(self.refused().code, 'SECRETARY_RESTORATION_LOCATION')
        self.assertEqual(sorted(path.relative_to(self.root).as_posix() for path in self.root.rglob('*')), original)

    def test_actual_cli_with_archive_tmpdir_cannot_probe_or_write_there_before_refusal(self):
        script = '''import json,os,pathlib,sys,tempfile
root=pathlib.Path(sys.argv[1]).resolve()
writes=[]
def audit(event,args):
 if event=='open':
  path,mode,flags=args
  if not isinstance(path,(str,bytes)) or not flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND): return
 elif event in ('os.mkdir','os.remove','os.rmdir','os.rename','os.link','os.symlink','tempfile.mkdtemp'):
  path=args[0]
 else: return
 if isinstance(path,(str,bytes)) and pathlib.Path(os.fsdecode(path)).resolve().is_relative_to(root):
  writes.append(event)
  raise RuntimeError('Forbidden archive write')
sys.addaudithook(audit)
def no_probe(): raise RuntimeError('Forbidden temp directory write probe')
tempfile._get_default_tempdir=no_probe
import secretary_mail_desk
secretary_mail_desk.main(sys.argv[2:])
print(json.dumps({'archiveWriteAttempts':writes}))
'''
        args = ['--evidence-root', str(self.root), 'restoration', '--message', MID, '--thread', TID,
                '--sha256', self.sha, '--request-id', self.request]
        before = {file: (file.read_bytes(), preservation.stamp(file.stat())) for file in self.root.rglob('*') if file.is_file()}
        child = subprocess.run([sys.executable, '-c', script, str(self.root), *args], cwd=self.root,
            capture_output=True, text=True, env={'TMPDIR': str(self.root),
                'PYTHONPATH': str(Path(desk.__file__).parent),
                'OPENCLAW_CONFIG_PATH': str(Path(self.temp.name) / 'missing-config')})
        self.assertEqual(child.returncode, 0); self.assertEqual(child.stderr, '')
        result, audit = [json.loads(line) for line in child.stdout.splitlines()]
        self.assertEqual(result['status'], 'error'); self.assertEqual(result['code'], 'SECRETARY_RESTORATION_LOCATION')
        self.assertEqual(audit['archiveWriteAttempts'], [])
        self.assertEqual({file: (file.read_bytes(), preservation.stamp(file.stat())) for file in before}, before)

    def test_depth32_copies_and_depth33_refuses_without_changing_v1(self):
        self.attachment_at([*(f'd{number}' for number in range(31)), 'attachment.bin'])
        self.probe(); self.empty_scratch()
        self.attachment_at([*(f'x{number}' for number in range(32)), 'attachment.bin'])
        self.preserve()
        self.assertEqual(self.refused().status, 413); self.empty_scratch()

    def test_directory512_boundary_copies_and513_refuses_without_changing_v1(self):
        self.many_attachments(127)
        proof = self.probe()['restoration']
        self.assertEqual(proof['filesCopied'], 130); self.empty_scratch()
        item = self.message['attachments'][0]
        old = self.root / item['path']; target = old.parent / 'deeper/file.bin'
        target.parent.mkdir(); old.rename(target); item['path'] = target.relative_to(self.root).as_posix()
        self.save(self.manifest_file, self.manifest)
        self.preserve()
        self.assertEqual(self.refused().status, 413); self.empty_scratch()

    def test_minimum_three_and_maximum131_files_are_actually_copied(self):
        mail = EmailMessage(); mail['Message-ID'] = '<synthetic@example.invalid>'
        mail.set_content('Synthetic no-attachment original')
        self.message['attachments'] = []; self.set_raw(mail.as_bytes())
        self.assertEqual(self.probe()['restoration']['filesCopied'], 3)
        self.many_attachments(128, deep=False)
        self.assertEqual(self.probe()['restoration']['filesCopied'], 131)
        self.empty_scratch()

    def test_malformed_mime_and_unsupported_host_refuse_before_copy(self):
        with patch.object(native, 'NATIVE_PLATFORM', False), patch.object(native, 'scratch') as temporary:
            self.assertEqual(self.refused().code, 'SECRETARY_RESTORATION_UNSUPPORTED'); temporary.assert_not_called()
        self.set_raw(b'Content-Type: application/octet-stream\nContent-Transfer-Encoding: quoted-printable\n\nprivate=')
        with patch.object(native, 'scratch') as temporary:
            self.refused(); temporary.assert_not_called()
        self.empty_scratch()

    def test_native_input_and_shared_byte_budget_refuse_before_a_temporary_copy(self):
        for changes in ({'message_id': [MID]}, {'request_id': [self.request]}, {'source_sha256': [self.sha]},
                        {'message_id': '../escape'}, {'request_id': 'invalid'}):
            with self.subTest(changes=changes), patch.object(native, 'scratch') as temporary:
                self.assertEqual(self.refused(**changes).status, 400)
                temporary.assert_not_called()
        with patch.object(preservation, 'MAX_BYTES', 100), patch.object(native, 'scratch') as temporary:
            self.assertEqual(self.refused().status, 413); temporary.assert_not_called()
        self.empty_scratch()

    def test_missing_verification_callback_or_changed_machine_identity_is_not_a_proof(self):
        real = preservation._probe
        def ignored(root, *args, **options):
            if Path(root) != self.root:
                return real(root, *args)
            return real(root, *args, **options)
        with patch.object(preservation, '_probe', ignored):
            self.refused()
        self.empty_scratch()
        def machine_changed(files, fd):
            result = native_copy(files, fd); self.machine.write_bytes(b'2' * 32 + b'\n'); return result
        native_copy = native.copy_files
        with patch.object(native, 'copy_files', machine_changed):
            self.refused()
        self.empty_scratch()

    def test_no_descriptor_leak_in_success_and_refused_copy(self):
        count = len(os.listdir('/proc/self/fd'))
        for _ in range(4):
            self.probe()
        with patch.object(native.os, 'write', side_effect=OSError('synthetic write error')):
            for _ in range(4):
                self.refused()
        self.assertEqual(len(os.listdir('/proc/self/fd')), count); self.empty_scratch()

    def test_real_cli_subprocess_runs_without_account_keyring_or_provider(self):
        args = ['--evidence-root', str(self.root), 'restoration', '--message', MID, '--thread', TID,
                '--sha256', self.sha, '--request-id', self.request]
        with patch.object(desk, 'native_settings', return_value={}), patch.dict(os.environ, {}, clear=True), \
                patch.object(desk, 'run_gog', side_effect=AssertionError('No provider call')) as provider, \
                redirect_stdout(io.StringIO()) as out:
            self.assertEqual(desk.main(args), 0)
        value = json.loads(out.getvalue()); self.assertEqual(value['status'], 'success'); provider.assert_not_called()
        child = subprocess.run([sys.executable, desk.__file__, *args], capture_output=True, text=True,
                               env={'OPENCLAW_CONFIG_PATH': str(Path(self.temp.name) / 'missing-config'), 'TMPDIR': str(self.scratch_base)})
        self.assertEqual(child.returncode, 0); self.assertEqual(child.stderr, '')
        actual = json.loads(child.stdout); self.assertEqual(actual['status'], 'success')
        self.assertEqual(actual['data']['restoration'], value['data']['restoration'])
        self.assertEqual(actual['data']['archiveIdSha256'], value['data']['archiveIdSha256'])
        self.empty_scratch()


if __name__ == '__main__':
    unittest.main()
