"""Read-only report worker, native inference receipts and private Core delivery."""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
import importlib.util
_scope_spec = importlib.util.spec_from_file_location('coding_report_scope', __import__('pathlib').Path(__file__).with_name('coding_report_scope.py'))
scope = importlib.util.module_from_spec(_scope_spec)
_scope_spec.loader.exec_module(scope)
_ledger_spec = importlib.util.spec_from_file_location('coding_report_ledger', __import__('pathlib').Path(__file__).with_name('coding_report_ledger.py'))
ledgers = importlib.util.module_from_spec(_ledger_spec)
_ledger_spec.loader.exec_module(ledgers)
_steps_spec = importlib.util.spec_from_file_location('coding_report_steps', __import__('pathlib').Path(__file__).with_name('coding_report_steps.py'))
steps = importlib.util.module_from_spec(_steps_spec)
_steps_spec.loader.exec_module(steps)

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
        'dataUrl':'data:text/markdown;base64,'+base64.b64encode(data).decode('ascii'),
        **({'coverage': intent['coverage']} if 'coverage' in intent else {})})['data']
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


def stop_body(r, task_id, key, report_name, worker_outcome, snapshot=None):
    path = r.RECEIPTS / f'{key}.report-stop.json'
    if path.exists():
        return json.loads(path.read_text())
    body = {'workerOutcome': worker_outcome}
    partial = freeze_partial(r, task_id, key, report_name)
    if partial:
        body['partial'] = partial
    root = r.WORKSPACES / f'.home-task-{task_id}' / 'deliverables' / key
    try:
        if not isinstance(snapshot, dict):
            raise ValueError('Core inventory is unavailable; retain pending coverage')
        body['coverage'] = scope.read(report_bytes, r.WORKSPACES / f'task-{task_id}', root, snapshot)
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        pass  # Core retains the frozen inventory with pending coverage, never invented findings.
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


