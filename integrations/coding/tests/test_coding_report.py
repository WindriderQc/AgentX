import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE/f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
runner, report = load('coding_run'), load('coding_report')
KEY = '11111111-2222-4333-8444-555555555555'


class ReportTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.workspace = self.root/'task-0001'; self.workspace.mkdir()
        runner.git(self.workspace,'init','--quiet'); (self.workspace/'README.md').write_text('Public source\n')
        runner.git(self.workspace,'add','README.md'); runner.git(self.workspace,*runner.AUTHOR,'commit','-qm','Initial')
        self.head = runner.git(self.workspace,'rev-parse','HEAD')
        self.home = self.root/'.home-task-0001'
        self.path = self.home/'deliverables'/KEY/'review.md'
        self.task = {'pipelineId':'0001','title':'Documentation review','spec':'Review every Markdown document.',
                     'status':'queued','service':'agentx-coding','feedback':[],'transitions':[{'kind':'claimed','seq':2}]}
        self.uploads=[]; self.exit_code=0
        self.receipt=None;self.terminated=True;self.completed=True;self.lose_response=False
        for name,value in [('WORKSPACES',self.root),('MODEL','fixture-model'),('RECEIPTS',self.root/'receipts'),
                           ('request',self.request),('feedback',mock.Mock(side_effect=self.feedback)),
                           ('run_worker',mock.Mock(side_effect=self.worker)),('install_dependencies',mock.Mock()),
                           ('push_and_open_pr',mock.Mock())]:
            patch=mock.patch.object(runner,name,value);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(sys,'argv',['coding_run','0001','--request-id',KEY,'--report-name','review.md'])
        patch.start();self.addCleanup(patch.stop)

    def request(self,url,body=None,**kwargs):
        if '/reports/' in url:
            if url.endswith('/start'):return {'data':{'requestId':KEY,'claimSeq':2}}
            if url.endswith('/result'):
                value={'requestId':KEY,'claimSeq':2,'sourceCommit':self.head,'sha256':body['sha256']}
                if self.task['transitions'][-1]['seq']!=2:return {'data':{'superseded':True,'outcome':value}}
                if not self.receipt:
                    self.uploads.append(body)
                    self.receipt={'id':'a'*24,'pipelineId':'0001','ref':'task-0001/deliverable-'+('a'*24),'sha256':body['sha256'],
                        'size':self.path.stat().st_size,'name':'review-'+KEY+'.md','availability':{'status':'available','hashVerified':True}}
                self.task['status']='review'
                if self.lose_response:
                    self.lose_response=False;raise OSError('Synthetic acknowledgement lost after commit')
                return {'data':{'reportReadyForReview':True,'receipt':self.receipt,'outcome':value}}
            if url.endswith('/stop-result'):
                self.task['status']='blocked'
                return {'data':{'blocked':True,'outcome':{'requestId':KEY,'claimSeq':2}}}
            return {'data':{'requestId':KEY,'claimSeq':2,'terminationVerified':self.terminated,'allCallsCompleted':self.completed}}
        if url.endswith('/claim'):self.task.update(status='in_progress',assignee='coding-team')
        elif '/deliverables/' in url:return {'data':{'receipt':self.receipt}}
        return {'data':{'task':self.task}}

    def feedback(self,task,text,status,**kwargs):
        self.task['status']='review' if status=='done' else status

    def worker(self,workspace,prompt,timeout,progress,*,read_only):
        self.assertTrue(read_only); self.assertIn('/home/agent/deliverables/'+KEY+'/review.md',prompt)
        self.assertIn('/workspace/AGENTS.md',prompt);self.assertIn('git -C /workspace',prompt)
        self.path.write_text('# Review\n\nVerified README against the source. Other files remain pending.\n')
        return subprocess.CompletedProcess([],self.exit_code,stdout='A report is ready for review.',stderr='')

    def test_report_is_stored_for_review_without_source_changes_commits_or_publication(self):
        with mock.patch('builtins.print'):
            self.assertEqual(runner.main(),0)
        self.assertEqual(self.task['status'],'review'); self.assertEqual(self.task['spec'],'Review every Markdown document.')
        self.assertEqual(runner.git(self.workspace,'rev-parse','HEAD'),self.head)
        self.assertEqual(runner.git(self.workspace,'status','--porcelain'),'')
        self.assertEqual(self.uploads[0]['sha256'],hashlib.sha256(self.path.read_bytes()).hexdigest())
        self.assertNotIn('attempt',self.uploads[0]);self.assertNotIn('leaseId',self.uploads[0])
        runner.install_dependencies.assert_not_called();runner.push_and_open_pr.assert_not_called()
        self.assertTrue((runner.RECEIPTS/(KEY+'.report-result.json')).is_file())
        self.assertTrue((runner.RECEIPTS/(KEY+'.report.md')).is_file())

    def test_stopped_worker_keeps_partial_report_without_deposit_or_publication(self):
        self.exit_code=124
        with mock.patch('builtins.print'):self.assertEqual(runner.main(),1)
        self.assertEqual(self.task['status'],'blocked');self.assertTrue(self.path.is_file());self.assertEqual(self.uploads,[])
        self.assertEqual(runner.git(self.workspace,'rev-parse','HEAD'),self.head);runner.push_and_open_pr.assert_not_called()

    def test_changed_source_is_not_delivered(self):
        original=self.worker
        def changed(*args,**kwargs):
            result=original(*args,**kwargs);(self.workspace/'README.md').write_text('Unexpected source mutation');return result
        runner.run_worker.side_effect=changed
        with mock.patch('builtins.print'):self.assertEqual(runner.main(),1)
        self.assertEqual(self.uploads,[]);runner.push_and_open_pr.assert_not_called()

    def test_a_new_claim_vetoes_old_report_deposit(self):
        original=self.worker
        def changed(*args,**kwargs):
            result=original(*args,**kwargs);self.task['transitions'].append({'kind':'claimed','seq':9});return result
        runner.run_worker.side_effect=changed
        with mock.patch('builtins.print'):self.assertEqual(runner.main(),1)
        self.assertEqual(self.uploads,[])

    def test_missing_report_is_blocked(self):
        runner.run_worker.side_effect=lambda *a,**k:subprocess.CompletedProcess([],0,stdout='Claimed completion',stderr='')
        with mock.patch('builtins.print'):self.assertEqual(runner.main(),1)
        self.assertEqual(self.uploads,[]);self.assertEqual(self.task['status'],'blocked')

    def test_lost_delivery_acknowledgement_reconciles_the_same_bytes_without_model_replay(self):
        self.lose_response=True
        with mock.patch('builtins.print'):self.assertEqual(runner.main(),2)
        self.assertEqual(self.task['status'],'review');self.assertEqual(len(self.uploads),1)
        before=(runner.RECEIPTS/(KEY+'.report-intent.json')).read_bytes()
        with mock.patch.object(runner.coding_dispatch_control,'unit_active',return_value=False):
            value=report.reconcile(runner,'0001',KEY)
        self.assertEqual(value['result'],'review');self.assertEqual(runner.run_worker.call_count,1)
        self.assertEqual(len(self.uploads),1);self.assertEqual((runner.RECEIPTS/(KEY+'.report-intent.json')).read_bytes(),before)
        runner.feedback.assert_not_called();runner.push_and_open_pr.assert_not_called()

    def test_native_unknown_model_keeps_request_unfinished_without_deposit(self):
        self.terminated=False
        with mock.patch('builtins.print'):self.assertEqual(runner.main(),2)
        progress=__import__('json').loads((runner.RECEIPTS/(KEY+'.progress.json')).read_text())
        self.assertNotEqual(progress['phase'],'finished');self.assertFalse(progress['coreRecorded'])
        self.assertEqual(progress['stopReason'],'model_termination_unverified');self.assertEqual(self.uploads,[])
        runner.feedback.assert_not_called()

    def test_stop_wins_the_publication_lock_without_core_deposit(self):
        original=self.worker
        def stopped(*args,**kwargs):
            value=original(*args,**kwargs);args[3].stop_reason='operator_stop';return value
        runner.run_worker.side_effect=stopped
        with mock.patch('builtins.print'):self.assertEqual(runner.main(),1)
        self.assertEqual(self.uploads,[]);self.assertFalse((runner.RECEIPTS/(KEY+'.report-intent.json')).exists())

    def test_failed_task_read_is_a_known_preflight_with_zero_model_calls(self):
        with mock.patch.object(runner, 'request', side_effect=OSError('Synthetic missing Core')), mock.patch('builtins.print'):
            self.assertEqual(runner.main(), 2)
        value=__import__('json').loads((runner.RECEIPTS/(KEY+'.progress.json')).read_text())
        self.assertTrue(value['preflight']);self.assertEqual(value['modelCalls'],0)
        self.assertEqual(value['phase'],'finished');runner.run_worker.assert_not_called()

    def test_native_stop_reasons_map_to_the_shared_core_contract(self):
        for reason in runner.coding_progress.REASONS:
            with self.subTest(reason=reason):
                self.assertIn(report.stop_reason(reason),report.STOP_REASONS)
        self.assertEqual(report.stop_reason('tool_inactive'),'runner_error')
        self.assertEqual(report.stop_reason('hard_budget'),'hard_budget')

    def test_report_bytes_refuse_links_fifos_binary_and_oversize(self):
        self.path.parent.mkdir(parents=True)
        for data in [b'',b'\xff',b'a\x01b',b'x'*(report.MAX_BYTES+1)]:
            with self.subTest(size=len(data)):
                self.path.write_bytes(data)
                with self.assertRaises((ValueError,OSError)):report.report_bytes(self.path,self.path.parent)
        self.path.unlink();self.path.symlink_to(self.workspace/'README.md')
        with self.assertRaises((ValueError,OSError)):report.report_bytes(self.path,self.path.parent)
        self.path.unlink();os.mkfifo(self.path)
        with self.assertRaises((ValueError,OSError)):report.report_bytes(self.path,self.path.parent)
        self.path.unlink();self.path.parent.rmdir();self.path.parent.symlink_to(self.workspace,target_is_directory=True)
        with self.assertRaises((ValueError,OSError)):report.report_bytes(self.path,self.path.parent)

    def test_only_new_report_bytes_are_useful_and_hard_deadline_does_not_move(self):
        self.path.parent.mkdir(parents=True);clock=[0]
        progress=runner.coding_progress.Progress('0001',KEY,now=lambda:clock[0])
        progress.phase='running';progress.report_observer=lambda:report.report_signature(self.path,self.path.parent)
        progress.baseline(self.home,self.workspace);hard=progress.hard_deadline
        clock[0]=7100;self.path.write_text('Verified finding A');progress.tick(self.home,self.workspace)
        self.assertEqual(progress.last_useful,7100)
        clock[0]=7110;os.utime(self.path,None);progress.tick(self.home,self.workspace)
        self.assertEqual(progress.last_useful,7100)
        clock[0]=7201;self.assertIsNone(progress.tick());self.assertEqual(progress.extensions,1)
        clock[0]=hard;self.assertEqual(progress.tick(),'hard_budget');self.assertEqual(progress.hard_deadline,hard)

    def test_only_a_validated_report_can_change_the_sandbox_working_directory(self):
        command=runner.sandbox(self.workspace,self.home,['true'],network=False,timeout_seconds=1)
        self.assertEqual(command[command.index('--chdir')+1],'/workspace')
        for options in [{'report_request_id':KEY}, {'read_only':True,'report_request_id':'../other'},
                        {'read_only':True,'report_request_id':'/tmp'}]:
            with self.assertRaises(ValueError):runner.sandbox(self.workspace,self.home,['true'],network=False,timeout_seconds=1,**options)

    def test_report_worker_sandbox_mounts_the_whole_source_read_only(self):
        if not shutil.which('bwrap'):self.skipTest('Bubblewrap unavailable')
        self.path.parent.mkdir(parents=True);dsh=self.root/'dsh';dsh.mkdir()
        script="import os\nfrom pathlib import Path\nassert os.getcwd()=='/home/agent/deliverables/"+KEY+"'\nassert Path('/workspace/README.md').read_text()=='Public source\\n'\ntry:\n Path('/workspace/README.md').write_text('mutated')\nexcept OSError:\n Path('review.md').write_text('Private output works')\nelse:\n raise AssertionError('Source was writable')\n"
        with mock.patch.object(runner,'DSH_ROOT',dsh):
            command=runner.sandbox(self.workspace,self.home,['python3','-c',script],network=False,timeout_seconds=10,read_only=True,report_request_id=KEY)
        result=subprocess.run(command,capture_output=True,text=True,timeout=15)
        if 'Operation not permitted' in result.stderr or 'No permissions to create' in result.stderr:self.skipTest('User namespaces unavailable')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((self.workspace/'README.md').read_text(),'Public source\n')
        self.assertEqual(self.path.read_text(),'Private output works')


