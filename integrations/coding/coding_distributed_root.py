"""Durable root coordination for one Core-owned distributed code-step DAG."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import time

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


coding_code_steps = load('coding_code_steps')
coding_distributed_assembly = load('coding_distributed_assembly')
DISTRIBUTED_UNAVAILABLE = frozenset({'CODE_STEP_DAG_UNAVAILABLE', 'CODING_DISTRIBUTION_UNAVAILABLE'})
BUDGET_KEYS = ('workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls')


class DistributedDagPending(RuntimeError):
    """An accepted or outcome-unknown DAG must be resumed, never replaced locally."""


class RootAssemblyAdapter(coding_distributed_assembly.RunnerAssemblyAdapter):
    """Keep distributed assembly on the established one-PR task branch."""

    def prepare(self, manifest):
        self.workspace_module = self._module('coding_step_workspace')
        self.assembly_module = self._module('coding_step_assembly')
        target = self.r.WORKSPACES / f'graph-{self.args.graph_id}' / 'assembly'
        branch = f'agentx/coding-task-{self.args.task_id}'
        if target.exists():
            if (self.r.git(target, 'branch', '--show-current') != branch
                    or self.r.git(target, 'status', '--porcelain', '--untracked-files=normal')):
                raise coding_distributed_assembly.DistributedAssemblyError(
                    'existing root assembly worktree cannot be reconciled')
            try:
                self.r.git(target, 'merge-base', '--is-ancestor', manifest['baseCommit'], 'HEAD')
            except Exception as error:
                raise coding_distributed_assembly.DistributedAssemblyError(
                    'root assembly worktree does not descend from its exact base') from error
            return target
        self.workspace_module.prepare_worktree(self._repository(), target, manifest['baseCommit'], branch)
        return target


def source_plan(ledger):
    fields = ('id', 'title', 'objective', 'paths', 'testTargets', 'dependsOn')
    return {'schema': coding_code_steps.PLAN_SCHEMA, 'summary': ledger['planSummary'],
            'steps': [{field: row[field] for field in fields} for row in ledger['steps']]}


def replay_or_create_ledger(store, ledger_file, task_id, source_head, plan, plan_fingerprint):
    if not ledger_file.exists():
        return store.create(task_id, source_head, plan)
    ledger = store.load()
    if (ledger['taskId'] != task_id or ledger['sourceCommit'] != source_head
            or ledger['planFingerprint'] != plan_fingerprint(plan)):
        raise ValueError('The existing code-step plan belongs to another source or request')
    return ledger


def _distributed_budget(r, endpoint, progress, root_usage):
    fresh = r.request(endpoint)['data']
    remaining = fresh.get('remaining') if isinstance(fresh, dict) else None
    if (not isinstance(remaining, dict)
            or any(type(remaining.get(field)) is not int or remaining[field] < 0 for field in BUDGET_KEYS)):
        raise DistributedDagPending('Core returned no complete remaining budget for the code-step DAG')
    limits = getattr(progress, 'cumulative_limits', None)
    if (not isinstance(limits, dict)
            or any(type(limits.get(field)) is not int or limits[field] < 0 for field in BUDGET_KEYS)):
        raise DistributedDagPending('The root has no frozen cumulative limits for a code-step DAG')
    local = {field: max(0, limits[field] - root_usage[field]) for field in BUDGET_KEYS}
    return {field: min(remaining[field], local[field]) for field in BUDGET_KEYS}


def _read_intent(path, task_id, root_request_id, source_head, plan):
    try:
        if path.is_symlink() or path.stat().st_size > 128 * 1024:
            raise DistributedDagPending('Distributed plan intent is invalid')
        value = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError) as error:
        raise DistributedDagPending('Distributed plan intent is unreadable') from error
    budget = value.get('budget') if isinstance(value, dict) else None
    root_usage = value.get('rootUsageBeforeDag') if isinstance(value, dict) else None
    if (not isinstance(value, dict) or value.get('schema') != 'agentx.distributed-code-plan-intent/v1'
            or value.get('taskId') != task_id or value.get('rootRequestId') != root_request_id
            or value.get('sourceCommit') != source_head or value.get('plan') != plan
            or not isinstance(budget, dict) or any(type(budget.get(field)) is not int
                   or budget[field] < 0 for field in BUDGET_KEYS)
            or not isinstance(root_usage, dict) or any(type(root_usage.get(field)) is not int
                   or root_usage[field] < 0 for field in BUDGET_KEYS)
            or value.get('assemblyRequestId') is not None
               and not isinstance(value.get('assemblyRequestId'), str)):
        raise DistributedDagPending('Distributed plan intent differs from the frozen root plan')
    return value


def _intent(r, args, progress, endpoint, ledger):
    path = progress.path.parent / f'{args.request_id}.distributed-plan.json'
    plan = source_plan(ledger)
    existing = _read_intent(path, args.task_id, args.request_id, ledger['sourceCommit'], plan)
    if existing:
        return path, existing
    measured = progress.usage()
    if any(type(measured.get(field)) is not int or measured[field] < 0 for field in BUDGET_KEYS):
        raise DistributedDagPending('The root planner usage snapshot is incomplete')
    root_usage = {field: measured[field] for field in BUDGET_KEYS}
    intent = {'schema': 'agentx.distributed-code-plan-intent/v1', 'taskId': args.task_id,
              'rootRequestId': args.request_id, 'sourceCommit': ledger['sourceCommit'],
              'plan': plan, 'budget': _distributed_budget(r, endpoint, progress, root_usage),
              'rootUsageBeforeDag': root_usage, 'assemblyRequestId': None}
    r.coding_dispatch_control.atomic_json(path, intent)
    return path, intent


def _graph_spent(graph):
    budget = graph.get('budget') if isinstance(graph, dict) else None
    spent = budget.get('spent') if isinstance(budget, dict) else None
    usage = {field: spent.get(field, 0) if isinstance(spent, dict) else 0 for field in BUDGET_KEYS}
    if any(type(value) is not int or value < 0 for value in usage.values()):
        raise DistributedDagPending('Core returned invalid aggregate DAG usage')
    return usage


def _apply_usage(progress, root_usage, graph=None):
    dag_usage = _graph_spent(graph)
    progress.distributed_usage = {
        field: root_usage[field] + dag_usage[field] for field in BUDGET_KEYS}
    progress.usage = lambda: dict(progress.distributed_usage)
    return progress.distributed_usage


def _assembly_timeout(progress, manifest):
    budget = manifest.get('finalVerificationBudget') if isinstance(manifest, dict) else None
    if (not isinstance(budget, dict) or set(budget) != {'workSeconds', 'testSeconds'}
            or any(type(budget.get(field)) is not int or budget[field] < 0
                   for field in ('workSeconds', 'testSeconds'))):
        raise DistributedDagPending('Final assembly awaits its exact aggregate verification budget')
    remaining = min(budget['workSeconds'], budget['testSeconds'])
    root_seconds = int(min(progress.hard_deadline, progress.queue_deadline) - progress.now())
    return max(0, min(remaining, root_seconds))


def _completion(r, graph_id, assembly_request_id):
    path = r.RECEIPTS / f'{assembly_request_id}.distributed-assembly.json'
    try:
        if path.is_symlink() or path.stat().st_size > 256 * 1024:
            return None
        value = json.loads(path.read_text(encoding='utf-8'))
    except (FileNotFoundError, OSError, ValueError, TypeError):
        return None
    identity = value.get('identity') if isinstance(value, dict) else None
    completion = value.get('completion') if isinstance(value, dict) and value.get('state') == 'terminal' else None
    publication = completion.get('publication') if isinstance(completion, dict) else None
    if (not isinstance(identity, dict) or identity.get('graphId') != graph_id
            or identity.get('requestId') != assembly_request_id or not isinstance(publication, dict)):
        return None
    head, url = completion.get('headCommit'), publication.get('url')
    if (not isinstance(head, str) or len(head) != 40 or not isinstance(url, str)
            or not url.startswith('https://github.com/') or not url.rsplit('/', 1)[-1].isdigit()):
        return None
    return completion


def _terminal_failure(manifest):
    failure = manifest.get('terminalFailure') if isinstance(manifest, dict) else None
    graph = manifest.get('codeStepGraph') if isinstance(manifest, dict) else None
    state = graph.get('state') if isinstance(graph, dict) else None
    if failure or state in {'failed', 'blocked', 'stopped'}:
        if isinstance(failure, dict):
            return {field: failure.get(field) for field in ('code', 'stepId', 'reason') if failure.get(field)}
        return {'reason': str(failure or state)[:500]}
    return None


def publication(r, task_id, completion):
    url, head = completion['publication']['url'], completion['headCommit']
    return {'repository': r.REPOSITORY, 'number': int(url.rsplit('/', 1)[-1]),
            'branch': f'agentx/coding-task-{task_id}', 'base': r.BASE_BRANCH,
            'head': head, 'url': url}


def attach_graph_evidence(progress, evidence):
    graph = getattr(progress, 'code_step_graph', None)
    if isinstance(graph, dict):
        evidence['codeStepGraph'] = graph


def deliver_native(r, progress, task_id, key, lease, result, verification, reason, summary, verdict_factory):
    """Persist and idempotently replay the one root feedback request."""
    progress.phase = 'delivering'
    path = progress.path.parent / f'{key}.verdict.json'
    if path.exists():
        try:
            body = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError, TypeError) as error:
            raise RuntimeError('The durable native verdict is unreadable') from error
    else:
        current = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/worker?agent={r.WORKER}')['data']['task']
        body = verdict_factory(r, task_id, key, lease, current, progress, result, verification, reason)
        body['text'] = f'Autonomous request {key}: {result}; {progress.pr["url"] if progress.pr else reason}.\n\n{summary}'
        r.coding_dispatch_control.atomic_json(path, body)
    progress.write()
    r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/feedback', body)
    progress.core_recorded = True
    progress.finish(result, reason, progress.checkpoint)
    return 0 if result == 'review' else 1


def finalize(r, args, progress, lease, distributed, verdict_factory):
    progress.code_step_graph = distributed.get('graph')
    if distributed.get('failure'):
        summary = ('Core-owned distributed code-step graph reached a terminal failure: '
                   + json.dumps(distributed['failure'], sort_keys=True))
        return deliver_native(r, progress, args.task_id, args.request_id, lease,
                              'blocked', 'failed', 'code_step_dag_failed', summary, verdict_factory)
    completion = distributed['completion']
    progress.checkpoint = completion['headCommit']
    progress.pr = publication(r, args.task_id, completion)
    current = r.request(f'{r.CORE}/api/pipeline/tasks/{args.task_id}/worker?agent={r.WORKER}')['data']['task']
    native_run = current['codingAutonomy']['runs'][-1]
    if (native_run['requestId'] != args.request_id or native_run.get('pendingInferences')
            or not native_run.get('modelReceipts')
            or any(item['state'] != 'completed' for item in native_run['modelReceipts'])):
        raise DistributedDagPending('Native root model termination requires reconciliation')
    summary = (f'Distributed code-step graph {args.request_id} completed; '
               f'assembly {distributed["assemblyRequestId"]} published one verified PR.')
    return deliver_native(r, progress, args.task_id, args.request_id, lease,
                          'review', 'passed', None, summary, verdict_factory)


def execute(r, args, progress, endpoint, task, ledger):
    """Submit once, then drive only the Core-owned graph until terminal."""
    intent_path, intent = _intent(r, args, progress, endpoint, ledger)
    body = {field: intent[field] for field in ('sourceCommit', 'plan', 'budget')}
    plan_endpoint = endpoint.rsplit('/manifest', 1)[0] + '/code-step-plan'
    try:
        response = r.request(plan_endpoint, body)['data']
    except Exception as error:
        if getattr(error, 'code', None) in DISTRIBUTED_UNAVAILABLE:
            return None
        raise DistributedDagPending('Code-step DAG submission outcome requires reconciliation') from error
    if (not isinstance(response, dict) or response.get('graphId') != args.request_id
            or not isinstance(response.get('assemblyRequestId'), str)
            or not r.coding_progress.REQUEST_ID.fullmatch(response['assemblyRequestId'])):
        raise DistributedDagPending('Core accepted no complete deterministic assembly identity')
    assembly_request_id = response['assemblyRequestId']
    if intent['assemblyRequestId'] not in (None, assembly_request_id):
        raise DistributedDagPending('Core replay returned another assembly identity')
    if intent['assemblyRequestId'] is None:
        intent = {**intent, 'assemblyRequestId': assembly_request_id}
        r.coding_dispatch_control.atomic_json(intent_path, intent)
    _apply_usage(progress, intent['rootUsageBeforeDag'], response.get('codeStepGraph'))
    coordinator = ((task.get('codingAutonomy') or {}).get('runs') or [{}])[-1].get('executorId') or 'coordinator'
    if not hasattr(r, 'distributed_assembly_adapter'):
        r.distributed_assembly_adapter = RootAssemblyAdapter
    assembly_endpoint = (f'{r.CORE}/api/pipeline/coding-autonomy/tasks/{args.task_id}'
                         f'/runs/{assembly_request_id}/manifest')
    try:
        while True:
            if progress.tick(r.worker_home(r.WORKSPACES / f'task-{args.task_id}'),
                             r.WORKSPACES / f'task-{args.task_id}'):
                raise DistributedDagPending('Root coordinator stopped with its child graph preserved')
            raw = r.request(assembly_endpoint)['data']
            if not isinstance(raw, dict) or not isinstance(raw.get('manifestFingerprint'), str):
                raise DistributedDagPending('Core returned no complete assembly manifest')
            terminal = _terminal_failure(raw)
            if terminal:
                graph = raw.get('codeStepGraph') or response.get('codeStepGraph')
                _apply_usage(progress, intent['rootUsageBeforeDag'], graph)
                return {'failure': terminal, 'assemblyRequestId': assembly_request_id,
                        'graph': graph, 'rootUsageBeforeDag': intent['rootUsageBeforeDag']}
            timeout = (_assembly_timeout(progress, raw)
                       if raw.get('finalReady') is True else max(1, int(progress.test_remaining())))
            assembly_args = type('AssemblyArgs', (), {
                'task_id': args.task_id, 'request_id': assembly_request_id,
                'graph_id': args.request_id, 'executor_id': coordinator,
                'manifest_fingerprint': raw['manifestFingerprint'], 'timeout_seconds': timeout})()
            coding_distributed_assembly.execute(r, assembly_args, progress, manifest=raw)
            completion = _completion(r, args.request_id, assembly_request_id)
            if completion:
                replay = r.request(plan_endpoint, body)['data']
                if (not isinstance(replay, dict) or replay.get('graphId') != args.request_id
                        or replay.get('assemblyRequestId') != assembly_request_id):
                    raise DistributedDagPending('Completed graph replay changed its frozen identity')
                graph = replay.get('codeStepGraph') or response.get('codeStepGraph')
                _apply_usage(progress, intent['rootUsageBeforeDag'], graph)
                return {'completion': completion, 'assemblyRequestId': assembly_request_id,
                        'graph': graph, 'rootUsageBeforeDag': intent['rootUsageBeforeDag']}
            if progress.check_stop():
                raise DistributedDagPending('Root coordinator stopped with its child graph preserved')
            time.sleep(2)
    except DistributedDagPending:
        raise
    except Exception as error:
        raise DistributedDagPending('Accepted code-step DAG requires exact root recovery') from error
