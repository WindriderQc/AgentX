"""Cohort ownership and failure tests; no model, world, or real worker process."""
import fcntl
import json
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cohort_runner as cohort

RUN = "00000000-0000-4000-8000-0000000000ca"
DISPATCH = "00000000-0000-4000-8000-0000000000cb"


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "runs").mkdir()
        world = self.root / "worlds" / "living"
        world.mkdir(parents=True)
        (world / "world.toml").write_text('name="fixture"')
        (world / "README.md").write_text("fixture")
        config = self.root / "config.json"
        config.write_text(json.dumps({"runsRoot": str(self.root / "runs"), "worldsRoot": str(self.root / "worlds"),
                                      "worldPort": 19080, "tokenFile": "/outside/real-token", "nodeBin": "/installed/node/bin"}))
        self.config = cohort.native.load_config(config)
        self.args = SimpleNamespace(run_id=RUN, dispatch_id=DISPATCH, world="living", harnesses="codex,dsh,pi",
                                    minutes=15, netcheck=False, context_window=196608)
        self.members = cohort.roster(RUN, self.args.harnesses)
        self.remote = {"origin": "https://world.example", "world": "living-island"}

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self):
        return cohort.prepare(self.config, self.args, self.members, self.remote)

    def observed(self, outcome="completed"):
        return [{"runId": m["runId"], "phase": "finished", "terminal": True, "alive": False,
                 "localStopped": True, "processObservationOk": True, "leftover": [], "outcome": outcome}
                for m in self.members]


