"""Close only an exactly published Core DAG, without restarting any executor."""
import json
from types import SimpleNamespace


def settled_calls(task, key):
    """Aggregate native calls with their owners; never invent planner calls."""
    # Core admits each child inference against its parent's local coding
    # capacity. Preserve that exact model and its native settlement proof.
    run = task['codingAutonomy']['runs'][-1]
    dag = task.get('codeStepDag') or {}
    lease = task.get('automationLease') or {}
    capacity = task.get('codingCapacity') or {}
    completion = (dag.get('assembly') or {}).get('completion') or {}
    publication = completion.get('publication') or {}
    steps = dag.get('steps') or []
    if (run.get('requestId') != key or lease.get('dispatchRequestId') != key
            or capacity.get('requestId') != key or dag.get('rootRequestId') != key
            or dag.get('state') != 'published' or dag.get('terminalFailure')
            or dag.get('sourceCommit') != run.get('sourceCommit')
            or (dag.get('authority') or {}).get('taskBasis') != task['codingAutonomy'].get('basis')
            or publication.get('state') != 'published'
            or completion.get('headCommit') != publication.get('headCommit')
            or not completion.get('tests')
            or any(t.get('outcome') != 'passed' for t in completion['tests'])
            or not steps or any(s.get('state') != 'verified' for s in steps)
            or sorted(s['id'] for s in steps) != sorted(
                a['stepId'] for a in dag['assembly'].get('adoptions', []))):
        raise ValueError('The original native DAG is not fully published and verified')
    calls, seen = [], set()
    owners = [(key, run, False)] + [(a['requestId'], a, True)
        for step in steps for a in step.get('attempts', [])]
    for owner, attempt, child in owners:
        receipts = attempt.get('modelReceipts', [] if not child else None)
        if attempt.get('pendingInferences') or not isinstance(receipts, list):
            raise ValueError('Original native inference remains unresolved')
        for call in receipts:
            call_id, state = call.get('callId'), call.get('state')
            settlement = call.get('settlement') or {}
            settled = settlement.get('outcome' if child else 'state')
            if (not call_id or call_id in seen or state not in {'completed', 'failed'}
                    or settled != state or not call.get('finishedAt')
                    or settlement.get('finishedAt') != call['finishedAt']
                    or child and call.get('model') != capacity.get('model')):
                raise ValueError('Native call identity, model or settlement is unverified')
            seen.add(call_id)
            if state == 'completed':
                calls.append({**call, 'ownerRequestId': owner})
    if not calls or not isinstance(capacity.get('model'), str) or not capacity['model']:
        raise ValueError('No completed native local inference proves this delivery')
    return calls


def _read(path, limit=256 * 1024):
    if path.is_symlink() or not 0 < path.stat().st_size <= limit:
        raise ValueError('The original completion journal is invalid')
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError('The original completion journal is invalid')
    return value


def _same_plan(original, normalized):
    if (original.get('schema') != normalized.get('sourceSchema')
            or original.get('summary', '').strip() != normalized.get('summary')):
        return False
    def steps(plan):
        return [{**{k: s[k].strip() for k in ('id', 'title', 'objective')},
                 **{k: sorted(s[k]) for k in ('paths', 'testTargets', 'dependsOn')}}
                for s in plan['steps']]
    return steps(original) == steps(normalized)


def recover(r, task_id, key):
    """Journal a verdict from matching local and Core terminal publications."""
    control = r.coding_dispatch_control
    if control.unit_active():
        raise ValueError('Wait for the original root controller to terminate')
    intent = _read(r.RECEIPTS / f'{key}.distributed-plan.json')
    progress_path = r.RECEIPTS / f'{key}.progress.json'
    progress = _read(progress_path, 65536)
    task = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/worker?agent={r.WORKER}')['data']['task']
    settled_calls(task, key)
    dag, lease = task['codeStepDag'], task['automationLease']
    assembly_id = intent.get('assemblyRequestId')
    usage_before = intent.get('rootUsageBeforeDag')
    fields = {'workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls'}
    if (intent.get('schema') != 'agentx.distributed-code-plan-intent/v1'
            or intent.get('taskId') != task_id or intent.get('rootRequestId') != key
            or intent.get('sourceCommit') != dag['sourceCommit']
            or not _same_plan(intent.get('plan') or {}, dag['plan'])
            or assembly_id != (dag.get('coordination') or {}).get('assemblyRequestId')
            or not isinstance(usage_before, dict) or set(usage_before) != fields
            or any(type(v) is not int or v < 0 for v in usage_before.values())
            or progress.get('requestId') != key or progress.get('pipelineId') != task_id):
        raise ValueError('The original root intent does not match the published graph')
    assembly = _read(r.RECEIPTS / f'{assembly_id}.distributed-assembly.json')
    identity = assembly.get('identity') or {}
    completion = dag['assembly']['completion']
    if (assembly.get('state') != 'terminal' or identity.get('graphId') != key
            or identity.get('requestId') != assembly_id or identity.get('sourceCommit') != dag['sourceCommit']
            or identity.get('planFingerprint') != dag['planFingerprint']
            or assembly.get('completion') != completion):
        raise ValueError('Original assembly and Core publication receipts disagree')
    status = r.request(f'{r.CORE}/api/pipeline/coding-autonomy')['data']
    graph = next((t.get('codeStepGraph') for t in status['tasks'] if t['pipelineId'] == task_id), None)
    if (not graph or graph.get('graphId') != key or graph.get('state') != 'published'
            or graph.get('planFingerprint') != dag['planFingerprint']
            or ((graph.get('assembly') or {}).get('publication') or {}).get('headCommit') != completion['headCommit']):
        raise ValueError('The canonical published graph projection is unavailable')
    root = r.coding_autonomous.coding_distributed_root
    pr = root.publication(r, task_id, completion)
    if pr['url'] != f"https://github.com/{r.REPOSITORY}/pull/{pr['number']}":
        raise ValueError('Published repository identity changed')
    usage = root._apply_usage(SimpleNamespace(), intent['rootUsageBeforeDag'], graph)
    observed = SimpleNamespace(pr=pr, checkpoint=completion['headCommit'], code_steps=None,
                              code_step_graph=graph, usage=lambda: usage)
    body = r.coding_autonomous.native_verdict(r, task_id, key, lease, task,
                                             observed, 'review', 'passed', None)
    body['text'] = f'Autonomous request {key}: review; {pr["url"]}. Exact published DAG completion reconciled without inference replay.'
    # Neither write declares a Core acknowledgement. Persist metadata first so
    # any retry of the subsequently durable verdict has the same publication.
    progress.update(phase='delivering', result=None, pr=pr, checkpoint=observed.checkpoint,
                    usage=usage, codeStepGraph=graph)
    control.atomic_json(progress_path, progress)
    control.atomic_json(r.RECEIPTS / f'{key}.verdict.json', body)
    return body