def settled_status(r, args, progress):
    """Read Core's view of this execution's own calls, allowing a short settlement lag.

    A drained relay proves EOF, not Core's receipt; the bounded poll never
    replays or starts a model call."""
    url = endpoint(r, args.task_id, args.request_id)
    status = r.request(url)['data']
    for _ in range(int(getattr(r, 'REPORT_SETTLE_GRACE_SECONDS', 30) // 2)):
        if status.get('terminationVerified') or not getattr(progress, 'report_drained', True):
            break
        time.sleep(2)
        status = r.request(url)['data']
    return status


def stop(r, args, progress, reason):
    status = settled_status(r, args, progress)
    if not status.get('terminationVerified') or not getattr(progress,'report_drained',True):
        progress.stop_reason='model_termination_unverified';progress.write()
        return 2
    body = stop_body(r, args.task_id, args.request_id, args.report_name,
        {'schema':'agentx.pipeline-worker-outcome/v1','requestId':args.request_id,'pipelineId':args.task_id,
         'claimSeq':progress.task_claim_seq,'result':'blocked','reason':stop_reason(reason),'source':'worker_report',
         'startedAt':progress.started_at,'finishedAt':r.coding_progress.utc_now(),
         'usage':{name:progress.usage()[name] for name in ('workSeconds','modelCalls')}}, status.get('inventory'))
    response=r.request(endpoint(r,args.task_id,args.request_id)+'/stop-result',body)['data']
    verify_stop(response, body, args.request_id)
    progress.core_recorded=True
    progress.finish('blocked','authorization_removed' if response.get('superseded') else reason,progress.checkpoint)
    return 1


def refused(r, task_id, key, progress, value):
    if (not value.get('reportRefusalReceived') or value.get('requestId') != key or value.get('pipelineId') != task_id
            or value.get('claimSeq') != progress.task_claim_seq):
        raise ValueError('Original preparation refusal is unverified')
    progress.core_recorded = True
    progress.preflight = True
    progress.finish('blocked', 'runner_error', progress.checkpoint)
    return 1


def failure(r,args,progress,error):
    value = getattr(error, 'data', None) or {}
    if value.get('reportRefusalReceived'):
        return refused(r, args.task_id, args.request_id, progress, value)
    if (r.RECEIPTS/f'{args.request_id}.report-intent.json').exists() or getattr(progress,'report_started',False):
        progress.stop_reason = progress.stop_reason or 'runner_error'
        progress.write()
        print(f'Report runner requires reconciliation ({type(error).__name__})', file=sys.stderr)
        return 2
    progress.preflight=True
    if getattr(progress,'task_claim_seq',None) and getattr(progress,'report_spec_sha256',None):
        body = {'claimSeq': progress.task_claim_seq, 'specSha256': progress.report_spec_sha256,
                'runnerStartedAt': progress.started_at, 'sourceCommit': progress.checkpoint,
                'reportName': args.report_name, 'parentRequestId': getattr(args, 'parent_request_id', None),
                'parentSha256': getattr(args, 'parent_sha256', None)}
        intent = r.RECEIPTS/f'{args.request_id}.report-preflight.json'
        try:
            immutable_json(r, intent, body)
            value = r.request(endpoint(r,args.task_id,args.request_id)+'/preflight-result',body)['data']
            return refused(r, args.task_id, args.request_id, progress, value)
        except (OSError,RuntimeError,ValueError):
            progress.stop_reason = 'runner_error'; progress.write()
            return 2  # The original receipt must be reconciled before another worker.
    progress.finish('blocked','runner_error',progress.checkpoint)
    return 1


def restore_checkpoint(r, args, path, baseline):
    if not getattr(args, 'parent_request_id', None):
        return
    saved = r.request(endpoint(r, args.task_id, args.request_id) + '/checkpoint')['data']
    prefix = 'data:text/markdown;base64,'
    if (saved.get('requestId') == args.request_id and saved.get('parentRequestId') == args.parent_request_id
            and saved.get('sourceCommit') == baseline and args.parent_sha256 is None
            and saved.get('checkpointAvailable') is False and saved.get('dataUrl') is None):
        return saved.get('coverage')
    expected_sha = args.parent_sha256
    if expected_sha is None and saved.get('inherited') is True and r.coding_progress.REQUEST_ID.fullmatch(saved.get('contentRequestId', '')):
        expected_sha = saved.get('sha256')
    if (saved.get('requestId') != args.request_id or saved.get('parentRequestId') != args.parent_request_id
            or saved.get('sha256') != expected_sha or saved.get('sourceCommit') != baseline
            or not isinstance(saved.get('dataUrl'), str) or not saved['dataUrl'].startswith(prefix)):
        raise ValueError('Core checkpoint identity or source changed')
    data = base64.b64decode(saved['dataUrl'][len(prefix):], validate=True)
    if not 0 < len(data) <= MAX_BYTES or hashlib.sha256(data).hexdigest() != expected_sha:
        raise ValueError('Core checkpoint bytes changed')
    with path.open('xb') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    report_bytes(path, path.parent)
    return saved.get('coverage')


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
            'runnerStartedAt':progress.started_at,
            'reportName':args.report_name,'model':r.MODEL,'hardRemainingSeconds':max(1,int(progress.hard_deadline-progress.now())),
            'modelCallLimit':progress.call_limit(), 'parentRequestId':getattr(args,'parent_request_id',None),
            'parentSha256':getattr(args,'parent_sha256',None)}
    intent['inventory'] = scope.inventory(workspace, baseline, (task.get('codingResult') or {}).get('documentPaths'))
    immutable_json(r, r.RECEIPTS / f'{args.request_id}.report-start.json', intent)
    progress.report_started = True
    started=r.request(endpoint(r,args.task_id,args.request_id)+'/start',intent)['data']
    if started.get('requestId')!=args.request_id or started.get('claimSeq')!=progress.task_claim_seq:
        raise ValueError('Core did not acknowledge the original report claim')
    progress.report_started=True
    authority = started.get('authority')
    if not authority or not authority.get('queueEndAt'):
        return stop(r,args,progress,'runner_error')
    import datetime
    remaining = max(0, datetime.datetime.fromisoformat(authority['queueEndAt'].replace('Z', '+00:00')).timestamp() - __import__('time').time())
    progress.queue_deadline = min(progress.queue_deadline, progress.now() + remaining)
    progress.hard_deadline = min(progress.hard_deadline, progress.now() + authority['workSeconds'], progress.queue_deadline)
    snapshot = started['inventory']
    scope.seed(root, snapshot)
    if started.get('modelCallLimit',r.coding_progress.MANUAL_MODEL_CALL_LIMIT)!=progress.call_limit():
        return stop(r,args,progress,'runner_error')
    if getattr(args,'parent_request_id',None):
        if started.get('parentRequestId') != args.parent_request_id or started.get('parentSha256') != args.parent_sha256:
            return stop(r,args,progress,'runner_error')
        previous_coverage = restore_checkpoint(r,args,path,baseline)
        if previous_coverage:
            if previous_coverage.get('inventorySha256') != snapshot['sha256']:
                raise ValueError('Checkpoint coverage belongs to a different source inventory')
            scope.seed(root, snapshot, previous_coverage)
    progress.report_escalation = started.get('escalation') if isinstance(started.get('escalation'), dict) else None
    progress.heartbeat=lambda:r.request(endpoint(r,args.task_id,args.request_id)+'/heartbeat',{})
    progress.relay_headers={'x-agentx-report-request':args.request_id,'x-agentx-report-task':args.task_id}
    discussion='\n\n'.join(f"{row.get('by','someone')}: {row.get('text','')}" for row in task.get('feedback',[]))
    output=f'/home/agent/deliverables/{args.request_id}/{args.report_name}'
    prompt=(f'You are the documentation reviewer for task {args.task_id}: {task.get("title","")}\n'
            f'The exact review inventory is source-inventory.json in your output directory. '
            'Keep coverage.json updated after each group; preserve its inventorySha256, document paths and hashes. '
            'Each document has state pending, partial, blocked or reviewed and an evidence list. '
            'Each reviewed document requires evidence objects with path, sha256 (SHA-256 of that frozen source file), '
            'line (one-based) and check (the concrete claim checked). Verify content against implementation. '
            'These are declared checks, not independent acceptance. Preserve earlier coverage on continuation. '
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
    if os.environ.get('AGENTX_REPORT_MODE', 'steps') == 'steps':
        outcome=run_steps(r,args,progress,task,workspace,root,path,snapshot,baseline)
        progress.check_stop();progress.phase='delivering';progress.set_stage('checkpoint')
        status=settled_status(r,args,progress)
        if outcome=='unverified' or not status.get('terminationVerified') or not getattr(progress,'report_drained',True):
            progress.stop_reason='model_termination_unverified';progress.write();return 2
        if progress.stop_reason:return stop(r,args,progress,progress.stop_reason)
        if outcome!='complete':return stop(r,args,progress,outcome)
    else:
        run=r.run_worker(workspace,prompt,max(1,int(progress.hard_deadline-progress.now())),progress,read_only=True)
        progress.check_stop();progress.phase='delivering';progress.set_stage('checkpoint')
        status=settled_status(r,args,progress)
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
    publish_intent['coverage'] = scope.read(report_bytes, workspace, root, snapshot)
    if not r.begin_publication(progress,lambda:immutable_json(r,r.RECEIPTS/f'{args.request_id}.report-intent.json',publish_intent)):
        return stop(r,args,progress,'operator_stop')
    result=publish(r,args.task_id,args.request_id)
    if result.get('superseded'):
        progress.core_recorded=True;progress.finish('blocked','authorization_removed',baseline);return 1
    progress.core_recorded=True;progress.finish('review',checkpoint=baseline)
    print(json.dumps({'reportReadyForReview':True,'deliverableRef':result['receipt']['ref'],'sourceUnchanged':True}))
    return 0


def lane_capability(r):
    """The coding lane's capability profile (#832), or None: sizing evidence only."""
    try:
        lanes = r.request(f'{r.CORE}/api/nerve-center/agent-runtime-config/export'
                          '?includeCandidates=false&includeCapability=true').get('data', {}).get('lanes', {})
    except (OSError, RuntimeError, ValueError):
        return None
    model = getattr(r, 'MODEL', None)
    for lane in (lanes or {}).values():
        if isinstance(lane, dict) and isinstance(lane.get('capability'), dict) and (model in (None, 'auto') or lane.get('model') == model):
            if model not in (None, 'auto') or lane.get('role') == 'codingSpecialist':
                return lane['capability']
    return None


def initial_ledger(root, path, snapshot, baseline):
    """Resume the ledger embedded in a restored report, or start one from its coverage."""
    restored = path.read_text(encoding='utf-8') if path.is_file() else None
    ledger = ledgers.embedded(restored) if restored else None
    if ledger:
        if ledger.get('inventorySha256') != snapshot['sha256'] or ledger.get('sourceCommit') != baseline:
            raise ValueError('Restored report ledger belongs to another inventory or source')
        return ledger
    coverage = json.loads((root/'coverage.json').read_text(encoding='utf-8')) if (root/'coverage.json').is_file() else None
    return ledgers.new_ledger(snapshot, coverage, ledgers.legacy_narrative(restored) if restored else None)


def escalation_allowed(progress, ledger, group):
    """Escalate a group once, after its first local failure, if this run may (#835)."""
    escalation = getattr(progress, 'report_escalation', None)
    if not escalation or not escalation.get('models'):
        return False
    calls, seconds = steps.remaining(progress)
    return (calls >= 1 + steps.WRITER_CALLS and seconds >= 300
            and all(ledger['documents'][path].get('attempts', 0) == 1 for path in group)
            and not any(row.get('escalated') and set(row.get('documents', [])) == set(group) for row in ledger['steps']))


def escalation_call(r, args, progress, model, messages, step):
    """One escalated request through Core, keeping progress heartbeats alive."""
    import threading, uuid
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError
    body = json.dumps({'model': model, 'messages': messages, 'max_tokens': steps.ESCALATION_MAX_TOKENS,
                       'temperature': 0, 'stream': False}).encode()
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json', 'x-service-caller': 'coding-run',
               'x-agentx-report-request': args.request_id, 'x-agentx-report-task': args.task_id,
               'x-agentx-coding-call': str(uuid.uuid4()), 'x-agentx-report-escalation': str(step)}
    # The gateway door needs the Coding Team's token, as the relay adds it for workers.
    if getattr(r, 'GATEWAY_TOKEN', ''):
        headers['Authorization'] = f'Bearer {r.GATEWAY_TOKEN}'
    timeout = max(60, min(900, steps.remaining(progress)[1] - steps.WRITER_SECONDS))
    outcome = {}

    def send():
        try:
            with urlopen(Request(f'{r.MODEL_URL}/chat/completions', data=body, headers=headers, method='POST'), timeout=timeout) as response:
                outcome['value'] = json.load(response)
        except HTTPError as error:
            outcome['error'] = f'HTTP {error.code}'
        except (OSError, ValueError) as error:
            outcome['error'] = type(error).__name__
    worker = threading.Thread(target=send, daemon=True)
    worker.start()
    while worker.is_alive():
        progress.tick()
        worker.join(2)
    progress.model_calls += 1
    if 'error' in outcome:
        return None, None, f'escalation unavailable ({outcome["error"]})'
    choice = (outcome['value'].get('choices') or [{}])[0]
    return choice.get('message', {}).get('content'), outcome['value'].get('model') or model, None


def escalate_group(r, args, progress, workspace, baseline, ledger, group, line_range, number, sources, source):
    escalation = progress.report_escalation
    files = r.git(workspace, 'ls-tree', '-r', '--name-only', baseline).splitlines()
    doc_texts = {path: sources[path].decode('utf-8', errors='replace') for path in group}
    cited_files = steps.referenced_sources(ledger, group, doc_texts, files)
    if not cited_files:
        # No path cited and no earlier evidence: find the files that define the
        # identifiers the documents name, in the frozen snapshot only.
        hits = {}
        for term in steps.code_terms(doc_texts):
            try:
                found = r.git(workspace, 'grep', '-l', '-F', '-e', term, baseline, '--').splitlines()
            except Exception:
                continue
            for line in found:
                name = line.split(':', 1)[1] if ':' in line else line
                if name not in group:
                    hits[name] = hits.get(name, 0) + 1
        cited_files = sorted(hits, key=lambda name: (-hits[name], name))[:20]
    texts, used = {}, 0
    for cited in cited_files:
        try:
            text = scope.source_bytes(workspace, baseline, cited).decode('utf-8', errors='replace')[:steps.ESCALATION_FILE_CHARS]
        except ValueError:
            continue
        if used + len(text) > steps.ESCALATION_SOURCE_CHARS:
            break
        texts[cited] = text
        used += len(text)
    content, model, reason = escalation_call(r, args, progress, escalation['models'][0],
                                             steps.escalation_prompt(ledger, group, doc_texts, texts, line_range), number)
    value = None
    if content is not None:
        value, reason = steps.parse_json_object(content)
    try:
        if value is None:
            raise ledgers.LedgerError(reason)
        ledgers.merge_step(ledger, group, value, source, number, line_range=line_range)
        ledger['steps'][-1].update(escalated=True, model=model)
        for finding in ledger['findings']:
            if finding['step'] == number:
                finding['escalatedModel'] = model
    except ledgers.LedgerError as error:
        ledgers.record_failure(ledger, group, number, f'cloud escalation: {error}')
        ledger['steps'][-1].update(escalated=True, model=model)


def run_steps(r,args,progress,task,workspace,root,path,snapshot,baseline):
    """Run the report as verified steps. Returns 'complete', 'unverified' or a stop reason."""
    ledger = initial_ledger(root, path, snapshot, baseline)
    ledgers.continuation_retries(ledger, args.request_id, getattr(args, 'parent_request_id', None))
    notes = steps.latest_operator_notes(task)
    capability = lane_capability(r)
    budget = steps.step_budget(capability)
    sources = {name: scope.source_bytes(workspace, baseline, name) for name in ledger['documents']}
    sizes = {name: len(data) for name, data in sources.items()}
    line_counts = {name: len(data.splitlines()) for name, data in sources.items()}
    title = f'{task.get("title") or "Documentation review"} — task {args.task_id}'
    sandbox_root = f'/home/agent/deliverables/{args.request_id}'
    note = (f'Your working directory is the private output directory {sandbox_root}. /workspace is the read-only source '
            f'snapshot at {baseline}; use absolute paths or git -C /workspace. Network is unavailable.')
    immutable_json(r, r.RECEIPTS/f'{args.request_id}.report-steps-plan.json',
                   {'requestId': args.request_id, 'budget': budget,
                    'capabilitySource': (capability or {}).get('provenance') if capability else None})

    def save():
        if notes:
            ledger['legacyReviewPending'] = ledgers.legacy_review_required(ledger, notes)
        groups = steps.plan_groups(ledger, sizes, budget, limit=3, line_counts=line_counts)
        steps.write_atomic(path, ledgers.render(ledger, title, [group['documents'] for group in groups]))
        steps.write_atomic(root/'coverage.json', json.dumps(ledgers.coverage(ledger), indent=2) + '\n')
        progress.report_steps = {'escalated': sum(1 for row in ledger['steps'] if row.get('escalated')),
                                 'done': sum(1 for row in ledger['steps'] if row['result'] == 'merged'),
                                 'failed': sum(1 for row in ledger['steps'] if row['result'] == 'failed'),
                                 'counts': ledgers.counts(ledger), 'findings': len(ledger['findings']),
                                 'stepContext': budget['stepContext'], 'budgetSource': budget['source']}

    def one(number, prompt, calls, seconds):
        name = f'step-{number:02d}.json'
        progress.begin_step(calls, seconds, f'{sandbox_root}/{name}')
        try:
            run = r.run_worker(workspace, prompt, seconds, progress, read_only=True)
        finally:
            progress.end_step()
        if not getattr(progress, 'report_drained', True):
            return None, 'unverified'
        value, reason = steps.read_result(root/name)
        if value is None and run.returncode and not reason:
            reason = 'the worker exited without a result'
        return value, reason

    save()
    number = 0
    source = lambda name: scope.source_bytes(workspace, baseline, name)
    if ledgers.legacy_review_required(ledger, notes):
        number += 1
        value, reason = one(number, steps.legacy_prompt(ledger, f'{sandbox_root}/step-{number:02d}.json', task, note),
                            steps.LEGACY_CALLS, budget['seconds'])
        if reason == 'unverified':
            return 'unverified'
        ledgers.merge_legacy_review(ledger, value, reason, notes, source, number, args.request_id)
        save()
    while True:
        if progress.check_stop() or progress.stop_reason:
            return progress.stop_reason or 'operator_stop'
        groups = steps.plan_groups(ledger, sizes, budget, limit=1, line_counts=line_counts)
        if not groups:
            break
        calls, seconds = steps.remaining(progress)
        if calls < budget['calls'] + steps.WRITER_CALLS:
            save()
            return 'model_call_limit'
        if seconds < min(budget['seconds'], 600) + steps.WRITER_SECONDS:
            save()
            return 'hard_budget'
        number += 1
        group, line_range = groups[0]['documents'], groups[0]['range']
        value, reason = one(number, steps.group_prompt(ledger, group, f'{sandbox_root}/step-{number:02d}.json', task, note, line_range),
                            budget['calls'], min(budget['seconds'], seconds - steps.WRITER_SECONDS))
        if reason == 'unverified':
            return 'unverified'
        try:
            if value is None:
                raise ledgers.LedgerError(reason)
            ledgers.merge_step(ledger, group, value, source, number, line_range=line_range)
        except ledgers.LedgerError as error:
            ledgers.record_failure(ledger, group, number, str(error))
            if escalation_allowed(progress, ledger, group):
                number += 1
                escalate_group(r, args, progress, workspace, baseline, ledger, group, line_range, number, sources, source)
        save()
    calls, seconds = steps.remaining(progress)
    if ledger['findings'] and calls >= steps.WRITER_CALLS and seconds >= steps.WRITER_SECONDS:
        number += 1
        value, reason = one(number, steps.writer_prompt(ledger, f'{sandbox_root}/step-{number:02d}.json'),
                            steps.WRITER_CALLS, steps.WRITER_SECONDS)
        if reason == 'unverified':
            return 'unverified'
        if value is not None:
            steps.apply_writer(ledger, value)
    save()
    return 'worker_exit' if ledger.get('legacyReviewPending') else 'complete'


def reconcile(r,task_id,key):
    control=r.coding_dispatch_control
    if control.unit_active():raise ValueError('Wait for the original native report worker to terminate')
    path=r.RECEIPTS/f'{key}.progress.json';progress=json.loads(path.read_text())
    start_intent = r.RECEIPTS / f'{key}.report-start.json'
    preflight_intent = r.RECEIPTS / f'{key}.report-preflight.json'
    try:
        observed = r.request(endpoint(r, task_id, key))['data']
    except RuntimeError as error:
        if getattr(error, 'code', None) != 'REPORT_NOT_FOUND':
            raise
        if preflight_intent.exists():
            r.request(endpoint(r,task_id,key)+'/preflight-result',json.loads(preflight_intent.read_text()))
        elif start_intent.exists():
            try:
                r.request(endpoint(r,task_id,key)+'/start',json.loads(start_intent.read_text()))
            except RuntimeError as refusal:
                if not (getattr(refusal, 'data', None) or {}).get('reportRefusalReceived'):
                    raise
        else:
            raise
        observed = r.request(endpoint(r,task_id,key))['data']
    if observed.get('preflight') and observed.get('terminationVerified'):
        if observed.get('requestId') != key or observed.get('claimSeq') != json.loads((preflight_intent if preflight_intent.exists() else start_intent).read_text())['claimSeq']:
            raise ValueError('Original preparation receipt is unverified')
        progress.update(phase='finished', result='blocked', stopReason='runner_error', coreRecorded=True, preflight=True)
        control.atomic_json(path, progress)
        return {'reconciled':True,'pipelineId':task_id,'requestId':key,'result':'blocked'}
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
             'usage':{name:progress['usage'][name] for name in ('workSeconds','modelCalls')}}, status.get('inventory'))
        response=r.request(endpoint(r,task_id,key)+'/stop-result',body)['data']
        verify_stop(response, body, key)
        result='blocked';reason='authorization_removed' if response.get('superseded') else body['workerOutcome']['reason']
    progress.update(phase='finished',result=result,stopReason=reason,coreRecorded=True)
    control.atomic_json(path,progress)
    return {'reconciled':True,'pipelineId':task_id,'requestId':key,'result':result}
