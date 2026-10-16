"""Read-only report worker, native inference receipts and private Core delivery."""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

MAX_BYTES = 2 * 1024 * 1024
# Only reasons accepted by Core\'s shared worker-outcome observation contract.
STOP_REASONS = frozenset(('no_useful_progress', 'model_output_limit', 'model_call_limit',
    'soft_budget_no_progress', 'hard_budget', 'worker_exit', 'operator_stop', 'runner_error'))

def stop_reason(reason):
    return reason if reason in STOP_REASONS else 'runner_error'


def report_bytes(path: Path, root: Path) -> bytes:
    if path.parent != root:
        raise ValueError('Report must belong to its private output directory')
    handles = []
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        handles.append(os.open(root.parent.parent, flags))
        for segment in (root.parent.name, root.name):
            handles.append(os.open(segment, flags, dir_fd=handles[-1]))
        handles.append(os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=handles[-1]))
        info = os.fstat(handles[-1])
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_BYTES:
            raise ValueError('Report must be a regular nonempty file of at most 2 MiB')
        with os.fdopen(os.dup(handles[-1]), 'rb') as stream:
            data = stream.read(MAX_BYTES+1)
    finally:
        for descriptor in reversed(handles):
            os.close(descriptor)
    if not 0 < len(data) <= MAX_BYTES or any(byte < 32 and byte not in (9,10,13) for byte in data):
        raise ValueError('Report must be bounded UTF-8 text')
    data.decode('utf-8', errors='strict')
    return data


def report_signature(path: Path, root: Path) -> str:
    try:
        return hashlib.sha256(report_bytes(path, root)).hexdigest()
    except (OSError, ValueError):
        return 'no-valid-report'


def endpoint(r, task_id, key):
    return f'{r.CORE}/api/pipeline/tasks/{task_id}/reports/{key}'


def immutable_json(r, path, value):
    if path.exists():
        if json.loads(path.read_text()) != value:
            raise ValueError('Original report intent must be reconciled unchanged')
    else:
        r.coding_dispatch_control.atomic_json(path, value)


def publish(r, task_id, key):
    intent = json.loads((r.RECEIPTS/f'{key}.report-intent.json').read_text())
    if intent['requestId'] != key or intent['pipelineId'] != task_id:
        raise ValueError('Report intent belongs to another task or request')
    with (r.RECEIPTS/f'{key}.report.md').open('rb') as stream:
        data = stream.read(MAX_BYTES+1)
    if len(data) != intent['size'] or hashlib.sha256(data).hexdigest() != intent['sha256']:
        raise ValueError('Original frozen report bytes changed')
    result = r.request(endpoint(r,task_id,key)+'/result', {'sha256':intent['sha256'],
        'dataUrl':'data:text/markdown;base64,'+base64.b64encode(data).decode('ascii')})['data']
    if result.get('superseded'):
        value = result.get('outcome',{})
        if value.get('requestId')!=key or value.get('claimSeq')!=intent['claimSeq'] or value.get('sha256')!=intent['sha256']:
            raise ValueError('Original report scope removal is unverified')
        immutable_json(r,r.RECEIPTS/f'{key}.report-result.json',result)
        return result
    receipt = result['receipt']; outcome = result['outcome']
    if (not result.get('reportReadyForReview') or receipt.get('pipelineId')!=task_id or receipt.get('sha256')!=intent['sha256']
        or receipt.get('size')!=len(data) or receipt.get('availability',{}).get('status')!='available'
        or outcome.get('requestId')!=key or outcome.get('claimSeq')!=intent['claimSeq']
        or outcome.get('sourceCommit')!=intent['sourceCommit']):
        raise ValueError('Core did not confirm the original report claim and bytes')
    verified = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/deliverables/{receipt["id"]}')['data']['receipt']
    if verified.get('sha256')!=intent['sha256'] or verified.get('pipelineId')!=task_id or verified.get('availability',{}).get('hashVerified') is not True:
        raise ValueError('Core report bytes are unverified')
    immutable_json(r,r.RECEIPTS/f'{key}.report-result.json',{'requestId':key,'pipelineId':task_id,'outcome':outcome,'deliverableId':receipt['id'],'sha256':intent['sha256']})
    return result


