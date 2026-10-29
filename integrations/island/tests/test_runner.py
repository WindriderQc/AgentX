import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import run_island
from run_state import MEMORY, REQUIRED_CHECKS, netcheck_result, seed_workspace


class Clock:
    def __init__(self): self.value=0
    def monotonic(self): return self.value
    def sleep(self,seconds): self.value += seconds


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.templates=self.root/'templates';self.templates.mkdir()
        for name in MEMORY:
            (self.templates/name).write_text('' if name.endswith('.jsonl') else 'synthetic memory')
        (self.templates/'SYSTEM_PROMPT.md').write_text('Read ${WORKSPACE_DIR}; name ${WORLD_AGENT_NAME}')
        self.a=run_island.parser().parse_args(['--run-dir',str(self.root/'run'),'--templates-dir',str(self.templates),
                                             '--world-dir',str(self.root/'world'),'--netcheck','--minutes','0.05',
                                             '--memory-warning-minutes','0'])
        self.stops=[]
        self.behavior='healthy'
        test=self
        class World:
            def __init__(self,**kw): pass
            def start(self,**kw):
                if test.behavior=='world-start-failed': raise RuntimeError('synthetic world startup failure')
            def connect(self,**kw): pass
            def stop(self,**kw): test.stops.append('world')
        class Agent:
            def __init__(self,**kw): self.dir=kw['dir'];test.agent_settings=kw
            def start(self,**kw):
                test.agent_env=kw['env']
                if test.behavior=='start-failed': raise RuntimeError('synthetic start failure')
                if test.behavior not in ('dead','no-activity'):
                    home=self.dir/'sandbox-home'/'.codex'/'sessions';home.mkdir(parents=True)
                    (home/'fixture.jsonl').write_text('{"type":"response_item","payload":{"type":"message","role":"assistant"}}\n')
                data={'schema':'agentx.island-netcheck/v1','checks':[{'name':n,'passed':test.behavior!='netcheck-failed'} for n in REQUIRED_CHECKS]}
                (self.dir/'workspace'/'netcheck.json').write_text(json.dumps(data))
                return SimpleNamespace(tmux_pane_id='%1')
            def send(self,**kw): raise RuntimeError('synthetic resume failure')
            def stop(self,**kw):
                test.stops.append('agent')
                if test.behavior=='cleanup-failed': raise RuntimeError('synthetic stop failure')
        self.runtime=SimpleNamespace(agentx_isolation_version=lambda:1,World=World,Agent=Agent)

    def tearDown(self): self.temp.cleanup()

    def run_episode(self):
        code=run_island.execute(self.a,self.runtime,clock=Clock(),alive=lambda _:self.behavior!='dead')
        return code,json.loads((self.a.run_dir/'receipt.json').read_text())

    def test_dead_before_first_rollout_is_failed_and_both_resources_stopped(self):
        self.behavior='dead'
        code,receipt=self.run_episode()
        self.assertEqual(code,1);self.assertEqual(receipt['outcome'],'failed')
        self.assertIn('exited',receipt['error']);self.assertEqual(self.stops,['agent','world'])

    def test_no_activity_cannot_finish_successfully(self):
        self.behavior='no-activity';self.a.startup_seconds=1
        code,receipt=self.run_episode()
        self.assertEqual(code,1);self.assertIn('no session activity',receipt['error'])

    def test_failed_netcheck_and_partial_checks_fail(self):
        self.behavior='netcheck-failed'
        code,receipt=self.run_episode()
        self.assertEqual(code,1);self.assertEqual(receipt['outcome'],'failed')
        workspace=self.a.run_dir/'agents/agent/workspace'
        (workspace/'netcheck.json').write_text('{"schema":"agentx.island-netcheck/v1","checks":[{"name":"world","passed":true}]}')
        with self.assertRaises(RuntimeError): netcheck_result(workspace)

    def test_resume_failure_is_terminal(self):
        self.a.memory_warning_minutes=1
        code,receipt=self.run_episode()
        self.assertEqual(code,1);self.assertIn('resume failure',receipt['error'])

    def test_partial_start_and_cleanup_failure_have_honest_receipts(self):
        for behavior in ['world-start-failed','start-failed','cleanup-failed']:
            self.a.run_dir=self.root/behavior;self.behavior=behavior;self.stops=[]
            code,receipt=self.run_episode()
            self.assertEqual(code,1);self.assertEqual(receipt['outcome'],'failed')
            self.assertIn('world',self.stops)
            self.assertEqual(receipt['localStopped'],behavior!='cleanup-failed')

    def test_old_adapter_refused_before_world_or_owner_credentials_import(self):
        self.runtime.agentx_isolation_version=lambda:0
        code,receipt=self.run_episode()
        self.assertEqual(code,1);self.assertEqual(self.stops,[])
        self.assertIn('no runtime started',receipt['error'])

    def test_healthy_episode_copies_only_memory_into_fresh_second_episode(self):
        code,receipt=self.run_episode();self.assertEqual(code,0)
        source=self.a.run_dir/'agents/agent/workspace'
        (source/'SEMANTIC_MEMORY.md').write_text('learned in episode one')
        (source/'EPISODIC_MEMORY.jsonl').write_text('{"summary":"episode one"}\n')
        (source/'tool.sh').write_text('not memory')
        (source/'auth.json').write_text('not memory')
        self.a.memory_from=self.a.run_dir;self.a.run_dir=self.root/'second'
        code,second=self.run_episode();self.assertEqual(code,0)
        target=self.a.run_dir/'agents/agent/workspace'
        self.assertEqual((target/'SEMANTIC_MEMORY.md').read_text(),'learned in episode one')
        self.assertEqual((target/'EPISODIC_MEMORY.jsonl').read_text(),'{"summary":"episode one"}\n')
        self.assertFalse((target/'tool.sh').exists());self.assertFalse((target/'auth.json').exists())
        self.assertEqual(second['memoryFrom'],str(self.root/'run'))
        self.assertNotIn('synthetic-upstream-secret',json.dumps(second))
        self.assertTrue(self.agent_env['CLAWBLOX_NET_ALLOW'].startswith('127.0.0.1:'))
        self.assertEqual(set(self.agent_env),{'CLAWBLOX_NET_ALLOW','AGENTX_LLM_CODEX_TOKEN','AGENTX_NETCHECK_PORT','AGENTX_NETCHECK_BLOCKED_URLS','AGENTX_NETCHECK_HARNESS','AGENTX_NETCHECK_INFERENCE','AGENTX_NETCHECK_OTHER_INFERENCE'})
        with self.assertRaises(FileExistsError): self.run_episode()

    def test_symlink_memory_is_refused(self):
        (self.templates/'SOUL.md').unlink()
        (self.templates/'SOUL.md').symlink_to(self.templates/'SEMANTIC_MEMORY.md')
        code,receipt=self.run_episode();self.assertEqual(code,1)
        self.assertIn('regular file',receipt['error'])

    def test_stale_activity_at_end_is_not_success(self):
        self.a.stall_idle_seconds=1
        def stale(_): return {"age":2,"payload":{},"modelActivity":True}
        code=run_island.execute(self.a,self.runtime,clock=Clock(),alive=lambda _:True,activity=stale)
        receipt=json.loads((self.a.run_dir/'receipt.json').read_text())
        self.assertEqual(code,1);self.assertIn('recent session activity',receipt['error'])

    def test_controller_signal_stops_without_completed_outcome(self):
        import signal
        callbacks={}
        real_start=self.runtime.World.start
        def start(world,**kwargs):
            real_start(world,**kwargs)
            callbacks[signal.SIGTERM](signal.SIGTERM,None)
        self.runtime.World.start=start
        def register(sig,handler):
            previous=callbacks.get(sig)
            callbacks[sig]=handler
            return previous
        with patch('run_island.signal.signal',side_effect=register):
            code,receipt=self.run_episode()
        self.assertEqual(code,2);self.assertEqual(receipt['outcome'],'stopped')
        self.assertNotIn('agent_env',self.__dict__)

    def reset_runtime(self, fail_second_start=False):
        test=self;test.starts=[];test.actions=[]
        class World:
            def __init__(self,**kw): pass
            def start(self,**kw): test.actions.append('world-start')
            def connect(self,**kw): pass
            def stop(self,**kw): test.actions.append('world-stop')
        class Agent:
            def __init__(self,**kw): self.dir=kw['dir']
            def start(self,**kw):
                test.starts.append(kw['initial_prompt']);test.actions.append('agent-start')
                if fail_second_start and len(test.starts)==2: raise RuntimeError('synthetic restart failure')
                data={'schema':'agentx.island-netcheck/v1','checks':[{'name':n,'passed':True} for n in REQUIRED_CHECKS]}
                (self.dir/'workspace'/'netcheck.json').write_text(json.dumps(data))
                return SimpleNamespace(tmux_pane_id='%'+str(len(test.starts)))
            def send(self,**kw): test.actions.append('agent-send');return SimpleNamespace(tmux_pane_id='%9')
            def stop(self,**kw): test.actions.append('agent-stop')
        return SimpleNamespace(agentx_isolation_version=lambda:1,World=World,Agent=Agent)

    def test_long_run_resets_the_context_each_episode_and_keeps_one_world(self):
        self.a.minutes=0.1;self.a.episode_minutes=0.05;self.a.memory_warning_minutes=0.02
        seen=[]
        def activity(_sessions,since=None):
            seen.append(since)
            return {"age":0,"payload":{},"modelActivity":True}
        code=run_island.execute(self.a,self.reset_runtime(),clock=Clock(),alive=lambda _:True,activity=activity)
        receipt=json.loads((self.a.run_dir/'receipt.json').read_text())
        self.assertEqual(code,0,receipt.get('error'))
        self.assertEqual(self.starts,['Begin.','Begin.'])
        self.assertEqual(self.actions.count('world-start'),1)
        self.assertEqual([e['index'] for e in receipt['episodes']],[1,2])
        self.assertTrue(all(e.get('activityObserved') for e in receipt['episodes']))
        self.assertEqual(receipt['episodeMinutes'],0.05)
        self.assertEqual(sum(1 for e in receipt['events'] if e['event']=='episode'),1)
        self.assertEqual(sum(1 for e in receipt['events'] if e.get('reason')=='memory-reminder'),2)
        # The first episode reads all sessions; after the reset, only newer ones.
        self.assertIsNone(seen[0]);self.assertIsNotNone(seen[-1])
        reset=[i for i,x in enumerate(self.actions) if x=='agent-start'][1]
        self.assertEqual(self.actions[reset-1],'agent-stop')

    def test_a_failed_context_reset_fails_the_run_and_stops_everything(self):
        self.a.minutes=0.1;self.a.episode_minutes=0.05
        code=run_island.execute(self.a,self.reset_runtime(fail_second_start=True),clock=Clock(),alive=lambda _:True,
                                activity=lambda _s,since=None:{"age":0,"payload":{},"modelActivity":True})
        receipt=json.loads((self.a.run_dir/'receipt.json').read_text())
        self.assertEqual(code,1);self.assertIn('restart failure',receipt['error'])
        self.assertEqual(self.actions[-2:],['agent-stop','world-stop'])
        self.assertTrue(receipt['localStopped'])

    def test_memory_reminder_waits_for_the_first_session_activity(self):
        # A run shorter than the reminder lead time must not resume a session that does not exist yet.
        self.a.minutes=0.1;self.a.memory_warning_minutes=5
        calls={'n':0}
        def activity(_s,since=None):
            calls['n']+=1
            seen=calls['n']>=3
            self.actions.append('activity' if seen else 'no-session')
            return {"age":0,"payload":{},"modelActivity":True} if seen else None
        code=run_island.execute(self.a,self.reset_runtime(),clock=Clock(),alive=lambda _:True,activity=activity)
        receipt=json.loads((self.a.run_dir/'receipt.json').read_text())
        self.assertEqual(code,0,receipt.get('error'))
        sends=[i for i,x in enumerate(self.actions) if x=='agent-send']
        self.assertEqual(len(sends),1)
        reminder=[e for e in receipt['events'] if e.get('reason')=='memory-reminder']
        self.assertEqual(len(reminder),1)
        self.assertGreater(sends[0],self.actions.index('activity'))

    def test_one_episode_by_default(self):
        self.a.minutes=0.05
        code=run_island.execute(self.a,self.reset_runtime(),clock=Clock(),alive=lambda _:True,
                                activity=lambda _s:{"age":0,"payload":{},"modelActivity":True})
        self.assertEqual(code,0);self.assertEqual(self.starts,['Begin.'])

    def test_activity_after_a_reset_ignores_older_sessions(self):
        from run_state import latest_activity
        import os,time
        sessions=self.root/'sessions';sessions.mkdir()
        old=sessions/'old.jsonl';old.write_text('{"type":"response_item","payload":{"type":"message","role":"assistant"}}\n')
        os.utime(old,(time.time()-100,time.time()-100))
        self.assertTrue(latest_activity(sessions)['modelActivity'])
        self.assertIsNone(latest_activity(sessions,since=time.time()-10))
        (sessions/'new.jsonl').write_text('{"type":"session_meta","payload":{}}\n')
        self.assertFalse(latest_activity(sessions,since=time.time()-10)['modelActivity'])

    def test_finished_turn_recovery_failure_or_exhausted_budget_is_failed(self):
        for maximum in [0,1]:
            self.a.run_dir=self.root/('stall-'+str(maximum))
            self.a.min_nudge_interval_seconds=1
            self.a.stall_after_turn_seconds=1
            self.a.max_nudges=maximum
            def stalled(_): return {"age":5,"payload":{"type":"task_complete"},"modelActivity":True}
            code=run_island.execute(self.a,self.runtime,clock=Clock(),alive=lambda _:True,activity=stalled)
            receipt=json.loads((self.a.run_dir/'receipt.json').read_text())
            self.assertEqual(code,1)
            self.assertIn('budget' if maximum==0 else 'resume failure',receipt['error'])
