import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


history = load('coding_opencode_history')
handoff = load('coding_opencode_handoff')
control = load('coding_sessions_control')
KEY = '11111111-2222-4333-8444-555555555555'
OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
SID = 'ses_' + 'a' * 26
MID = 'msg_000000000001' + 'a' * 14
PID = 'prt_000000000002' + 'a' * 14


def native_database(home, sid=SID, messages=None, directory='/workspace'):
    path = home / '.local/share/opencode/opencode.db'
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.executescript('CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY, slug TEXT, project_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);'
        'CREATE TABLE IF NOT EXISTS message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);'
        'CREATE TABLE IF NOT EXISTS part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);')
    connection.execute('INSERT INTO session VALUES(?,?,?,?,?,?,?,?)', (sid, 'fixture', 'global', directory, 'Fixture', '1.19.3', 1, 2))
    messages = messages if messages is not None else [{'info': {'id': MID, 'sessionID': sid, 'role': 'user',
        'time': {'created': 1}, 'agent': 'build', 'model': {'providerID': 'agentx-core', 'modelID': 'agentx-primary'}},
        'parts': [{'id': PID, 'sessionID': sid, 'messageID': MID, 'type': 'text', 'text': 'Private synthetic content <script>bad()</script>'}]}]
    for message in messages:
        connection.execute('INSERT INTO message VALUES(?,?,?)', (message['info']['id'], sid,
            json.dumps({k: v for k, v in message['info'].items() if k not in ('id', 'sessionID')})))
        for part in message['parts']:
            connection.execute('INSERT INTO part VALUES(?,?,?,?)', (part['id'], sid, message['info']['id'],
                json.dumps({k: v for k, v in part.items() if k not in ('id', 'sessionID', 'messageID')})))
    connection.commit()
    return connection


class NativeSessionsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.home, self.workspace, self.receipts = [self.root / x for x in ('worker', 'workspace', 'receipts')]
        for path in (self.home, self.workspace, self.receipts): path.mkdir()
        self.progress = SimpleNamespace(task_id='0001', request_id=KEY, path=self.receipts / (KEY + '.progress.json'))
        history.atomic(self.receipts / (KEY + '.json'), {'pipelineId': '0001', 'requestId': KEY})
        self.capture = history.Capture(self.progress, self.home, self.workspace)

    def bind(self):
        output = self.root / 'stdout'
        output.write_text(json.dumps({'type': 'step_start', 'sessionID': SID}) + '\n')
        self.capture.scan(output)
        return self.capture.value

    def test_stdout_binds_only_this_core_invocation_and_retries_torn_records(self):
        output = self.root / 'stdout'
        output.write_text('diagnostic\n' + json.dumps({'sessionID': SID}))
        self.capture.scan(output)
        self.assertIsNone(history.read_json(self.capture.path)['nativeSessionId'])
        with output.open('a') as stream: stream.write('\n')
        self.capture.scan(output)
        self.assertEqual(history.read_json(self.capture.path)['nativeSessionId'], SID)
        self.assertNotIn('Private', self.capture.path.read_text())
        with output.open('a') as stream: stream.write(json.dumps({'sessionID': 'ses_other'}) + '\n')
        with self.assertRaisesRegex(history.SessionError, 'conflicting'):
            self.capture.scan(output)

    def test_native_read_sees_committed_wal_and_never_opens_the_db_for_writes(self):
        value = self.bind()
        writer = native_database(self.home)
        self.addCleanup(writer.close)
        writer.execute('PRAGMA journal_mode=WAL')
        first = history.read(value)
        self.assertEqual(first['messages'][0]['parts'][0]['text'], 'Private synthetic content <script>bad()</script>')
        self.assertFalse(first['canHandoff'])
        writer.execute('UPDATE part SET data=? WHERE id=?', (json.dumps({'type': 'text', 'text': 'Committed new native event'}), PID))
        writer.commit()
        second = history.read(value)
        self.assertNotEqual(first['revision'], second['revision'])
        self.assertEqual(second['messages'][0]['parts'][0]['text'], 'Committed new native event')
        with self.assertRaisesRegex(history.SessionError, 'changed'):
            history.read(value, expected_revision=first['revision'])
        self.capture.finish(0)
        self.assertTrue(history.read(self.capture.value)['canHandoff'])

    def test_exact_request_and_binding_conflicts_refuse_instead_of_discovering_other_homes(self):
        self.bind()
        self.assertEqual(len(history.bindings(self.receipts, '0001', KEY)), 1)
        with self.assertRaisesRegex(history.SessionError, 'does not match'):
            history.bindings(self.receipts, '0002', KEY)
        value = history.read_json(self.capture.path)
        value['requestId'] = OTHER
        history.atomic(self.capture.path, value)
        with self.assertRaisesRegex(history.SessionError, 'conflicts'):
            history.bindings(self.receipts, '0001', KEY)

    def test_missing_or_symlinked_databases_never_fall_back_to_an_old_session(self):
        value = self.bind()
        with self.assertRaises(history.SessionError): history.read(value)
        db = self.home / '.local/share/opencode/opencode.db'
        db.parent.mkdir(parents=True)
        outside = self.root / 'private-host-db'
        outside.write_text('host-only')
        db.symlink_to(outside)
        with self.assertRaises(history.SessionError): history.read(value)
        db.unlink()
        moved = self.root / 'moved-home'
        self.home.rename(moved)
        self.home.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(history.SessionError, 'identity'):
            history.read(value)

    def test_control_keeps_executor_and_request_identity_and_never_loads_a_worker(self):
        self.bind()
        with mock.patch.object(control.control, 'RECEIPTS', self.receipts):
            value = control.execute('list', '0001', KEY, 'fixture-open')
            self.assertEqual(value['executorId'], 'fixture-open')
            self.assertEqual(value['sessions'][0]['requestId'], KEY)
            with self.assertRaises(Exception): control.execute('list', '0002', KEY, 'fixture-open')
            with self.assertRaises(Exception): control.execute('read', '0001', KEY, 'fixture-open', '../outside', '0', '-')
            writer = native_database(self.home); writer.close()
            self.capture.finish(0)
            with mock.patch.object(control.control, 'setting', return_value=''):
                page = control.execute('read', '0001', KEY, 'fixture-open', self.capture.value['invocationId'], '0', '-')
            self.assertFalse(page['handoffConfigured'])
            self.assertFalse(page['canHandoff'])
            self.assertEqual(len(page['messages']), 1)

    def test_rekey_preserves_historical_payloads_and_does_not_collide_between_handoffs(self):
        writer = native_database(self.home); writer.close()
        source = history.snapshot(self.home, SID)
        one = handoff.rekey(source, KEY, self.root / 'copy-one', '0001', 1794021301000)
        two = handoff.rekey(source, OTHER, self.root / 'copy-two', '0001', 1794021301000)
        self.assertNotEqual(one['messages'][0]['info']['id'], two['messages'][0]['info']['id'])
        self.assertEqual(one['messages'][0]['parts'][0]['text'], source['messages'][0]['parts'][0]['text'])
        self.assertEqual(one['messages'][0]['info']['time'], source['messages'][0]['info']['time'])
        self.assertIn('independent copy', one['messages'][-1]['parts'][0]['text'])
        self.assertEqual(source['info']['directory'], '/workspace')
        source['messages'][0]['parts'] = [{'id': PID, 'type': 'tool', 'state': {'status': 'running'}}]
        with self.assertRaisesRegex(handoff.SessionError, 'in-flight'):
            handoff.rekey(source, KEY, self.root / 'copy', '0001', 1794021301000)

    def test_handoff_retries_a_lost_receipt_by_reading_the_existing_import_only(self):
        source = self.bind()
        self.capture.finish(0)
        source = self.capture.value
        writer = native_database(self.home); writer.close()
        revision = history.digest(history.snapshot(self.home, SID))
        state, human = self.root / 'handoffs', self.root / 'human'
        state.mkdir(); human.mkdir()
        directory = state / OTHER
        directory.mkdir()
        workspace = directory / 'workspace'
        workspace.mkdir()
        planned = handoff.rekey(history.snapshot(self.home, SID), OTHER, workspace, '0001', 1794021301000)
        receipt = {'pipelineId': '0001', 'requestId': KEY, 'invocationId': source['invocationId'],
            'sourceSessionId': SID, 'handoffRequestId': OTHER, 'sourceRevision': revision, 'state': 'importing',
            'importHash': history.digest(planned['messages'])}
        history.atomic(directory / 'receipt.json', receipt)
        db = native_database(human, sid=planned['info']['id'], messages=planned['messages'], directory=str(workspace)); db.close()
        with mock.patch.object(handoff, 'native', side_effect=AssertionError('must not repeat an effect')):
            received = handoff.handoff(source, OTHER, revision, state_root=state, human_home=human,
                binary=Path('/unused'), origin='https://opencode.example')
        self.assertEqual(received['state'], 'ready')

    def test_handoff_refuses_active_workers_conflicting_intents_and_worker_state_overlap(self):
        source = self.bind()
        common = {'state_root': self.root / 'handoffs', 'human_home': self.root / 'human',
                  'binary': Path('/unused'), 'origin': 'https://opencode.example'}
        with self.assertRaisesRegex(handoff.SessionError, 'exit'):
            handoff.handoff(source, OTHER, 'a' * 64, **common)
        with self.assertRaisesRegex(handoff.SessionError, 'independent'):
            handoff.handoff(source, OTHER, 'a' * 64, **{**common, 'human_home': self.home})
        with self.assertRaises(handoff.SessionError): handoff.human_url('javascript:bad', self.root, SID)

    def test_failed_copy_keeps_one_incomplete_receipt_and_never_repeats_its_effects(self):
        source = self.bind(); self.capture.finish(0); source = self.capture.value
        writer = native_database(self.home); writer.close()
        revision = history.digest(history.snapshot(self.home, SID))
        common = {'state_root': self.root / 'handoffs', 'human_home': self.root / 'human',
                  'binary': Path('/unused'), 'origin': 'https://opencode.example'}
        with mock.patch.object(handoff, 'native', side_effect=handoff.SessionError('Synthetic copy failure')) as native:
            with self.assertRaisesRegex(handoff.SessionError, 'copy failure'):
                handoff.handoff(source, OTHER, revision, **common)
            self.assertEqual(native.call_count, 1)
        receipt = history.read_json(common['state_root'] / OTHER / 'receipt.json')
        self.assertEqual(receipt['state'], 'incomplete')
        with mock.patch.object(handoff, 'native', side_effect=AssertionError('no effect may be retried')):
            with self.assertRaisesRegex(handoff.SessionError, 'incomplete'):
                handoff.handoff(source, OTHER, revision, **common)
            with self.assertRaisesRegex(handoff.SessionError, 'another source'):
                handoff.handoff(source, OTHER, 'b' * 64, **common)

    def test_large_messages_and_session_snapshots_fail_explicitly_without_truncation(self):
        source = self.bind()
        writer = native_database(self.home)
        self.addCleanup(writer.close)
        writer.execute('UPDATE part SET data=?', (json.dumps({'type': 'text', 'text': 'x' * (2 * 1024 * 1024)}),))
        writer.commit()
        with self.assertRaises(history.SessionError) as error:
            history.read(source)
        self.assertEqual(error.exception.status, 413)
        with mock.patch.object(history, 'MAX_BYTES', 1024):
            with self.assertRaises(history.SessionError) as error:
                history.snapshot(self.home, SID)
            self.assertEqual(error.exception.status, 413)
        writer.execute('UPDATE session SET title=?', ('x' * 65537,)); writer.commit()
        with self.assertRaisesRegex(history.SessionError, 'header') as error:
            history.snapshot(self.home, SID)
        self.assertEqual(error.exception.status, 413)

    def test_launch_preparation_failure_retains_an_uncertain_binding(self):
        prompt = load('coding_worker_prompt')
        runtime = SimpleNamespace(harness=SimpleNamespace(invocation=lambda *args: {'command': ['fixture'], 'environment': {}, 'binds': []}),
            relay_port=8377, sandbox=mock.Mock(side_effect=RuntimeError('synthetic preparation failure')))
        with self.assertRaisesRegex(RuntimeError, 'preparation failure'):
            prompt.run(runtime, self.workspace, self.home, 'Fixture prompt', 10, self.progress,
                read_only=False, on_stop=None, harness='opencode', model='agentx-primary')
        values = history.bindings(self.receipts, '0001', KEY)
        self.assertEqual([v['state'] for v in values].count('uncertain'), 1)

    def test_overlong_stdout_cannot_hold_the_observer_on_a_torn_record_forever(self):
        output = self.root / 'stdout'
        output.write_bytes(b'x' * (4 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(history.SessionError, 'bound'):
            self.capture.scan(output)


if __name__ == '__main__':
    unittest.main()
