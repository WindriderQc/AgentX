"""Recovery publication and replay tests use synthetic data, never live services."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recovery_set import cli
from recovery_set.common import digest, save, seal, verify
from recovery_set.openclaw import stage_home
from recovery_set.queue import Queue, Uncertain
from recovery_set.replica import REMOTE, local_retention, replicate
import importlib
capture_module = importlib.import_module('recovery_set.capture')
from host_jobs import handlers, transport
from host_jobs.worker import Worker


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'private'
        self.root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def generation(self, root=None, identifier=None, stamp='2026-01-01T00:00:00+00:00'):
        identifier = identifier or str(uuid.uuid4())
        path = (root or self.root) / 'generations' / identifier
        path.mkdir(parents=True)
        (path / 'memory.txt').write_text('A complete synthetic memory\n')
        manifest = seal(path, {'generation': identifier, 'completedAt': stamp})
        save((root or self.root) / 'latest.private.json', {'generation': identifier,
             'completedAt': manifest['completedAt'], 'manifestSha256': digest(path / 'manifest.private.json')})
        return path, manifest

    def remote(self, action, config, check=True):
        return subprocess.run([sys.executable, '-c', REMOTE, action, json.dumps(config)], capture_output=True, text=True, check=check)

    def replica_args(self, path):
        return {'root': str(self.root / 'destination'), 'generation': path.name, 'keep': 2,
                'bytes': 100, 'minFreeBytes': 0, 'manifestSha256': digest(path / 'manifest.private.json')}

    def test_sealed_generation_detects_modified_content(self):
        path, _ = self.generation()
        verify(path)
        (path / 'memory.txt').write_text('Changed')
        with self.assertRaises(ValueError):
            verify(path)

    def test_manifest_rejects_traversal_duplicate_and_symlink(self):
        path, manifest = self.generation()
        for name in ('../outside', '.', '..', 'manifest.private.json'):
            invalid = {**manifest, 'artifacts': [{**manifest['artifacts'][0], 'file': name}]}
            save(path / 'manifest.private.json', invalid)
            with self.assertRaises(ValueError):
                verify(path)
        save(path / 'manifest.private.json', {**manifest, 'artifacts': manifest['artifacts'] * 2})
        with self.assertRaises(ValueError):
            verify(path)
        save(path / 'manifest.private.json', manifest)
        (path / 'memory.txt').unlink()
        (path / 'memory.txt').symlink_to(self.root / 'outside')
        with self.assertRaises(ValueError):
            verify(path)

    def test_partial_replica_never_replaces_last_good(self):
        first, _ = self.generation(stamp='2026-01-01T00:00:00Z')
        args = self.replica_args(first)
        self.remote('prepare', args)
        incoming = Path(args['root']) / ('.incoming-' + first.name)
        shutil.copytree(first, incoming, dirs_exist_ok=True)
        self.remote('commit', args)
        second, _ = self.generation(stamp='2026-01-02T00:00:00Z')
        new = self.replica_args(second)
        self.remote('prepare', new)
        shutil.copytree(second, Path(new['root']) / ('.incoming-' + second.name), dirs_exist_ok=True)
        (Path(new['root']) / ('.incoming-' + second.name) / 'memory.txt').write_text('Truncated')
        self.assertNotEqual(self.remote('commit', new, check=False).returncode, 0)
        self.assertEqual(json.loads((Path(new['root']) / 'latest.private.json').read_text())['generation'], first.name)

    def test_lost_commit_response_reconciles_same_generation(self):
        source, _ = self.generation()
        args = self.replica_args(source)
        self.remote('prepare', args)
        shutil.copytree(source, Path(args['root']) / ('.incoming-' + source.name), dirs_exist_ok=True)
        self.remote('commit', args)
        result = json.loads(self.remote('prepare', args).stdout)
        self.assertTrue(result['verified'])
        self.assertEqual(result['generation'], source.name)
        self.assertEqual(len(list((Path(args['root']) / 'generations').iterdir())), 1)

    def test_replica_refuses_foreign_root_and_low_space(self):
        source, _ = self.generation()
        args = self.replica_args(source)
        dest = Path(args['root'])
        dest.mkdir()
        (dest / 'foreign').write_text('Preserve')
        self.assertNotEqual(self.remote('prepare', args, check=False).returncode, 0)
        self.assertTrue((dest / 'foreign').exists())
        args['root'] = str(self.root / 'empty-destination')
        args['minFreeBytes'] = 2 ** 63
        self.assertNotEqual(self.remote('prepare', args, check=False).returncode, 0)

    def test_replica_retention_preserves_two_complete_generations(self):
        for day in range(1, 5):
            source, _ = self.generation(stamp=f'2026-01-0{day}T00:00:00Z')
            args = self.replica_args(source)
            self.remote('prepare', args)
            shutil.copytree(source, Path(args['root']) / ('.incoming-' + source.name), dirs_exist_ok=True)
            self.remote('commit', args)
        dest = Path(args['root'])
        self.assertEqual(len(list((dest / 'generations').iterdir())), 2)
        self.assertTrue((dest / 'generations' / source.name).exists())

    def test_local_retention_requires_verified_offhost_receipt(self):
        paths = []
        for day in range(1, 5):
            p, _ = self.generation(stamp=f'2026-01-0{day}T00:00:00Z')
            paths.append(p)
            if day != 1:
                save(self.root / 'replicas' / (p.name + '.private.json'), {'verified': True, 'generation': p.name,
                     'manifestSha256': digest(p / 'manifest.private.json')})
        local_retention(self.root, 2)
        self.assertTrue(paths[0].exists())  # No proof of off-host copy.
        self.assertFalse(paths[1].exists())
        self.assertTrue(paths[2].exists() and paths[3].exists())

    def test_online_sqlite_snapshot_keeps_wal_content_and_live_configuration(self):
        home, stage, artifacts = (self.root / n for n in ('home', 'stage', 'artifacts'))
        home.mkdir(); artifacts.mkdir()
        config = {'agents': {'workspace': str(home / 'workspace')}}
        save(home / 'openclaw.json', config)
        connection = sqlite3.connect(home / 'memory.sqlite')
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('CREATE TABLE memories(content TEXT)')
        connection.execute('INSERT INTO memories VALUES (?)', ('Useful WAL memory',))
        connection.commit()
        (home / 'SOUL.md').write_text('Personality variant')
        (home / 'soul-link').symlink_to(home / 'SOUL.md')
        (home / 'external').symlink_to(self.root / 'missing-runtime')
        old = home / 'archive-disabled'; old.mkdir()
        (old / 'retired-link').symlink_to('/retired/dependency')
        stage_home(home, stage, artifacts, ['archive-disabled'])
        with sqlite3.connect(stage / 'memory.sqlite') as restored:
            self.assertEqual(restored.execute('SELECT content FROM memories').fetchall(), [('Useful WAL memory',)])
        self.assertEqual(json.loads((home / 'openclaw.json').read_text()), config)
        self.assertEqual(json.loads((stage / 'openclaw.json').read_text())['agents']['workspace'], str(stage / 'workspace'))
        self.assertEqual((stage / 'soul-link').read_text(), 'Personality variant')
        self.assertFalse((stage / 'external').exists())
        self.assertTrue((artifacts / 'openclaw-historical.tar.gz').exists())
        connection.close()

    def test_destination_outage_keeps_capture_and_does_not_claim_verified(self):
        source, _ = self.generation()
        with patch('recovery_set.replica.remote', side_effect=RuntimeError('Offline')):
            with self.assertRaises(RuntimeError):
                replicate({'root': str(self.root), 'replica': {'root': '/private/destination', 'sshTarget': 'offline'}})
        self.assertTrue(source.exists())
        self.assertFalse((self.root / 'replica-latest.private.json').exists())

    def test_queue_finishes_only_exact_original_dispatch(self):
        cfg = {'coreUrl': 'http://core', 'actor': 'recovery', 'hosts': ['http://host:3180'], 'source': {'type': 'coding', 'taskId': 'synthetic'}}
        queue = Queue(cfg, self.root, str(uuid.uuid4()))
        jobs = [dict(id='native-id', state='requested', revision=1), dict(id='native-id', state='reserved', revision=2),
                dict(id='native-id', state='running', revision=3, dispatchId='dispatch-one')]
        with patch.object(queue, 'api', side_effect=jobs):
            queue.admit()
        with patch.object(queue, 'api', side_effect=[jobs[-1], dict(id='native-id', state='completed', revision=4)]) as api:
            queue.finish(True)
        receipt = json.loads((self.root / 'operator-terminal.private.json').read_text())
        self.assertEqual(receipt['dispatchId'], 'dispatch-one')
        self.assertTrue(receipt['runtimeReleased'])
        self.assertEqual(api.call_args.args[1]['dispatchId'], 'dispatch-one')

    def test_unknown_capture_blocks_new_identity_without_another_effect(self):
        prior = str(uuid.uuid4())
        save(self.root / 'active.private.json', {'requestId': prior})
        save(self.root / 'runs' / prior / 'capture.private.json', {'state': 'unknown'})
        path = self.root / 'config.json'
        save(path, {'version': 1, 'root': str(self.root)})
        with patch('recovery_set.cli.capture') as effect, contextlib.redirect_stdout(io.StringIO()):
            result = cli.main(['capture', '--config', str(path), '--request-id', str(uuid.uuid4())])
        self.assertEqual(result, 3)
        effect.assert_not_called()

    def test_offline_replica_is_deferred_and_retried_by_normal_cadence(self):
        config = self.root / 'config.json'
        save(config, {'version': 1, 'root': str(self.root)})
        with patch('recovery_set.cli.replicate', side_effect=RuntimeError('Offline')), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['replicate', '--config', str(config), '--request-id', str(uuid.uuid4())]), 0)
        receipt = json.loads((self.root / 'replicate-latest.private.json').read_text())
        self.assertFalse(receipt['verified'])
        self.assertEqual(receipt['attemptState'], 'deferred')
        self.assertFalse(receipt['fresh'])

    def test_named_handler_has_no_shell_and_only_public_metrics(self):
        job = {'kind': 'recovery-capture', 'options': {'python': sys.executable, 'script': '/runtime/recovery-set.py',
               'config': '/private/config.json', 'stateRoot': '/private/recovery'}}
        command, _, env, receipt = handlers.prepare(job, str(uuid.uuid4()))
        self.assertEqual(command[2:], ['capture', '--config', '/private/config.json'])
        self.assertTrue(env['AGENTX_OPERATION_REQUEST_ID'])
        self.assertEqual(receipt.name, 'capture-latest.private.json')

    def test_local_supervisor_transport_uses_exact_worker_arguments(self):
        identity = str(uuid.uuid4())
        native = {'status': 'success', 'contract': 'agentx.operations-worker/v1', 'data': {'requestId': identity}}
        result = subprocess.CompletedProcess([], 0, json.dumps(native), '')
        with patch('host_jobs.transport.subprocess.run', return_value=result) as command:
            transport.call({'transport': 'local', 'sshTarget': 'localhost', 'python': sys.executable, 'root': str(self.root)},
                           'run', 'recovery', identity)
        arguments = command.call_args.args[0]
        self.assertNotIn('ssh', arguments)
        self.assertEqual(arguments[-4:], ['--job', 'recovery', '--request', identity])

    def test_worker_keeps_uncertain_native_effect_fenced(self):
        save(self.root / 'config.json', {'version': 1, 'jobs': [{'id': 'recovery', 'kind': 'recovery-capture'}]})
        worker = Worker(self.root)
        child = unittest.mock.Mock(pid=123)
        child.wait.return_value = 3
        with patch('host_jobs.worker.handlers.prepare', return_value=([sys.executable], None, os.environ, None)), \
             patch('host_jobs.worker.subprocess.Popen', return_value=child):
            result = worker.run('recovery', str(uuid.uuid4()))
        self.assertEqual(result['state'], 'unknown')
        self.assertEqual(result['code'], 'NATIVE_OUTCOME_UNKNOWN')
        with self.assertRaises(Exception):
            worker.run('recovery', str(uuid.uuid4()))

    def test_failed_native_restore_cannot_publish_a_new_generation(self):
        import gzip
        previous, _ = self.generation()
        config = {'root': str(self.root), 'queue': {}, 'mongo': {'container': 'synthetic', 'database': 'synthetic'},
                  'qdrant': {}, 'privatePaths': [], 'repositories': [], 'scope': [], 'sourceHost': 'synthetic'}
        def native(args, log, env=None, output=None):
            if output:
                with gzip.open(output, 'wb') as stream:
                    stream.write(b'synthetic logical dump')
        def qdrant(config, work, artifacts):
            (artifacts / 'qdrant-full-storage.snapshot').write_bytes(b'synthetic snapshot')
        with patch.object(capture_module, 'Queue') as queue, \
             patch.object(capture_module, 'shared_fingerprint', return_value={'stable': True}), \
             patch.object(capture_module, 'run', side_effect=native), \
             patch.object(capture_module, 'capture_qdrant', side_effect=qdrant), \
             patch.object(capture_module, 'validate', side_effect=RuntimeError('Native restore refused')):
            with self.assertRaises(RuntimeError):
                capture_module.capture(config, str(uuid.uuid4()))
        self.assertEqual(json.loads((self.root / 'latest.private.json').read_text())['generation'], previous.name)
        queue.return_value.finish.assert_called_once_with(False)

    def test_critical_change_refreshes_before_the_full_interval(self):
        path, _ = self.generation(stamp=cli.now())
        save(self.root / 'config.json', {'version': 1, 'root': str(self.root), 'refreshOnCriticalChange': True,
             'minimumCaptureIntervalSeconds': 86400})
        with patch('recovery_set.cli.shared_fingerprint', return_value={'changed': True}), \
             patch('recovery_set.cli.capture', return_value={'artifacts': []}) as effect, \
             contextlib.redirect_stdout(io.StringIO()):
            cli.main(['capture', '--config', str(self.root / 'config.json'), '--request-id', str(uuid.uuid4())])
        effect.assert_called_once()

    def test_two_good_replicas_survive_a_third_incomplete_transfer(self):
        for day in (1, 2):
            source, _ = self.generation(stamp=f'2026-01-0{day}T00:00:00Z')
            args = self.replica_args(source)
            self.remote('prepare', args)
            shutil.copytree(source, Path(args['root']) / ('.incoming-' + source.name), dirs_exist_ok=True)
            self.remote('commit', args)
        third, _ = self.generation(stamp='2026-01-03T00:00:00Z')
        args = self.replica_args(third)
        self.remote('prepare', args)
        self.assertEqual(len(list((Path(args['root']) / 'generations').iterdir())), 2)

    def test_lost_release_answer_uses_exact_native_receipt_without_replay(self):
        from recovery_set.common import digest
        queue = Queue({'actor': 'recovery'}, self.root, str(uuid.uuid4()))
        queue.job = {'id': 'native-id', 'dispatchId': 'dispatch', 'revision': 3, 'state': 'dispatching'}
        calls = []
        def native(suffix='', body=None):
            calls.append((suffix, body))
            if body:
                raise TimeoutError('Response lost after native finish')
            if len(calls) == 1:
                return queue.job
            receipt = self.root / 'operator-terminal.private.json'
            return {**queue.job, 'state': 'completed', 'releaseReceipt': {'receiptRef': str(receipt), 'receiptSha256': digest(receipt)}}
        with patch.object(queue, 'api', side_effect=native):
            queue.finish(True)
        self.assertEqual(queue.job['state'], 'completed')
        self.assertEqual(sum(body is not None for _, body in calls), 1)

    def test_capacity_uses_native_terminal_archive_before_admission(self):
        cfg = {'actor': 'recovery', 'hosts': ['http://host:3180'], 'source': {'type': 'coding'}, 'archiveTerminalAtCount': 300}
        queue = Queue(cfg, self.root, str(uuid.uuid4()))
        responses = [{'count': 389}, {'archived': 300},
                     {'id': 'native', 'state': 'requested', 'revision': 1},
                     {'id': 'native', 'state': 'reserved', 'revision': 2},
                     {'id': 'native', 'state': 'dispatching', 'revision': 3, 'dispatchId': 'exact'}]
        with patch.object(queue, 'api', side_effect=responses) as api:
            queue.admit()
        self.assertEqual(api.call_args_list[1].args, ('/archive', {}))
        self.assertTrue((self.root / 'queue-archive.private.json').exists())

    def test_source_refresh_does_not_abandon_pending_transfer_identity(self):
        first, _ = self.generation()
        save(self.root / 'replica-pending.private.json', {'generation': first.name,
             'manifestSha256': digest(first / 'manifest.private.json')})
        second, _ = self.generation(stamp='2026-01-02T00:00:00Z')
        cfg = {'root': str(self.root), 'replica': {'root': '/private/destination', 'sshTarget': 'backup'}}
        calls = []
        def remote(cfg, action, args):
            calls.append(args['generation'])
            return {'verified': True, 'manifestSha256': args['manifestSha256'], 'generation': args['generation']}
        with patch('recovery_set.replica.remote', side_effect=remote):
            result = replicate(cfg)
        self.assertEqual(calls, [first.name, second.name])
        self.assertEqual(result['generation'], second.name)
        self.assertFalse((self.root / 'replica-pending.private.json').exists())

    def native_release(self):
        import hashlib
        operator = {'contract': 'agentx.operator-heavy-work/v1', 'queueRequestId': str(uuid.uuid4()),
                    'dispatchId': str(uuid.uuid4()), 'receiptRef': '/private/terminal.json',
                    'state': 'completed', 'runtimeReleased': True}
        text = json.dumps(operator, indent=2) + '\n'
        ack = {'state': 'completed', 'operationId': operator['dispatchId'], 'receiptRef': operator['receiptRef'],
               'receiptSha256': hashlib.sha256(text.encode()).hexdigest()}
        return {'operatorReceipt': text, 'coreReleaseReceipt': ack,
                'queueRequestId': operator['queueRequestId'], 'dispatchId': operator['dispatchId']}

    def test_offhost_release_keeps_exact_bytes_and_matching_core_ack(self):
        source, _ = self.generation()
        args = {**self.replica_args(source), 'requireReleaseReceipt': True, 'sourceRelease': self.native_release()}
        self.remote('prepare', args)
        shutil.copytree(source, Path(args['root']) / ('.incoming-' + source.name), dirs_exist_ok=True)
        result = json.loads(self.remote('commit', args).stdout)
        self.assertTrue(result['nativeReleaseVerified'])
        proofs = Path(args['root']) / 'source-releases'
        self.assertEqual((proofs / (source.name + '-operator-terminal.private.json')).read_text(), args['sourceRelease']['operatorReceipt'])
        ack = json.loads((proofs / (source.name + '-core-release.private.json')).read_text())
        self.assertEqual(ack, args['sourceRelease']['coreReleaseReceipt'])
        self.assertTrue(json.loads(self.remote('prepare', args).stdout)['nativeReleaseVerified'])

    def test_unacknowledged_release_cannot_publish_a_recovery_copy(self):
        source, _ = self.generation()
        args = {**self.replica_args(source), 'requireReleaseReceipt': True, 'sourceRelease': self.native_release()}
        args['sourceRelease']['coreReleaseReceipt']['receiptSha256'] = '0' * 64
        self.remote('prepare', args)
        shutil.copytree(source, Path(args['root']) / ('.incoming-' + source.name), dirs_exist_ok=True)
        self.assertNotEqual(self.remote('commit', args, check=False).returncode, 0)
        self.assertFalse((Path(args['root']) / 'latest.private.json').exists())

    def test_required_release_is_checked_before_any_remote_transfer(self):
        self.generation()
        cfg = {'root': str(self.root), 'requireReleaseReceipt': True,
               'replica': {'root': '/private/destination', 'sshTarget': 'backup'}}
        with patch('recovery_set.replica.remote') as effect:
            with self.assertRaises(FileNotFoundError):
                replicate(cfg)
        effect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