class ReportDispatchTest(unittest.TestCase):
    def test_report_worker_refuses_an_unbound_directory_before_requests_or_dispatch(self):
        with mock.patch.object(runner,'request') as api, mock.patch.object(runner.model_relay,'serve') as relay:
            for progress in [None, __import__('types').SimpleNamespace(report_mode=False,request_id=KEY),
                             __import__('types').SimpleNamespace(report_mode=True,request_id='../other')]:
                with self.assertRaises(ValueError):runner.run_worker(Path('/unused'),'fixture',1,progress,read_only=True)
            api.assert_not_called();relay.assert_not_called()

    def test_report_identity_binds_mode_and_name_before_replay(self):
        control=runner.coding_dispatch_control
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(control,'STATE',Path(directory)), \
             mock.patch.object(control,'RECEIPTS',Path(directory)/'requests'),mock.patch.object(control,'unit_active',return_value=False), \
             mock.patch.object(control,'queued_tasks',return_value=[{'pipelineId':'0001','status':'queued','service':'agentx-coding'}]), \
             mock.patch.object(control.subprocess,'run') as unit:
            self.assertTrue(control.launch('0001',KEY,0,report='review.md')['accepted'])
            command=unit.call_args.args[0];self.assertIn('--report-name',command);self.assertEqual(command[-1],'review.md')
            self.assertTrue(control.launch('0001',KEY,0,report='review.md')['replayed'])
            for options in [{},{'report':'other.md'},{'report':'review.md','autonomous':True}]:
                with self.assertRaises(control.ControlError):control.launch('0001',KEY,0,**options)
            self.assertEqual(unit.call_count,1)

    def test_unknown_report_fences_another_worker_and_empty_mode_never_falls_back(self):
        control=runner.coding_dispatch_control
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(control,'STATE',Path(directory)), \
             mock.patch.object(control,'RECEIPTS',Path(directory)/'requests'), mock.patch.object(control,'unit_active',return_value=False), \
             mock.patch.object(control,'queued_tasks',return_value=[{'pipelineId':'0001','status':'queued','service':'agentx-coding','automation':None}]), \
             mock.patch.object(control.subprocess,'run') as unit:
            control.launch('0001',KEY,0,report='review.md')
            with self.assertRaises(control.ControlError) as error:
                control.launch('0001','22222222-2222-4333-8444-555555555555',0,report='review.md')
            self.assertEqual(error.exception.code,'CODING_DISPATCH_OUTCOME_UNKNOWN');self.assertEqual(unit.call_count,1)
            with mock.patch.object(sys,'argv',['control','launch-report','0001',KEY,'0','']), mock.patch('builtins.print') as printed:
                self.assertEqual(control.main(),0)
            self.assertIn('CODING_DISPATCH_INVALID_REQUEST',printed.call_args.args[0]);self.assertEqual(unit.call_count,1)

    def test_report_name_cannot_inject_shell_or_leave_its_directory(self):
        for value in ['../review.md','/tmp/review.md','x.md;true','x.md\n','x.txt','.secret.md','a'*121+'.md']:
            self.assertFalse(runner.coding_dispatch_control.report_name(value),value)


if __name__=='__main__':unittest.main()