def freeze_partial(r, task_id, key, report_name):
    """Freeze only this execution's saved file; later reconciliation replays it unchanged."""
    root = r.WORKSPACES / f'.home-task-{task_id}' / 'deliverables' / key
    try:
        data = report_bytes(root / report_name, root)
    except (OSError, ValueError):
        return None
    frozen = r.RECEIPTS / f'{key}.report-partial.md'
    if frozen.exists():
        if frozen.read_bytes() != data:
            raise ValueError('Original frozen partial report bytes changed')
    else:
        with frozen.open('xb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
    return {'sha256': hashlib.sha256(data).hexdigest(),
            'dataUrl': 'data:text/markdown;base64,' + base64.b64encode(data).decode('ascii')}


def stop_body(r, task_id, key, report_name, worker_outcome):
    path = r.RECEIPTS / f'{key}.report-stop.json'
    if path.exists():
        return json.loads(path.read_text())
    body = {'workerOutcome': worker_outcome}
    partial = freeze_partial(r, task_id, key, report_name)
    if partial:
        body['partial'] = partial
    immutable_json(r, path, body)
    return body


def verify_stop(response, body, key):
    outcome = response.get('outcome', {})
    if not response.get('blocked') or outcome.get('requestId') != key:
        raise ValueError('Original report stop is unverified')
    if body.get('partial') and not response.get('superseded'):
        archived = outcome.get('partial', {})
        if archived.get('sha256') != body['partial']['sha256'] or not archived.get('deliverableId'):
            raise ValueError('Core did not verify the original partial report')


def stop(r, args, progress, reason):
    status = r.request(endpoint(r,args.task_id,args.request_id))['data']
    if not status.get('terminationVerified') or not getattr(progress,'report_drained',True):
        progress.stop_reason='model_termination_unverified';progress.write()
        return 2
    body = stop_body(r, args.task_id, args.request_id, args.report_name,
        {'schema':'agentx.pipeline-worker-outcome/v1','requestId':args.request_id,'pipelineId':args.task_id,
         'claimSeq':progress.task_claim_seq,'result':'blocked','reason':stop_reason(reason),'source':'worker_report',
         'startedAt':progress.started_at,'finishedAt':r.coding_progress.utc_now(),
         'usage':{name:progress.usage()[name] for name in ('workSeconds','modelCalls')}})
    response=r.request(endpoint(r,args.task_id,args.request_id)+'/stop-result',body)['data']
    verify_stop(response, body, args.request_id)
    progress.core_recorded=True
    progress.finish('blocked','authorization_removed' if response.get('superseded') else reason,progress.checkpoint)
    return 1


def failure(r,args,progress,error):
    if (r.RECEIPTS/f'{args.request_id}.report-intent.json').exists() or getattr(progress,'report_started',False):
        progress.stop_reason = progress.stop_reason or 'runner_error'
        progress.write()
        print(f'Report runner requires reconciliation ({type(error).__name__})', file=sys.stderr)
        return 2
    progress.preflight=True
    if getattr(progress,'task_claim_seq',None) and getattr(progress,'report_spec_sha256',None):
        try:
            r.request(f'{r.CORE}/api/pipeline/tasks/{args.task_id}/feedback',{'by':r.WORKER,'status':'blocked',
                'text':'Report preparation failed before model dispatch; no report or publication was attempted.',
                'manualReportClaim':{'claimSeq':progress.task_claim_seq,'specSha256':progress.report_spec_sha256}})
        except (OSError,RuntimeError):
            pass  # A new owner must remain untouched.
    progress.finish('blocked','runner_error',progress.checkpoint)
    return 1


def restore_checkpoint(r, args, path, baseline):
    if not getattr(args, 'parent_request_id', None):
        return
    saved = r.request(endpoint(r, args.task_id, args.request_id) + '/checkpoint')['data']
    prefix = 'data:text/markdown;base64,'
    if (saved.get('requestId') != args.request_id or saved.get('parentRequestId') != args.parent_request_id
            or saved.get('sha256') != args.parent_sha256 or saved.get('sourceCommit') != baseline
            or not isinstance(saved.get('dataUrl'), str) or not saved['dataUrl'].startswith(prefix)):
        raise ValueError('Core checkpoint identity or source changed')
    data = base64.b64decode(saved['dataUrl'][len(prefix):], validate=True)
    if not 0 < len(data) <= MAX_BYTES or hashlib.sha256(data).hexdigest() != args.parent_sha256:
        raise ValueError('Core checkpoint bytes changed')
    with path.open('xb') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    report_bytes(path, path.parent)


def execute(r,args,progress,task,workspace):
    if not r.coding_dispatch_control.report_name(args.report_name) or not r.coding_progress.REQUEST_ID.fullmatch(args.request_id):
        raise ValueError('Report needs its exact request and plain Markdown name')
    progress.report_mode=True;progress.preflight=True
    progress.report_model_call_limit=r.coding_progress.report_call_limit(getattr(args,'model_call_limit',None))
    progress.report_spec_sha256=hashlib.sha256(str(task.get('spec','')).encode()).hexdigest()
    home=r.worker_home(workspace)
    if home.is_symlink() or (home/'deliverables').is_symlink():
        raise ValueError('Report output must remain inside its private home')
    (home/'deliverables').mkdir(mode=0o700,exist_ok=True)
    root=home/'deliverables'/args.request_id
    if root.exists() or root.is_symlink():
        raise ValueError('Inspect the original report output instead of replacing it')
    root.mkdir(mode=0o700)
    path=root/args.report_name
    baseline=r.git(workspace,'rev-parse','HEAD')
    if r.git(workspace,'status','--porcelain'):
        raise ValueError('Report source must be a clean snapshot')
    source=r.coding_progress.source_state(workspace);progress.checkpoint=baseline
    progress.report_observer=lambda:report_signature(path,root)
    intent={'claimSeq':progress.task_claim_seq,'specSha256':progress.report_spec_sha256,'sourceCommit':baseline,
            'reportName':args.report_name,'model':r.MODEL,'hardRemainingSeconds':max(1,int(progress.hard_deadline-progress.now())),
            'modelCallLimit':progress.call_limit(), 'parentRequestId':getattr(args,'parent_request_id',None),
            'parentSha256':getattr(args,'parent_sha256',None)}
    started=r.request(endpoint(r,args.task_id,args.request_id)+'/start',intent)['data']
    if started.get('requestId')!=args.request_id or started.get('claimSeq')!=progress.task_claim_seq:
        raise ValueError('Core did not acknowledge the original report claim')
    progress.report_started=True
    if started.get('modelCallLimit',r.coding_progress.MANUAL_MODEL_CALL_LIMIT)!=progress.call_limit():
        return stop(r,args,progress,'runner_error')
    if getattr(args,'parent_request_id',None):
        if started.get('parentRequestId') != args.parent_request_id or started.get('parentSha256') != args.parent_sha256:
            return stop(r,args,progress,'runner_error')
        restore_checkpoint(r,args,path,baseline)
    progress.heartbeat=lambda:r.request(endpoint(r,args.task_id,args.request_id)+'/heartbeat',{})
    progress.relay_headers={'x-agentx-report-request':args.request_id,'x-agentx-report-task':args.task_id}
    discussion='\n\n'.join(f"{row.get('by','someone')}: {row.get('text','')}" for row in task.get('feedback',[]))
    output=f'/home/agent/deliverables/{args.request_id}/{args.report_name}'
    prompt=(f'You are the documentation reviewer for task {args.task_id}: {task.get("title","")}\n'
            f'Your working directory is the private report output directory. Read /workspace/AGENTS.md explicitly. '
            f'/workspace is the read-only source snapshot at {baseline}; use absolute source paths or git -C /workspace. '
            'Do not edit, commit, push or deploy source. '
            f'Save the requested Markdown report only at {output}, outside Git. '
            'Paths and budgets in earlier ticket discussion describe previous executions; the current runner output path and budget above govern this execution. '
            'Save first verified findings early, '
            'then extend and save the report as you inspect remaining documents. State reviewed and pending scope honestly. '
            'For documentation audits, inventory the requested files once and review small related document groups, '
            'batching relevant source reads. Before opening the next group, save and read back the findings and a '
            'per-file coverage table with pending, partial or reviewed status and concrete source evidence. '
            'Recompute every summary count from that table at each save; record the next group and unresolved checks. '
            'Merge duplicate findings. If a targeted check remains unresolved, record the uncertainty rather than '
            'repeating the same search without new evidence. Resume a supplied checkpoint instead of rebuilding '
            'completed work; revalidate affected claims when its source revision differs. '
            'If saving fails, report the exact error and stop. '
            'Do not claim complete coverage before checking it. No network exists except the existing model relay. '
            'Do not run live models, benchmarks or GPU jobs. Keep private data, secrets and runtime logs out of the report. '
            f'Remaining soft budget: {max(0,int(progress.soft_deadline-progress.now()))} seconds; '
            f'hard ceiling: {max(0,int(progress.hard_deadline-progress.now()))} seconds. '
            f'Core also enforces {progress.call_limit()} model requests for this execution. '
            'Each request consumes that budget; finish before exhaustion, with pending scope explicit if necessary. '
            'Reserve enough calls to save, verify and summarize the report. When few calls remain, start no new group; '
            'finish with an honest partial checkpoint and next group. Partial delivery does not complete the full task '
            'or authorize another execution. '
            'Saved report changes count as progress; the hard ceiling never moves. End with coverage and validation. '
            'The harness stores the report in Core task deliverables for independent review.\n\n'
            f'Prior checkpoint: {getattr(args, "parent_request_id", None) or "none"}. '
            'If a checkpoint was supplied, the current output file already contains its exact saved bytes. Read it first and extend it; preserve verified findings and pending coverage.\n\n'
            f'Requested result:\n{task.get("spec","")}\n\nDiscussion:\n{discussion}')
    progress.phase='running';progress.preflight=False
    if progress.check_stop():return stop(r,args,progress,'operator_stop')
    run=r.run_worker(workspace,prompt,max(1,int(progress.hard_deadline-progress.now())),progress,read_only=True)
    progress.check_stop();progress.phase='delivering';progress.set_stage('checkpoint')
    status=r.request(endpoint(r,args.task_id,args.request_id))['data']
    if not status.get('terminationVerified') or not getattr(progress,'report_drained',True):
        progress.stop_reason='model_termination_unverified';progress.write();return 2
    if run.returncode or progress.stop_reason:return stop(r,args,progress,progress.stop_reason or 'worker_exit')
    if not status.get('allCallsCompleted'):return stop(r,args,progress,'worker_exit')
    if r.git(workspace,'rev-parse','HEAD')!=baseline or r.coding_progress.source_state(workspace)!=source or r.git(workspace,'status','--porcelain'):
        return stop(r,args,progress,'runner_error')
    try:data=report_bytes(path,root)
    except (OSError,ValueError):return stop(r,args,progress,'runner_error')
    frozen=r.RECEIPTS/f'{args.request_id}.report.md'
    with frozen.open('xb') as stream:
        os.fchmod(stream.fileno(),0o600);stream.write(data);stream.flush();os.fsync(stream.fileno())
    publish_intent={'requestId':args.request_id,'pipelineId':args.task_id,'claimSeq':progress.task_claim_seq,
        'sourceCommit':baseline,'specSha256':progress.report_spec_sha256,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()}
    if not r.begin_publication(progress,lambda:immutable_json(r,r.RECEIPTS/f'{args.request_id}.report-intent.json',publish_intent)):
        return stop(r,args,progress,'operator_stop')
    result=publish(r,args.task_id,args.request_id)
    if result.get('superseded'):
        progress.core_recorded=True;progress.finish('blocked','authorization_removed',baseline);return 1
    progress.core_recorded=True;progress.finish('review',checkpoint=baseline)
    print(json.dumps({'reportReadyForReview':True,'deliverableRef':result['receipt']['ref'],'sourceUnchanged':True}))
    return 0


def reconcile(r,task_id,key):
    control=r.coding_dispatch_control
    if control.unit_active():raise ValueError('Wait for the original native report worker to terminate')
    path=r.RECEIPTS/f'{key}.progress.json';progress=json.loads(path.read_text())
    status=r.request(endpoint(r,task_id,key)+'/reconcile-models',{})['data']
    if not status.get('terminationVerified'):raise ValueError('Original native inference remains unverified')
    if (r.RECEIPTS/f'{key}.report-intent.json').exists():
        delivered=publish(r,task_id,key)
        result='blocked' if delivered.get('superseded') else 'review';reason='authorization_removed' if delivered.get('superseded') else None
    else:
        original = control.read_receipt(key)
        if not original or original.get('pipelineId') != task_id or not control.report_name(original.get('reportName')):
            raise ValueError('Original report selection is unverified')
        body = stop_body(r, task_id, key, original['reportName'],
            {'schema':'agentx.pipeline-worker-outcome/v1','requestId':key,'pipelineId':task_id,
             'claimSeq':status['claimSeq'],'result':'blocked','reason':stop_reason(progress.get('stopReason')),
             'source':'worker_report','startedAt':progress['startedAt'],'finishedAt':r.coding_progress.utc_now(),
             'usage':{name:progress['usage'][name] for name in ('workSeconds','modelCalls')}})
        response=r.request(endpoint(r,task_id,key)+'/stop-result',body)['data']
        verify_stop(response, body, key)
        result='blocked';reason='authorization_removed' if response.get('superseded') else body['workerOutcome']['reason']
    progress.update(phase='finished',result=result,stopReason=reason,coreRecorded=True)
    control.atomic_json(path,progress)
    return {'reconciled':True,'pipelineId':task_id,'requestId':key,'result':result}
