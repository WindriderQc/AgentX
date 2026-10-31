"""Native recording evidence, attribution and honest missing measurements."""
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from run_metrics import run_metrics, summary
from world_metrics import read_actions, run_hours


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'recordings').mkdir()
        self.put('request.json', {'harness': 'pi', 'agent': 'Eko', 'minutes': 60})
        self.put('state.json', {'outcome': 'completed', 'startedAt': '2026-01-01T00:00:00Z',
                               'endedAt': '2026-01-01T01:00:20Z'})
        self.put('receipt.json', {'episodes': [{'startedAt': '2026-01-01T00:00:00Z',
                                               'endedAt': '2026-01-01T01:00:00Z'}]})

    def tearDown(self): self.temp.cleanup()

    def put(self, name, data): (self.root / name).write_text(json.dumps(data))

    def graph(self, *rows):
        p = self.root / 'world.ndjson'
        p.write_text('\n'.join(json.dumps(r) for r in [
            {'kind': 'hello', 'format': 'graphysx-world-stream/v1', 'tick': 0}, *rows]) + '\n')
        return p

    def action(self, tick, kind='Place', result='PlaceSuccess', agent='Eko'):
        return {'kind': 'action', 'tick': tick, 'agent': agent, 'input': {'type': kind}, 'result': result}

    def claw(self, rows):
        p = self.root / 'recordings' / 'fixture.clawrec'
        with sqlite3.connect(p) as db:
            db.execute('CREATE TABLE inputs (tick INTEGER, agent_id TEXT, input_type TEXT)')
            db.executemany('INSERT INTO inputs VALUES (?,?,?)', rows)
        return p

    def test_hidden_script_actions_and_results_are_counted_from_the_world(self):
        # No /input in the rollout: a script made three commands anyway.
        home = self.root / 'agents' / 'eko' / 'sandbox-home' / '.agentx-loop' / 'sessions'
        home.mkdir(parents=True)
        (home / 'rollout-fixture.jsonl').write_text(json.dumps({'type': 'response_item', 'payload': {
            'type': 'function_call', 'call_id': 'c', 'arguments': 'python3 play.py'}}) + '\n')
        p = self.graph(self.action(1), self.action(2, result='PlaceFailed:OutOfRange'), self.action(3))
        d = run_metrics(self.root, recording=p)
        self.assertEqual(d['worldCommandCalls'], 0)
        self.assertEqual(d['worldActions'], {'Place': 3})
        self.assertEqual(d['placeSuccess'], 2)
        self.assertEqual(d['placeSuccessRate'], .667)
        self.assertEqual(d['placeSuccessPerHour'], 2)
        self.assertIsNone(d['outputTokensPerPlace'], 'rollout usage is not provider accounting')

    def test_shared_world_requires_exact_agent_and_respects_tick_bounds(self):
        p = self.graph(self.action(1), self.action(2, agent='EkoPi'), self.action(3), self.action(4))
        with self.assertRaisesRegex(ValueError, 'exact agent'): read_actions(p)
        d = read_actions(p, agent='Eko', start_tick=2, end_tick=3)
        self.assertEqual(d['actions'], {'Place': 1})
        self.assertEqual(d['results'], {'PlaceSuccess': 1})

    def test_a_stale_last_result_is_never_reclassified_as_another_action(self):
        p = self.graph(self.action(1, 'MoveTo', 'PlaceSuccess'))
        d = run_metrics(self.root, recording=p)
        self.assertEqual(d['worldActions'], {'MoveTo': 1})
        self.assertEqual(d['actionResults'], {})
        self.assertEqual(d['placeSuccess'], 0)
        self.assertIsNone(d['placeSuccessRate'])

    def test_missing_recording_never_turns_unknown_success_into_zero(self):
        d = run_metrics(self.root)
        self.assertIsNone(d['worldActions'])
        self.assertIsNone(d['placeSuccess'])
        self.assertIsNone(d['placeSuccessRate'])
        self.assertIn('missing', d['worldMeasurement']['error'])

    def test_clawblox_inputs_prove_attempts_without_inventing_success(self):
        self.claw([(1, 'native-id', 'Place'), (2, 'native-id', 'Place'), (3, 'native-id', 'Jump')])
        d = run_metrics(self.root)
        self.assertEqual(d['worldActions'], {'Place': 2, 'Jump': 1})
        self.assertIsNone(d['actionResults'])
        self.assertIsNone(d['placeSuccess'])
        self.assertFalse(d['worldMeasurement']['evidence']['placeResultsComplete'])

    def test_sqlite_reader_does_not_create_a_missing_recording(self):
        p = self.root / 'missing.clawrec'
        with self.assertRaisesRegex(ValueError, 'missing'): read_actions(p)
        self.assertFalse(p.exists())

    def test_mixed_agent_clawblox_and_multiple_recordings_are_not_combined(self):
        p = self.claw([(1, 'first', 'Place'), (2, 'second', 'Place')])
        with self.assertRaisesRegex(ValueError, 'mixed-agent'): read_actions(p)
        (p.parent / 'another.clawrec').write_bytes(p.read_bytes())
        d = run_metrics(self.root)
        self.assertIsNone(d['worldActions'])
        self.assertIn('multiple', d['worldMeasurement']['error'])

    def test_truncated_or_malformed_world_evidence_disables_success_rates(self):
        p = self.graph(self.action(1))
        with p.open('a') as f: f.write('{"kind":')
        d = run_metrics(self.root, recording=p)
        self.assertFalse(d['worldMeasurement']['evidence']['complete'])
        self.assertIsNone(d['placeSuccessRate'])
        self.assertIsNone(d['placeSuccess'])

    def test_unknown_place_results_do_not_give_an_inflated_success_rate(self):
        p = self.graph(self.action(1), self.action(2, result='Ready'))
        d = run_metrics(self.root, recording=p)
        self.assertEqual(d['worldActions'], {'Place': 2})
        self.assertIsNone(d['placeSuccessRate'])

    def test_replay_resume_supersedes_the_old_action_branch(self):
        p = self.graph(self.action(1), self.action(5),
                       {'kind': 'hello', 'tick': 2, 'format': 'graphysx-world-stream/v1'},
                       self.action(3, result='PlaceFailed:TooClose'))
        d = read_actions(p, agent='Eko')
        self.assertEqual(d['actions'], {'Place': 2})
        self.assertEqual(d['results'], {'PlaceSuccess': 1, 'PlaceFailed:TooClose': 1})
        self.assertEqual(d['rewinds'], 1)

    def test_unordered_or_unknown_graphysx_recordings_are_refused(self):
        for rows in [[self.action(3), self.action(2)],
                     [{'kind': 'hello', 'tick': 2, 'format': 'unknown'}]]:
            with self.assertRaises(ValueError): read_actions(self.graph(*rows), agent='Eko')
        p = self.root / 'empty.ndjson'; p.write_text('')
        with self.assertRaisesRegex(ValueError, 'hello'): read_actions(p, agent='Eko')

    def test_active_run_is_not_a_completed_measurement(self):
        self.put('state.json', {'outcome': 'running'})
        d = run_metrics(self.root, recording=self.graph(self.action(1)))
        self.assertIsNone(d['worldActions'])
        self.assertIn('not terminal', d['worldMeasurement']['error'])

    def test_duration_uses_native_episode_windows_not_rollout_or_cleanup_time(self):
        receipt = {'episodes': [
            {'startedAt': '2026-01-01T00:00:00Z', 'endedAt': '2026-01-01T01:00:00Z'},
            {'startedAt': '2026-01-01T01:02:00Z', 'endedAt': '2026-01-01T02:02:00Z'}]}
        self.assertEqual(run_hours(receipt, {}), (2, 'native-episodes'))
        receipt['episodes'][-1].pop('endedAt')
        self.assertEqual(run_hours(receipt, {}), (None, 'incomplete-episodes'))

    def test_invalid_windows_or_bounds_never_produce_a_rate(self):
        self.assertEqual(run_hours({}, {}), (None, 'unavailable'))
        p = self.graph(self.action(1))
        for low, high in [(2, 1), (-1, None), (True, None)]:
            with self.assertRaises(ValueError): read_actions(p, agent='Eko', start_tick=low, end_tick=high)

    def test_failed_run_does_not_improve_the_completed_run_mean(self):
        d = run_metrics(self.root, recording=self.graph(self.action(1)))
        failed = {**d, 'outcome': 'failed', 'placeSuccessPerHour': 900}
        result = summary([d, failed])['pi']
        self.assertEqual(result['runs'], 2)
        self.assertEqual(result['completed'], 1)
        self.assertEqual(result['placeSuccessPerHour']['mean'], 1)


if __name__ == '__main__': unittest.main()