class CohortTests(Fixture):
    def test_distinct_stable_member_identities_and_no_shared_memory_names(self):
        self.assertEqual(self.members, cohort.roster(RUN, "codex,dsh,pi"))
        self.assertEqual(len({m['runId'] for m in self.members}), 3)
        self.assertEqual(len({m['agent'].lower() for m in self.members}), 3)
        for bad in ["codex", "codex,codex", "codex,other", "codex,dsh,pi,codex"]:
            with self.assertRaises(ValueError): cohort.roster(RUN, bad)

    def test_preparation_retains_native_provider_and_separates_relays_and_world_state(self):
        group = self.prepare()
        configs = [json.loads((group / (m['harness'] + '.json')).read_text()) for m in self.members]
        self.assertEqual([c['worldPort'] for c in configs], [19080, 19081, 19082])
        self.assertEqual(len({c['worldsRoot'] for c in configs}), 3)
        for c, m in zip(configs, self.members):
            self.assertEqual(c['tokenFile'], '/outside/real-token')
            self.assertEqual(c['nodeBin'], '/installed/node/bin')
            self.assertEqual(c['startupSeconds'], 300)
            request = cohort.native.read_json(self.root / 'runs' / m['runId'] / 'request.json')
            self.assertTrue((Path(c['worldsRoot']) / request['world'] / 'world.toml').is_file())
            self.assertEqual((request['memory'], request['contextWindow'], request['parentRunId']), ('fresh', 196608, RUN))
            self.assertIn(m['runId'], request['world'], 'native tmux names must not collide in a simultaneous start')
        self.assertEqual(cohort.native.active_run(self.config), RUN, 'the existing single-run start gate sees the cohort')
        self.assertEqual(cohort.native.read_json(group / 'request.json')['model'], 'agentx-primary')

    def test_an_existing_member_refuses_without_publishing_a_new_owner(self):
        (self.root / 'runs' / self.members[1]['runId']).mkdir()
        with self.assertRaisesRegex(ValueError, 'already exists'): self.prepare()
        self.assertFalse((self.root / 'runs' / RUN).exists())
        self.assertIsNone(cohort.native.active_run(self.config))

    def test_symlink_source_is_not_copied_and_no_owner_is_published(self):
        p = self.root / 'worlds/living/README.md'
        p.unlink(); p.symlink_to(self.root / 'config.json')
        with self.assertRaises(ValueError): self.prepare()
        self.assertFalse((self.root / 'runs/active.json').exists())

    def test_lost_start_answer_cannot_relaunch_existing_identity(self):
        self.prepare()
        with mock.patch.object(cohort, 'preflight', return_value=(self.members, self.remote)), \
             mock.patch.object(cohort.native, 'active_run', return_value=None), \
             mock.patch.object(cohort.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'already exists'): cohort.start(self.config, self.args)
            spawn.assert_not_called()

    def test_busy_race_is_checked_again_under_the_native_lock(self):
        with mock.patch.object(cohort, 'preflight', return_value=(self.members, self.remote)), \
             mock.patch.object(cohort.native, 'active_run', return_value='other'), \
             mock.patch.object(cohort.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'became busy'): cohort.start(self.config, self.args)
            spawn.assert_not_called()
        self.assertFalse((self.root / 'runs' / RUN).exists())

    def test_real_group_refuses_local_world_before_running_checks(self):
        with mock.patch.object(cohort.native, 'remote_world', return_value=None), \
             mock.patch.object(cohort.native, 'action_check') as check:
            with self.assertRaisesRegex(ValueError, 'remote world'): cohort.preflight(self.config, self.args)
            check.assert_not_called()

    def test_netcheck_is_bounded_and_real_run_requires_principal_context(self):
        self.args.context_window = None
        with self.assertRaises(ValueError): cohort.preflight(self.config, self.args)
        self.args.netcheck = True
        with self.assertRaises(ValueError): cohort.preflight(self.config, self.args)

    def test_cleanup_rejects_missing_observation_alive_or_leftover_members(self):
        self.assertTrue(cohort.released(self.observed()))
        self.assertFalse(cohort.released([]))
        for key, value in [('terminal', False), ('alive', True), ('localStopped', False),
                           ('processObservationOk', None), ('leftover', None), ('leftover', [42])]:
            rows = self.observed(); rows[1][key] = value
            self.assertFalse(cohort.released(rows), key)

    def test_native_supervisor_start_barrier_prevents_stale_parent_pid_writes(self):
        self.prepare()
        calls = []
        def spawn(argv, **kwargs):
            with open(self.root / 'runs/runner.lock', 'a') as lock:
                with self.assertRaises(BlockingIOError): fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            calls.append(argv)
            return SimpleNamespace(pid=9000 + len(calls), poll=lambda: 0)
        with mock.patch.object(cohort.subprocess, 'Popen', side_effect=spawn), \
             mock.patch.object(cohort, 'describe', return_value={'members': self.observed()}):
            result = cohort.supervise(self.config, self.args)
        self.assertEqual((result['outcome'], result['localStopped']), ('completed', True))
        self.assertEqual(len(calls), 3)
        self.assertTrue(all('supervise' in c and str(Path(cohort.native.__file__).resolve()) in c for c in calls))
        self.assertIsNone(cohort.native.active_run(self.config))

    def test_unproven_cleanup_keeps_native_runner_fenced(self):
        self.prepare(); rows = self.observed(); rows[0]['leftover'] = [42]
        with mock.patch.object(cohort.subprocess, 'Popen', return_value=SimpleNamespace(pid=9999, poll=lambda: 0)), \
             mock.patch.object(cohort, 'describe', return_value={'members': rows}):
            result = cohort.supervise(self.config, self.args)
        self.assertEqual((result['outcome'], result['localStopped']), ('failed', False))
        self.assertEqual(cohort.native.active_run(self.config), RUN)

    def test_spawn_failure_stops_only_started_members_and_does_not_complete(self):
        self.prepare(); signals = []
        class Process:
            pid = 9999
            done = False
            def poll(self): return 0 if self.done else None
            def send_signal(self, sig): signals.append(sig); self.done = True
            def wait(self, timeout): return 0
        with mock.patch.object(cohort.subprocess, 'Popen', side_effect=[Process(), OSError('fixture')]), \
             mock.patch.object(cohort, 'describe', return_value={'members': self.observed('stopped')}):
            result = cohort.supervise(self.config, self.args)
        self.assertEqual(result['outcome'], 'failed')
        self.assertEqual(signals, [signal.SIGTERM])

    def test_parent_stop_signals_all_members_and_reports_stopped(self):
        self.prepare(); processes = []; signals = []
        class Process:
            def __init__(self, index): self.pid, self.done = 9100 + index, False
            def poll(self): return 0 if self.done else None
            def send_signal(self, sig): signals.append((self.pid, sig)); self.done = True
            def wait(self, timeout): return 0
        def spawn(*args, **kwargs):
            process = Process(len(processes)); processes.append(process)
            if len(processes) == 3: signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            return process
        def observe(*args):
            rows = self.observed('stopped')
            for row, process in zip(rows, processes):
                if not process.done: row.update(phase='running', terminal=False, alive=True, localStopped=False)
            return {'members': rows}
        original = signal.getsignal(signal.SIGTERM)
        with mock.patch.object(cohort.subprocess, 'Popen', side_effect=spawn), \
             mock.patch.object(cohort, 'describe', side_effect=observe), mock.patch.object(cohort.time, 'sleep'):
            result = cohort.supervise(self.config, self.args)
        self.assertEqual((result['outcome'], result['localStopped']), ('stopped', True))
        self.assertEqual(len(signals), 3)
        self.assertTrue(all(sig == signal.SIGTERM for _, sig in signals))
        self.assertEqual(signal.getsignal(signal.SIGTERM), original)
        self.assertIsNone(cohort.native.active_run(self.config))

    def test_failed_final_status_read_never_attests_cleanup(self):
        self.prepare()
        with mock.patch.object(cohort.subprocess, 'Popen', return_value=SimpleNamespace(pid=9999, poll=lambda: 0)), \
             mock.patch.object(cohort, 'describe', side_effect=OSError('unreadable receipt')):
            result = cohort.supervise(self.config, self.args)
        self.assertEqual((result['outcome'], result['localStopped']), ('failed', False))
        self.assertEqual(cohort.native.active_run(self.config), RUN)


if __name__ == '__main__': unittest.main()
