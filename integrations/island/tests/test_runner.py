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
        self.assertEqual(set(self.agent_env),{'CLAWBLOX_NET_ALLOW','AGENTX_LLM_CODEX_TOKEN','AGENTX_NETCHECK_PORT','AGENTX_NETCHECK_BLOCKED_URLS'})
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
