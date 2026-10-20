import json
import base64
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
    MODE = 'single'

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
        self.uploads=[]; self.partial_uploads=[]; self.exit_code=0; self.limit=128; self.server_limit=None
        self.receipt=None;self.terminated=True;self.completed=True;self.lose_response=False
        for name,value in [('WORKSPACES',self.root),('MODEL','fixture-model'),('RECEIPTS',self.root/'receipts'),
                           ('request',self.request),('feedback',mock.Mock(side_effect=self.feedback)),
                           ('run_worker',mock.Mock(side_effect=self.worker)),('install_dependencies',mock.Mock()),
                           ('push_and_open_pr',mock.Mock())]:
            patch=mock.patch.object(runner,name,value);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(sys,'argv',['coding_run','0001','--request-id',KEY,'--report-name','review.md'])
        patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.dict(os.environ,{'AGENTX_REPORT_MODE':self.MODE})
        patch.start();self.addCleanup(patch.stop)

    def request(self,url,body=None,**kwargs):
        if '/reports/' in url:
            if url.endswith('/start'):
                self.start_intent=body
                return {'data':{'requestId':KEY,'claimSeq':2,'modelCallLimit':body['modelCallLimit'] if self.server_limit is None else self.server_limit,
                    'parentRequestId':body.get('parentRequestId'),'parentSha256':body.get('parentSha256'),
                    'authority':{'queueEndAt':'2099-01-01T00:00:00Z','workSeconds':14400},
                    'inventory':dict(body['inventory'],sha256='a'*64)}}
            if url.endswith('/checkpoint'):
                return {'data':self.checkpoint}
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
                self.partial_uploads.append(body.get('partial'))
                archived = {'partial': {'deliverableId': 'b'*24, 'sha256': body['partial']['sha256']}} if body.get('partial') else {}
                return {'data':{'blocked':True,'outcome':{'requestId':KEY,'claimSeq':2, **archived}}}
            return {'data':{'requestId':KEY,'claimSeq':2,'terminationVerified':self.terminated,'allCallsCompleted':self.completed,
                'inventory':dict(self.start_intent['inventory'],sha256='a'*64) if hasattr(self,'start_intent') else None}}
        if url.endswith('/claim'):self.task.update(status='in_progress',assignee='coding-team')
        elif '/deliverables/' in url:return {'data':{'receipt':self.receipt}}
        return {'data':{'task':self.task}}

    def feedback(self,task,text,status,**kwargs):
        self.task['status']='review' if status=='done' else status

    def worker(self,workspace,prompt,timeout,progress,*,read_only):
        self.assertTrue(read_only); self.assertIn('/home/agent/deliverables/'+KEY+'/review.md',prompt)
        self.assertIn('/workspace/AGENTS.md',prompt);self.assertIn('git -C /workspace',prompt)
        self.assertIn(str(self.limit)+' model requests',prompt)
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

    def test_stopped_worker_archives_partial_without_offering_it_as_a_completed_report(self):
        self.exit_code=124
        with mock.patch('builtins.print'):self.assertEqual(runner.main(),1)
        self.assertEqual(self.task['status'],'blocked');self.assertTrue(self.path.is_file());self.assertEqual(self.uploads,[])
        self.assertEqual(len(self.partial_uploads),1)
        self.assertEqual(self.partial_uploads[0]['sha256'],hashlib.sha256(self.path.read_bytes()).hexdigest())
        self.assertEqual((runner.RECEIPTS/(KEY+'.report-partial.md')).read_bytes(),self.path.read_bytes())
        self.assertEqual(runner.git(self.workspace,'rev-parse','HEAD'),self.head);runner.push_and_open_pr.assert_not_called()

    def test_extended_report_budget_reaches_core_prompt_and_terminal_progress(self):
        self.limit=256
        with mock.patch.object(sys,'argv',['coding_run','0001','--request-id',KEY,'--report-name','review.md','--model-call-limit','256']), mock.patch('builtins.print'):
            self.assertEqual(runner.main(),0)
        self.assertEqual(self.start_intent['modelCallLimit'],256)
        progress=__import__('json').loads((runner.RECEIPTS/(KEY+'.progress.json')).read_text())
        self.assertEqual(progress['modelCallLimit'],256);self.assertEqual(len(self.uploads),1)

    def test_a_core_budget_mismatch_refuses_model_dispatch(self):
        self.limit=256;self.server_limit=128
        with mock.patch.object(sys,'argv',['coding_run','0001','--request-id',KEY,'--report-name','review.md','--model-call-limit','256']), mock.patch('builtins.print'):
            self.assertEqual(runner.main(),1)
        runner.run_worker.assert_not_called();self.assertEqual(self.uploads,[])

    def test_invalid_budget_or_nonreport_override_refuses_before_task_claim(self):
        for tail in [['--report-name','review.md','--model-call-limit','257'], ['--model-call-limit','256'],
                     ['--report-name','review.md','--model-call-limit','127']]:
            with self.subTest(tail=tail), mock.patch.object(sys,'argv',['coding_run','0001','--request-id',KEY,*tail]), \
                 mock.patch('sys.stderr'), self.assertRaises(SystemExit):runner.main()
        self.assertEqual(self.task['status'],'queued');runner.run_worker.assert_not_called()

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
        with mock.patch('time.sleep') as sleep,mock.patch('builtins.print'):self.assertEqual(runner.main(),2)
        self.assertEqual(sleep.call_count,runner.REPORT_SETTLE_GRACE_SECONDS//2)
        progress=__import__('json').loads((runner.RECEIPTS/(KEY+'.progress.json')).read_text())
        self.assertNotEqual(progress['phase'],'finished');self.assertFalse(progress['coreRecorded'])
        self.assertEqual(progress['stopReason'],'model_termination_unverified');self.assertEqual(self.uploads,[])
        runner.feedback.assert_not_called()

    def test_core_settlement_lag_is_awaited_before_recording_the_stop(self):
        # Relay EOF can precede Core's receipt; the short poll settles it
        # without leaving the execution active for manual reconciliation.
        self.exit_code=124;self.terminated=False;reads=[]
        original=self.request
        def lagging(url,body=None,**kwargs):
            if '/reports/' in url and body is None and not url.endswith('/checkpoint'):
                reads.append(url)
                if len(reads)>=3:self.terminated=True
            return original(url,body,**kwargs)
        # Count only the settlement poll: the subprocess watch loop also
        # sleeps 2 s when a child process is still running, depending on speed.
        polls=[]
        def sleeping(seconds):
            frame=sys._getframe(1)
            while frame and frame.f_code.co_name!='settled_status':frame=frame.f_back
            if frame:polls.append(seconds)
        with mock.patch.object(runner,'request',lagging),mock.patch('time.sleep',side_effect=sleeping),mock.patch('builtins.print'):
            self.assertEqual(runner.main(),1)
        self.assertEqual(self.task['status'],'blocked');self.assertEqual(len(self.partial_uploads),1)
        self.assertEqual(polls,[2,2])

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

    def test_resume_loads_verified_prior_bytes_before_the_worker_reads_or_writes(self):
        parent='22222222-2222-4333-8444-555555555555';data=b'# Prior findings\n\nREADME reviewed; operations pending.\n'
        digest=hashlib.sha256(data).hexdigest()
        self.checkpoint={'requestId':KEY,'parentRequestId':parent,'sha256':digest,'sourceCommit':self.head,
                         'dataUrl':'data:text/markdown;base64,'+base64.b64encode(data).decode()}
        original=self.worker
        def resumed(*args,**kwargs):
            self.assertEqual(self.path.read_bytes(),data)
            self.assertIn('Read it first and extend it',args[1])
            return original(*args,**kwargs)
        with mock.patch.object(sys,'argv',['coding_run','0001','--request-id',KEY,'--report-name','review.md',
                 '--parent-request-id',parent,'--parent-sha256',digest]), mock.patch.object(runner,'run_worker',side_effect=resumed), mock.patch('builtins.print'):
            self.assertEqual(runner.main(),0)
        self.assertEqual(self.start_intent['parentRequestId'],parent)
        self.assertEqual(runner.git(self.workspace,'rev-parse','HEAD'),self.head)

    def test_resume_refuses_a_changed_core_checkpoint_before_any_model_dispatch(self):
        parent='22222222-2222-4333-8444-555555555555';digest=hashlib.sha256(b'Original').hexdigest()
        self.checkpoint={'requestId':KEY,'parentRequestId':parent,'sha256':digest,'sourceCommit':self.head,
                         'dataUrl':'data:text/markdown;base64,'+base64.b64encode(b'Changed').decode()}
        with mock.patch.object(sys,'argv',['coding_run','0001','--request-id',KEY,'--report-name','review.md',
                 '--parent-request-id',parent,'--parent-sha256',digest]), mock.patch('builtins.print'):
            self.assertEqual(runner.main(),2)
        runner.run_worker.assert_not_called();self.assertEqual(self.uploads,[])

    def test_lost_stop_response_reconciles_the_same_frozen_partial_even_if_the_output_changes(self):
        self.exit_code=124;original=self.request;lost=[False];bodies=[]
        def api(url,body=None,**kwargs):
            result=original(url,body,**kwargs)
            if url.endswith('/stop-result'):
                bodies.append(body)
                if not lost[0]:lost[0]=True;raise OSError('Acknowledgement lost after storage')
            return result
        with mock.patch.object(runner,'request',side_effect=api),mock.patch('builtins.print'):
            self.assertEqual(runner.main(),2)
            frozen=(runner.RECEIPTS/(KEY+'.report-partial.md')).read_bytes()
            self.path.write_text('Later bytes must not replace the frozen original')
            with mock.patch.object(runner.coding_dispatch_control,'unit_active',return_value=False), \
                 mock.patch.object(runner.coding_dispatch_control,'read_receipt',return_value={'pipelineId':'0001','reportName':'review.md'}):
                self.assertTrue(report.reconcile(runner,'0001',KEY)['reconciled'])
        self.assertEqual(bodies[0],bodies[1]);self.assertEqual((runner.RECEIPTS/(KEY+'.report-partial.md')).read_bytes(),frozen)
        self.assertEqual(json.loads((runner.RECEIPTS/(KEY+'.progress.json')).read_text())['coreRecorded'],True)

    def test_start_ack_loss_exposes_same_uuid_reconciliation_without_running_the_model(self):
        original=self.request;lost=[False];starts=[]
        def api(url,body=None,**kwargs):
            value=original(url,body,**kwargs)
            if url.endswith('/start'):
                starts.append(body)
                if not lost[0]:
                    lost[0]=True;raise OSError('Start acknowledgement lost after Core allocation')
            return value
        control=runner.coding_dispatch_control
        with mock.patch.object(runner,'request',side_effect=api),mock.patch('builtins.print'):
            self.assertEqual(runner.main(),2)
            self.assertTrue((runner.RECEIPTS/(KEY+'.report-start.json')).exists())
            runner.run_worker.assert_not_called()
            with mock.patch.object(control,'STATE',self.root),mock.patch.object(control,'RECEIPTS',runner.RECEIPTS), \
                 mock.patch.object(control,'queued_tasks',return_value=[]),mock.patch.object(control,'unit_active',return_value=False):
                control.save_receipt({'requestId':KEY,'pipelineId':'0001','expectedAttemptCount':0,'phase':'accepted','reportName':'review.md'})
                state=control.status(KEY)
                self.assertEqual(state['run']['phase'],'unknown');self.assertTrue(state['run']['canReconcile'])
                self.assertTrue(report.reconcile(runner,'0001',KEY)['reconciled'])
        self.assertEqual(len(starts),1);runner.run_worker.assert_not_called()
        self.assertEqual(self.task['status'],'blocked')

    def test_missing_core_run_replays_the_saved_start_without_a_new_model_worker(self):
        original=self.request;starts=[];missing=[True]
        def api(url,body=None,**kwargs):
            if url.endswith('/start'):
                starts.append(body)
                if len(starts)==1:raise OSError('Allocation saved without Run acknowledgement')
            if '/reports/' in url and body is None and not url.endswith('/checkpoint') and missing[0]:
                missing[0]=False;error=RuntimeError('HTTP404 missing Run');error.code='REPORT_NOT_FOUND';raise error
            return original(url,body,**kwargs)
        with mock.patch.object(runner,'request',side_effect=api),mock.patch('builtins.print'):
            self.assertEqual(runner.main(),2)
            with mock.patch.object(runner.coding_dispatch_control,'unit_active',return_value=False), \
                 mock.patch.object(runner.coding_dispatch_control,'read_receipt',return_value={'pipelineId':'0001','reportName':'review.md'}):
                self.assertTrue(report.reconcile(runner,'0001',KEY)['reconciled'])
        self.assertEqual(starts[0],starts[1]);runner.run_worker.assert_not_called()

    def test_malformed_coverage_never_loses_a_valid_stopped_report(self):
        original=self.worker;self.exit_code=124
        def incomplete(*args,**kwargs):
            result=original(*args,**kwargs)
            (self.path.parent/'coverage.json').write_text('[]')
            return result
        runner.run_worker.side_effect=incomplete
        with mock.patch('builtins.print'):self.assertEqual(runner.main(),1)
        self.assertEqual(self.task['status'],'blocked');self.assertEqual(len(self.partial_uploads),1)
        self.assertEqual(self.partial_uploads[0]['sha256'],hashlib.sha256(self.path.read_bytes()).hexdigest())

    def test_missing_source_reference_does_not_prevent_partial_reconciliation(self):
        original=self.worker;self.exit_code=124;api=self.request;lost=[False]
        def incomplete(*args,**kwargs):
            result=original(*args,**kwargs);path=self.path.parent/'coverage.json';value=json.loads(path.read_text())
            value['documents'][0].update(state='reviewed',evidence=[{'path':'absent-source.js','sha256':'a'*64,'line':1,'check':'Incomplete source lookup'}])
            path.write_text(json.dumps(value));return result
        def response(url,body=None,**kwargs):
            value=api(url,body,**kwargs)
            if url.endswith('/stop-result') and not lost[0]:
                lost[0]=True;raise OSError('Stop acknowledgement lost')
            return value
        runner.run_worker.side_effect=incomplete
        with mock.patch.object(runner,'request',side_effect=response),mock.patch('builtins.print'):
            self.assertEqual(runner.main(),2)
            with mock.patch.object(runner.coding_dispatch_control,'unit_active',return_value=False), \
                 mock.patch.object(runner.coding_dispatch_control,'read_receipt',return_value={'pipelineId':'0001','reportName':'review.md'}):
                self.assertTrue(report.reconcile(runner,'0001',KEY)['reconciled'])
        self.assertEqual(len(self.partial_uploads),2);self.assertEqual(self.partial_uploads[0],self.partial_uploads[1])
        runner.run_worker.assert_called_once()

    def test_source_coverage_checks_the_frozen_git_bytes_and_refuses_invalid_structures(self):
        snapshot=report.scope.inventory(self.workspace,self.head);snapshot['sha256']='a'*64
        self.path.parent.mkdir(parents=True);report.scope.seed(self.path.parent,snapshot)
        path=self.path.parent/'coverage.json';value=json.loads(path.read_text())
        value['documents'][0].update(state='reviewed',evidence=[{'path':'README.md','sha256':hashlib.sha256(b'Public source\n').hexdigest(),'line':1,'check':'Verified public source claim'}])
        path.write_text(json.dumps(value))
        self.assertEqual(report.scope.read(report.report_bytes,self.workspace,self.path.parent,snapshot)['documents'][0]['state'],'reviewed')
        for invalid in [[],{'inventorySha256':'a'*64,'documents':[None]}, {'inventorySha256':'a'*64,'documents':[dict(value['documents'][0],evidence=[None])]}]:
            path.write_text(json.dumps(invalid))
            with self.assertRaises(ValueError):report.scope.read(report.report_bytes,self.workspace,self.path.parent,snapshot)

    def test_known_start_refusal_is_received_without_unknown_or_model_replay(self):
        original=self.request
        def api(url,body=None,**kwargs):
            if url.endswith('/start'):
                error=RuntimeError('Known expired campaign');error.code='REPORT_CAMPAIGN_UNVERIFIED'
                error.data={'reportRefusalReceived':True,'pipelineId':'0001','requestId':KEY,'claimSeq':2}
                raise error
            return original(url,body,**kwargs)
        with mock.patch.object(runner,'request',side_effect=api),mock.patch('builtins.print'):
            self.assertEqual(runner.main(),1)
        value=json.loads((runner.RECEIPTS/(KEY+'.progress.json')).read_text())
        self.assertTrue(value['coreRecorded']);self.assertEqual(value['modelCalls'],0)
        runner.run_worker.assert_not_called()

    def test_preparation_receipt_ack_loss_reconciles_same_intent_without_model(self):
        original=self.request;received=[False];bodies=[]
        def api(url,body=None,**kwargs):
            if url.endswith('/preflight-result'):
                bodies.append(body);received[0]=True;raise OSError('Receipt committed, response lost')
            if '/reports/' in url and body is None and received[0]:
                return {'data':{'requestId':KEY,'pipelineId':'0001','claimSeq':2,'preflight':True,'terminationVerified':True}}
            return original(url,body,**kwargs)
        (self.workspace/'README.md').write_text('Changed source must refuse before dispatch')
        with mock.patch.object(runner,'request',side_effect=api),mock.patch('builtins.print'):
            self.assertEqual(runner.main(),2)
            with mock.patch.object(runner.coding_dispatch_control,'unit_active',return_value=False):
                self.assertTrue(report.reconcile(runner,'0001',KEY)['reconciled'])
        self.assertEqual(len(bodies),1);runner.run_worker.assert_not_called()
        self.assertTrue(json.loads((runner.RECEIPTS/(KEY+'.progress.json')).read_text())['coreRecorded'])

    def test_resume_inherits_original_bytes_through_a_terminal_parent_with_no_new_file(self):
        parent='22222222-2222-4333-8444-555555555555';author='33333333-2222-4333-8444-555555555555'
        data=b'# Preserved model work';digest=hashlib.sha256(data).hexdigest()
        self.checkpoint={'requestId':KEY,'parentRequestId':parent,'sha256':digest,'sourceCommit':self.head,
            'inherited':True,'contentRequestId':author,'dataUrl':'data:text/markdown;base64,'+base64.b64encode(data).decode()}
        self.path.parent.mkdir(parents=True)
        args=__import__('types').SimpleNamespace(task_id='0001',request_id=KEY,parent_request_id=parent,parent_sha256=None)
        report.restore_checkpoint(runner,args,self.path,self.head)
        self.assertEqual(self.path.read_bytes(),data);runner.run_worker.assert_not_called()

    def test_excess_coverage_evidence_keeps_saved_markdown_archivable_and_reconcilable(self):
        original_worker=self.worker;original_api=self.request;self.exit_code=124;lost=[False]
        def excessive(*args,**kwargs):
            result=original_worker(*args,**kwargs);path=self.path.parent/'coverage.json';value=json.loads(path.read_text())
            ref={'path':'README.md','sha256':hashlib.sha256(b'Public source\n').hexdigest(),'line':1,'check':'Checked source claim'}
            value['documents'][0].update(state='reviewed',evidence=[ref]*101);path.write_text(json.dumps(value));return result
        def api(url,body=None,**kwargs):
            value=original_api(url,body,**kwargs)
            if url.endswith('/stop-result'):
                self.assertNotIn('coverage',body)
                if not lost[0]:lost[0]=True;raise OSError('Lost archive acknowledgement')
            return value
        runner.run_worker.side_effect=excessive
        with mock.patch.object(runner,'request',side_effect=api),mock.patch('builtins.print'):
            self.assertEqual(runner.main(),2)
            with mock.patch.object(runner.coding_dispatch_control,'unit_active',return_value=False), \
                 mock.patch.object(runner.coding_dispatch_control,'read_receipt',return_value={'pipelineId':'0001','reportName':'review.md'}):
                self.assertTrue(report.reconcile(runner,'0001',KEY)['reconciled'])
        self.assertEqual(len(self.partial_uploads),2);self.assertEqual(self.partial_uploads[0],self.partial_uploads[1])
        runner.run_worker.assert_called_once()

    def test_modified_sandbox_inventory_cannot_poison_the_immutable_stop_receipt(self):
        original_worker=self.worker;original_api=self.request;self.exit_code=124;lost=[False]
        def poisoned(*args,**kwargs):
            result=original_worker(*args,**kwargs);root=self.path.parent
            snapshot=json.loads((root/'source-inventory.json').read_text());snapshot['sha256']='b'*64
            (root/'source-inventory.json').write_text(json.dumps(snapshot))
            value=json.loads((root/'coverage.json').read_text());value['inventorySha256']='b'*64
            (root/'coverage.json').write_text(json.dumps(value));return result
        def api(url,body=None,**kwargs):
            value=original_api(url,body,**kwargs)
            if url.endswith('/stop-result'):
                self.assertNotIn('coverage',body)
                if not lost[0]:lost[0]=True;raise OSError('Lost stop acknowledgement')
            return value
        runner.run_worker.side_effect=poisoned
        with mock.patch.object(runner,'request',side_effect=api),mock.patch('builtins.print'):
            self.assertEqual(runner.main(),2)
            with mock.patch.object(runner.coding_dispatch_control,'unit_active',return_value=False), \
                 mock.patch.object(runner.coding_dispatch_control,'read_receipt',return_value={'pipelineId':'0001','reportName':'review.md'}):
                self.assertTrue(report.reconcile(runner,'0001',KEY)['reconciled'])
        self.assertEqual(self.partial_uploads[0],self.partial_uploads[1]);runner.run_worker.assert_called_once()


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

    def test_dispatch_binds_report_budget_and_rejects_replay_with_changed_budget(self):
        control=runner.coding_dispatch_control
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(control,'STATE',Path(directory)), \
             mock.patch.object(control,'RECEIPTS',Path(directory)/'requests'),mock.patch.object(control,'unit_active',return_value=False), \
             mock.patch.object(control,'queued_tasks',return_value=[{'pipelineId':'0001','status':'queued','service':'agentx-coding'}]), \
             mock.patch.object(control.subprocess,'run') as unit:
            with mock.patch.object(sys,'argv',['control','launch-report','0001',KEY,'0','review.md','--model-call-limit','256']), mock.patch('builtins.print') as printed:
                control.main()
            result=__import__('json').loads(printed.call_args.args[0]);self.assertEqual(result['data']['run']['modelCallLimit'],256)
            self.assertEqual(unit.call_args.args[0][-2:],['--model-call-limit','256'])
            self.assertTrue(control.launch('0001',KEY,0,report='review.md',model_call_limit=256)['replayed'])
            with self.assertRaises(control.ControlError):control.launch('0001',KEY,0,report='review.md')
            self.assertEqual(unit.call_count,1)

    def test_dispatch_refuses_invalid_budgets_without_host_effects(self):
        control=runner.coding_dispatch_control
        with mock.patch.object(control.subprocess,'run') as unit, mock.patch.object(control,'save_receipt') as save:
            for value in [127,257,256.0,True,'256']:
                with self.subTest(value=value),self.assertRaises(control.ControlError):
                    control.launch('0001',KEY,0,report='review.md',model_call_limit=value)
            with self.assertRaises(control.ControlError):control.launch('0001',KEY,0,model_call_limit=256)
            unit.assert_not_called();save.assert_not_called()

    def test_report_name_cannot_inject_shell_or_leave_its_directory(self):
        for value in ['../review.md','/tmp/review.md','x.md;true','x.md\n','x.txt','.secret.md','a'*121+'.md']:
            self.assertFalse(runner.coding_dispatch_control.report_name(value),value)


if __name__=='__main__':unittest.main()


class StepsReportTest(unittest.TestCase):
    """Runner-owned report steps (#834): the model writes one JSON result per group."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.workspace = self.root/'task-0001'; (self.workspace/'docs').mkdir(parents=True)
        runner.git(self.workspace,'init','--quiet')
        (self.workspace/'README.md').write_text('# Project\nThe `RETRY_LIMIT` is 5.\n')
        (self.workspace/'docs'/'GUIDE.md').write_text('# Guide\nRun npm start.\n')
        (self.workspace/'config.js').write_text("const RETRY_LIMIT = 7;\nmodule.exports = { RETRY_LIMIT };\n")
        runner.git(self.workspace,'add','.'); runner.git(self.workspace,*runner.AUTHOR,'commit','-qm','Initial')
        self.head = runner.git(self.workspace,'rev-parse','HEAD')
        self.home = self.root/'.home-task-0001'
        self.out = self.home/'deliverables'/KEY
        self.task = {'pipelineId':'0001','title':'Documentation review','spec':'Review every Markdown document.',
                     'status':'queued','service':'agentx-coding','feedback':[],'transitions':[{'kind':'claimed','seq':2}]}
        self.uploads=[]; self.stops=[]; self.answers=[]; self.prompts=[]
        for name,value in [('WORKSPACES',self.root),('MODEL','fixture-model'),('RECEIPTS',self.root/'receipts'),
                           ('request',self.request),('feedback',mock.Mock()),
                           ('run_worker',mock.Mock(side_effect=self.worker)),('install_dependencies',mock.Mock()),
                           ('push_and_open_pr',mock.Mock())]:
            patch=mock.patch.object(runner,name,value);patch.start();self.addCleanup(patch.stop)
        for patch in [mock.patch.object(sys,'argv',['coding_run','0001','--request-id',KEY,'--report-name','review.md']),
                      mock.patch.dict(os.environ,{'AGENTX_REPORT_MODE':'steps'})]:
            patch.start();self.addCleanup(patch.stop)

    def request(self,url,body=None,**kwargs):
        if 'agent-runtime-config/export' in url:
            return {'data':{'lanes':{'codingSpecialist':{'role':'codingSpecialist','model':'fixture-model',
                    'capability':{'agent':{'recommendedStepContext':16384},'provenance':{'depth':'full'}}}}}}
        if '/reports/' in url:
            if url.endswith('/start'):
                self.start_intent=body
                return {'data':{'requestId':KEY,'claimSeq':2,'modelCallLimit':body['modelCallLimit'],
                    'escalation':getattr(self,'escalation',None),
                    'parentRequestId':None,'parentSha256':None,
                    'authority':{'queueEndAt':'2099-01-01T00:00:00Z','workSeconds':14400},
                    'inventory':dict(body['inventory'],sha256='a'*64)}}
            if url.endswith('/result'):
                self.uploads.append(body); self.task['status']='review'
                receipt={'id':'a'*24,'pipelineId':'0001','ref':'r','sha256':body['sha256'],'size':len(base64.b64decode(body['dataUrl'].split(',')[1])),
                         'availability':{'status':'available','hashVerified':True}}
                self.receipt=receipt
                return {'data':{'reportReadyForReview':True,'receipt':receipt,'outcome':{'requestId':KEY,'claimSeq':2,'sourceCommit':self.head,'sha256':body['sha256']}}}
            if url.endswith('/stop-result'):
                self.stops.append(body); self.task['status']='blocked'
                archived = {'partial': {'deliverableId': 'b'*24, 'sha256': body['partial']['sha256']}} if body.get('partial') else {}
                return {'data':{'blocked':True,'outcome':{'requestId':KEY,'claimSeq':2, **archived}}}
            return {'data':{'requestId':KEY,'claimSeq':2,'terminationVerified':True,'allCallsCompleted':True,
                'inventory':dict(self.start_intent['inventory'],sha256='a'*64)}}
        if url.endswith('/claim'):self.task.update(status='in_progress',assignee='coding-team')
        elif '/deliverables/' in url:return {'data':{'receipt':self.receipt}}
        return {'data':{'task':self.task}}

    def worker(self,workspace,prompt,timeout,progress,*,read_only):
        self.prompts.append(prompt)
        progress.model_calls += 2
        name = progress.step['output'].rsplit('/',1)[1]
        answer = self.answers.pop(0) if self.answers else None
        if answer is not None:
            (self.out/name).write_text(json.dumps(answer(prompt)) if callable(answer) else answer)
        return subprocess.CompletedProcess([],0,stdout='',stderr='')

    @staticmethod
    def reviewed(prompt):
        docs = [line[2:] for line in prompt.split('Review ONLY these documents against the source code and architecture:\n')[1].split('\n\n')[0].splitlines()]
        result = {'documents':[{'path':doc,'state':'reviewed','evidence':[{'path':'config.js','line':1,'check':'RETRY_LIMIT'}]} for doc in docs],'findings':[]}
        if 'README.md' in docs:
            result['findings'].append({'kind':'inaccuracy','severity':'medium','title':'Retry limit is 7','document':{'path':'README.md','line':2},
                'evidence':[{'path':'config.js','line':1,'check':'RETRY_LIMIT = 7'}],'correction':'Say 7.'})
        return result

    def correction_step(self, answer, notes='Check the count.', prior=None):
        self.out.mkdir(parents=True, exist_ok=True)
        for stale in self.out.glob('step-*.json'):
            stale.unlink()
        snapshot = dict(report.scope.inventory(self.workspace, self.head), sha256='a' * 64)
        ledger = prior or report.ledgers.new_ledger(snapshot, legacy_markdown='Six families.')
        for row in ledger['documents'].values():
            row['state'] = 'reviewed'
        ledger['legacyReviewed'] = True  # Reproduce the old runner's unproven flag.
        path = self.out/'review.md'
        path.write_text(report.ledgers.render(ledger, 'Review'))
        self.task['feedback'] = [{'by': 'operator', 'text': notes}]
        self.answers = [answer]
        progress = mock.Mock(model_calls=0, hard_deadline=14400, queue_deadline=14400,
                             stop_reason=None, report_drained=True)
        progress.now.return_value = 0
        progress.check_stop.return_value = False
        progress.call_limit.return_value = 128
        progress.begin_step.side_effect = lambda calls, seconds, output: setattr(progress, 'step', {'output': output})
        args = mock.Mock(task_id='0001', request_id=KEY)
        outcome = report.run_steps(runner, args, progress, self.task, self.workspace, self.out,
                                   path, snapshot, self.head)
        return outcome, report.ledgers.embedded(path.read_text())

    def test_missing_or_invalid_correction_results_cannot_complete_reviewed_inventory(self):
        for answer in [None, 'not json', '{}', '{"legacyEdits":[{"find":"missing","replace":"Eight"}]}']:
            with self.subTest(answer=answer):
                outcome, ledger = self.correction_step(answer)
                self.assertEqual(outcome, 'worker_exit')
                self.assertTrue(ledger['legacyReviewPending'])
                self.assertEqual(ledger['steps'][-1]['result'], 'failed')
                self.assertEqual(ledger['legacyReview']['requestId'], KEY)
                self.assertFalse(report.ledgers.coverage(ledger)['declaredComplete'])
                self.assertEqual(ledger['legacy'], 'Six families.')

    def test_successful_correction_checkpoint_skips_same_notes_but_applies_new_notes(self):
        answer = lambda prompt: {'legacyEdits': [{'find': 'Six families.', 'replace': 'Eight families.'}]}
        outcome, ledger = self.correction_step(answer)
        self.assertEqual(outcome, 'complete')
        self.assertFalse(ledger['legacyReviewPending'])
        calls = runner.run_worker.call_count
        outcome, restored = self.correction_step(None, prior=ledger)
        self.assertEqual(outcome, 'complete')
        self.assertEqual(runner.run_worker.call_count, calls)
        outcome, corrected = self.correction_step(lambda prompt: {'legacyEdits': []},
                                                  notes='Check the version too.', prior=restored)
        self.assertEqual(outcome, 'complete')
        self.assertEqual(runner.run_worker.call_count, calls + 1)
        self.assertEqual(corrected['legacy'], 'Eight families.')
        self.assertNotEqual(corrected['legacyReview']['notesSha256'], restored['legacyReview']['notesSha256'])

    def test_reviews_groups_in_fresh_sessions_and_delivers_a_rendered_report(self):
        self.answers=[self.reviewed, self.reviewed, lambda prompt:{'summary':'Two documents reviewed; one wrong value.','explanations':{'F1':'Readers would set 5.'}}]
        with mock.patch('builtins.print'):self.assertEqual(runner.main(),0)
        self.assertEqual(len(self.uploads),1)
        report = base64.b64decode(self.uploads[0]['dataUrl'].split(',')[1]).decode()
        self.assertIn('#### F1 — Retry limit is 7 *(medium)*', report)
        self.assertIn('Readers would set 5.', report)
        self.assertIn('Two documents reviewed; one wrong value.', report)
        self.assertIn('| 2 | 0 | 0 | 0 | 1 |', report)
        self.assertTrue(self.uploads[0]['coverage']['declaredComplete'])
        self.assertEqual(runner.run_worker.call_count,3)
        self.assertNotIn('docs/GUIDE.md', self.prompts[0] if 'README.md' in self.prompts[0] else self.prompts[1])
        progress=json.loads((runner.RECEIPTS/(KEY+'.progress.json')).read_text())
        self.assertEqual(progress['reportSteps']['done'],2)
        self.assertEqual(progress['reportSteps']['budgetSource'],'agent_workload')
        self.assertEqual(runner.git(self.workspace,'status','--porcelain'),'')

    def test_a_failing_group_is_retried_alone_then_blocked_without_stopping_the_others(self):
        self.answers=[self.reviewed, 'not json', '{"documents": []}', lambda prompt:{'summary':'x','explanations':{}}]
        with mock.patch('builtins.print'):self.assertEqual(runner.main(),0)
        coverage = self.uploads[0]['coverage']
        states = {row['path']: row['state'] for row in coverage['documents']}
        self.assertEqual(sorted(states.values()), ['blocked','reviewed'])
        self.assertFalse(coverage['declaredComplete'])

    def test_exhausted_calls_stop_with_a_partial_report_for_continuation(self):
        self.answers=[self.reviewed]
        with mock.patch.object(runner.coding_progress.Progress,'call_limit',lambda progress: 23), mock.patch('builtins.print'):
            self.assertEqual(runner.main(),1)
        self.assertEqual(self.uploads,[])
        self.assertEqual(self.stops[0]['workerOutcome']['reason'],'model_call_limit')
        partial = base64.b64decode(self.stops[0]['partial']['dataUrl'].split(',')[1]).decode()
        self.assertIn('agentx-report-ledger:v1', partial)
        self.assertIn('1 documents are not fully reviewed.', partial)


class EscalationStepsTest(StepsReportTest):
    """A group that fails locally is retried once on the cloud escalation path (#835)."""

    def escalation_answer(self, content=None, error=None):
        sent = []
        class Response:
            def __init__(self, value): self.value = value
            def __enter__(self): return self
            def __exit__(self, *exc): return False
            def read(self, *args): return json.dumps(self.value).encode()
        def urlopen(request, timeout=None):
            sent.append(request)
            if error: raise OSError(error)
            return Response({'model': 'openrouter/nvidia/nemotron', 'choices': [{'message': {'content': content}}]})
        return sent, mock.patch('urllib.request.urlopen', urlopen)

    def test_a_failed_group_is_retried_once_in_the_cloud_and_its_findings_are_marked(self):
        self.escalation = {'models': ['openai/gpt-5.6-sol', 'openrouter/nvidia/nemotron'], 'maxCostNanodollars': 10e9, 'calls': 0}
        self.answers = ['not json', self.reviewed, lambda prompt: {'summary': 's', 'explanations': {}}]
        content = json.dumps({'documents': [{'path': 'README.md', 'state': 'reviewed',
            'evidence': [{'path': 'config.js', 'line': 1, 'check': 'RETRY_LIMIT'}]}],
            'findings': [{'kind': 'inaccuracy', 'severity': 'high', 'title': 'Retry limit is 7', 'document': {'path': 'README.md', 'line': 2},
                          'evidence': [{'path': 'config.js', 'line': 1, 'check': 'RETRY_LIMIT = 7'}], 'correction': 'Say 7.'}]})
        sent, patch = self.escalation_answer('```json\n' + content + '\n```')
        with patch, mock.patch('builtins.print'):
            self.assertEqual(runner.main(), 0)
        self.assertEqual(len(sent), 1)
        request = sent[0]
        self.assertEqual(request.get_header('X-agentx-report-escalation'), '2')
        self.assertEqual(request.get_header('X-agentx-report-request'), KEY)
        payload = json.loads(request.data)
        self.assertEqual(payload['model'], 'openai/gpt-5.6-sol')
        self.assertIn('=== SOURCE config.js', payload['messages'][1]['content'])
        self.assertIn('1: const RETRY_LIMIT = 7;', payload['messages'][1]['content'])
        report = base64.b64decode(self.uploads[0]['dataUrl'].split(',')[1]).decode()
        self.assertIn('Found by cloud escalation on `openrouter/nvidia/nemotron`', report)
        progress = json.loads((runner.RECEIPTS/(KEY+'.progress.json')).read_text())
        self.assertEqual(progress['reportSteps']['escalated'], 1)

    def test_the_escalated_call_carries_the_gateway_token_when_one_is_installed(self):
        self.escalation = {'models': ['openrouter/nvidia/nemotron'], 'maxCostNanodollars': 10e9, 'calls': 0}
        self.answers = ['not json', self.reviewed, lambda prompt: {'summary': 's', 'explanations': {}}]
        sent, patch = self.escalation_answer(error='refused')
        with patch, mock.patch.object(runner, 'GATEWAY_TOKEN', 'coding-team-token'), mock.patch('builtins.print'):
            runner.main()
        self.assertEqual(sent[0].get_header('Authorization'), 'Bearer coding-team-token')

    def test_an_unavailable_escalation_blocks_the_group_after_its_second_failure(self):
        self.escalation = {'models': ['openai/gpt-5.6-sol'], 'maxCostNanodollars': 10e9, 'calls': 0}
        self.answers = ['not json', self.reviewed, lambda prompt: {'summary': 's', 'explanations': {}}]
        sent, patch = self.escalation_answer(error='connection refused')
        with patch, mock.patch('builtins.print'):
            self.assertEqual(runner.main(), 0)
        self.assertEqual(len(sent), 1)
        states = sorted(row['state'] for row in self.uploads[0]['coverage']['documents'])
        self.assertEqual(states, ['blocked', 'reviewed'])

    def test_no_escalation_without_permission_from_core(self):
        self.escalation = None
        self.answers = ['not json', self.reviewed, '{"documents": []}', lambda prompt: {'summary': 's', 'explanations': {}}]
        sent, patch = self.escalation_answer('{}')
        with patch, mock.patch('builtins.print'):
            self.assertEqual(runner.main(), 0)
        self.assertEqual(sent, [])
