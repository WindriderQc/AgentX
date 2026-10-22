"""One bounded, leased attempt. Core selects/resumes; this module never loops."""
from __future__ import annotations
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time

HERE = Path(__file__).resolve().parent
def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
coding_git = load('coding_git')
coding_publication = load('coding_publication')
coding_code_steps = load('coding_code_steps')
coding_code_ledger = load('coding_code_ledger')
coding_verification = load('coding_verification')
coding_step_progress = load('coding_step_progress')
VERIFICATION_COMMANDS = coding_verification.FULL_COMMANDS

PLANNER_CALLS = 8
PLANNER_SECONDS = 5 * 60
STEP_CALLS = 24
STEP_SECONDS = 20 * 60


def _bounded_task(task, manifest):
    """Private model context, bounded independently of task storage."""
    discussion = '\n\n'.join(f"{entry.get('by')}: {entry.get('text')}"
                               for entry in task.get('feedback', [])[-12:])
    return {'pipelineId': str(task.get('pipelineId') or '')[:80],
            'title': str(task.get('title') or '')[:500],
            'spec': str(task.get('spec') or '')[:8_000],
            'discussion': discussion[-4_000:],
            'planning': str((task.get('planningContext') or {}).get('text') or '')[:3_000],
            'correction': manifest.get('correction') if isinstance(manifest.get('correction'), dict) else None}


def _lane_capability(r, model):
    try:
        lanes = r.request(f'{r.CORE}/api/nerve-center/agent-runtime-config/export?includeCapability=true').get('data', {}).get('lanes', {})
    except (OSError, RuntimeError, ValueError, TypeError, AttributeError):
        return None
    return next((lane.get('capability') for lane in lanes.values()
                 if isinstance(lane, dict) and lane.get('model') == model
                 and isinstance(lane.get('capability'), dict)), None)


def _session_budget(progress, remaining_steps):
    calls_left = max(1, progress.call_limit() - progress.model_calls)
    seconds_left = max(1, int(min(progress.hard_deadline, progress.queue_deadline) - progress.now()))
    divisor = max(1, remaining_steps)
    return min(STEP_CALLS, max(1, calls_left // divisor)), min(STEP_SECONDS, max(1, seconds_left // divisor))


def _changed_paths(r, workspace):
    values = []
    for command in (('diff', '--name-only', '-z', 'HEAD'),
                    ('diff', '--cached', '--name-only', '-z'),
                    ('ls-files', '-z', '--others', '--exclude-standard')):
        values.extend(path for path in r.git(workspace, *command).split('\0') if path)
    return sorted(set(values))


def _stash_failed_step(r, workspace, step_id):
    if not _changed_paths(r, workspace):
        return
    r.git(workspace, 'stash', 'push', '--include-untracked', '--message',
          f'Unverified runner-owned {step_id}')
    if _changed_paths(r, workspace):
        raise coding_git.GitRefusal('Failed step source could not be isolated from the assembly branch')


def _commit_step(r, workspace, step, changed):
    parent = r.git(workspace, 'rev-parse', 'HEAD')
    r.git(workspace, 'add', '-A', '--', *changed)
    if not r.git(workspace, 'diff', '--cached', '--name-only'):
        raise coding_git.GitRefusal('The code step produced no committable source change')
    r.git(workspace, *r.AUTHOR, 'commit', '--quiet', '--no-verify', '-m',
          f"Coding step {step['id']}: {step['title']}")
    commit = r.git(workspace, 'rev-parse', 'HEAD')
    if r.git(workspace, 'rev-parse', 'HEAD^') != parent:
        raise coding_git.GitRefusal('The code-step commit does not have the exact prepared parent')
    coding_git.audit(r.git, workspace, parent, r.coding_progress.artifact, step['paths'])
    return commit


def _index_path(progress, task_id):
    return progress.path.parent / f'task-{task_id}.code-step-index.json'


def _read_index(path, task_id):
    try:
        if path.stat().st_size > 4096:
            return None
        value = json.loads(path.read_text())
    except (OSError, ValueError, TypeError):
        return None
    fields = {'schema', 'taskId', 'rootRequestId', 'ledgerFile', 'head', 'planFingerprint'}
    if (not isinstance(value, dict) or set(value) != fields or value.get('schema') != 'agentx.code-step-index/v1'
            or value.get('taskId') != task_id
            or not isinstance(value.get('rootRequestId'), str)
            or value.get('ledgerFile') != f"{value.get('rootRequestId')}.code-steps.json"
            or not isinstance(value.get('head'), str) or not value['head'].isalnum()
            or len(value['head']) not in (40, 64)
            or not isinstance(value.get('planFingerprint'), str) or len(value['planFingerprint']) != 64):
        return None
    return value


def _write_index(r, progress, task_id, root_request_id, ledger, head):
    r.coding_dispatch_control.atomic_json(_index_path(progress, task_id), {
        'schema': 'agentx.code-step-index/v1', 'taskId': task_id,
        'rootRequestId': root_request_id, 'ledgerFile': f'{root_request_id}.code-steps.json',
        'head': head, 'planFingerprint': ledger['planFingerprint']})


def _project(progress, ledger, budget):
    value = coding_code_ledger.progress_projection(ledger, budget['stepContext'], budget['source'])
    progress.code_steps = coding_step_progress.project(value)
    if progress.code_steps is None:
        raise coding_code_ledger.CodeLedgerError('Code-step progress projection is invalid')
    progress.write()


def _prepare_ledger(r, workspace, task_id, key, task, manifest, progress, budget, capability):
    index_file = _index_path(progress, task_id)
    if manifest.get('continuationCheckpoint'):
        index = _read_index(index_file, task_id)
        if not index or index['head'] != manifest['continuationCheckpoint']:
            raise coding_code_ledger.CodeLedgerError('The continuation has no matching runner-owned code-step ledger')
        store = coding_code_ledger.CodeStepLedger(progress.path.parent / index['ledgerFile'])
        ledger = store.load()
        if ledger['taskId'] != task_id or ledger['planFingerprint'] != index['planFingerprint']:
            raise coding_code_ledger.CodeLedgerError('The continuation code-step identity changed')
        return store, ledger, index['rootRequestId']

    root = r.worker_home(workspace) / 'deliverables' / key
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    output = root / 'code-plan.json'
    if not output.exists():
        prompt = coding_code_steps.plan_prompt(_bounded_task(task, manifest), {'paths': manifest['scope']},
                                               f'/home/agent/deliverables/{key}/code-plan.json', budget)
        calls = min(PLANNER_CALLS, max(1, progress.call_limit() - progress.model_calls))
        seconds = min(PLANNER_SECONDS, max(1, int(min(progress.hard_deadline, progress.queue_deadline) - progress.now())))
        progress.begin_step(calls, seconds, f'/home/agent/deliverables/{key}/code-plan.json')
        try:
            run = r.run_worker(workspace, prompt, seconds, progress, model=r.MODEL, read_only=True)
        finally:
            progress.end_step()
        if not getattr(progress, 'role_drained', True):
            raise RuntimeError('Planner model termination is unverified')
        if run.returncode or progress.check_stop():
            raise RuntimeError('The planner stopped before writing a code-step plan')
    if not output.is_file() or output.is_symlink() or output.stat().st_size > coding_code_steps.MAX_PLAN_BYTES:
        raise coding_code_steps.CodePlanError('Planner did not write one bounded regular plan file')
    plan = coding_code_steps.validate_plan(output.read_text(encoding='utf-8'), manifest['scope'], capability)
    ledger_file = progress.path.parent / f'{key}.code-steps.json'
    store = coding_code_ledger.CodeStepLedger(ledger_file)
    ledger = store.create(task_id, r.git(workspace, 'rev-parse', 'HEAD'), plan)
    _write_index(r, progress, task_id, key, ledger, r.git(workspace, 'rev-parse', 'HEAD'))
    return store, ledger, key

def preflight_refusal(progress, error):
    reasons = {'CODING_AUTONOMY_CONFLICT': 'authorization_removed',
               'CODING_AUTONOMY_QUEUE_WAIT': 'queue_window_closed'}
    reason = reasons.get(getattr(error, 'code', None))
    if reason:
        progress.stop_reason = reason
    return bool(reason)

def execute(r, args, progress):
    task_id, key = args.task_id, args.request_id
    if task_id == '0909' or not key:
        raise RuntimeError('Autonomous execution needs an approved exact task and request')
    endpoint = f'{r.CORE}/api/pipeline/coding-autonomy/tasks/{task_id}/runs/{key}/manifest'
    if progress.check_stop():
        return finish_preflight(r, progress, task_id, key)
    try:
        manifest = r.request(endpoint)['data']
    except Exception as error:
        if not preflight_refusal(progress, error):
            raise
        return finish_preflight(r, progress, task_id, key)
    progress.carry(manifest)
    task = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}')['data']['task']
    # Capacity waits retain this exact dispatch and native capacity identity.
    # They consume work budget and never invoke a model to wait.
    while task.get('status') != 'in_progress':
        task = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}')['data']['task']
        if task.get('status') == 'in_progress':
            break
        stopped = progress.tick()
        if not stopped:
            try:
                r.request(endpoint)
            except Exception as error:
                if not preflight_refusal(progress, error):
                    raise
                stopped = True
        if stopped:
            return finish_preflight(r, progress, task_id, key)
        try:
            r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/claim', {'assignee': r.WORKER,
                      'automated': True, 'dispatchRequestId': key, 'capacityTaskType': 'code_generation',
                      'leaseDurationMs': min(900000, task['automation']['budgets']['maxDurationMs'])})
        except Exception as error:
            task = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}')['data']['task']
            if task.get('status') != 'in_progress' and preflight_refusal(progress, error):
                return finish_preflight(r, progress, task_id, key)
            if task.get('status') != 'in_progress' and getattr(error, 'code', None) != 'CODING_CAPACITY_WAITING':
                raise  # Lost reply stays unknown unless the original lease proves acceptance.
            if task.get('status') != 'in_progress':
                progress.write()
                time.sleep(2)
                continue
        task = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/worker?agent={r.WORKER}')['data']['task']
    if task.get('status') == 'in_progress':
        task = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/worker?agent={r.WORKER}')['data']['task']
    if task['automationLease'].get('dispatchRequestId') != key:
        raise RuntimeError('Task belongs to another request')
    lease = task['automationLease']
    # Freeze the concrete model selected by the existing capacity claim for
    # this attempt; a later principal switch never changes an active worker.
    capacity_model = task.get('codingCapacity', {}).get('model')
    progress.heartbeat = lambda: r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/heartbeat',
                                        {'assignee': r.WORKER, 'leaseId': lease['leaseId']})
    progress.relay_headers = {'x-agentx-coding-task': task_id, 'x-agentx-coding-request': key,
                              'x-agentx-coding-lease': lease['leaseId']}
    workspace = r.WORKSPACES / f'task-{task_id}'
    branch = f'agentx/coding-task-{task_id}'
    result = 'blocked'
    reason = None
    pr = None
    verification = 'unknown'
    summary = 'Worker was not started.'
    try:
        if progress.check_stop():
            raise RuntimeError('Operator stopped before preparation')
        if manifest.get('continuationCheckpoint'):
            if (not workspace.exists() or r.git(workspace, 'branch', '--show-current') != branch
                    or r.git(workspace, 'rev-parse', 'HEAD') != manifest['continuationCheckpoint']
                    or r.git(workspace, 'status', '--porcelain', '--untracked-files=normal')):
                reason = 'continuation_checkpoint_changed'
                raise RuntimeError('The recovered private checkpoint must be resumed exactly')
        if not workspace.exists():
            r.WORKSPACES.mkdir(mode=0o700, exist_ok=True)
            clone = r.supervise(['timeout', '-k', '30', str(r.CLONE_TIMEOUT_SECONDS), 'git', 'clone',
                                 '--single-branch', '--no-tags', '--branch', r.BASE_BRANCH,
                                 f'https://github.com/{r.REPOSITORY}.git', str(workspace)], progress)
            if clone.returncode or progress.check_stop():
                raise RuntimeError('Repository preparation stopped')
            r.git(workspace, 'checkout', '--quiet', '-b', branch)
        prepared = coding_git.reconcile(r.git, workspace, branch, r.BASE_BRANCH, r.AUTHOR, r.coding_progress.artifact)
        progress.manual_head = prepared.get('manualHead')
        r.install_dependencies(workspace, progress)
        installed = r.dependency_state(workspace)
        profile = manifest.get('verificationProfile') or task['automation']['verificationProfile']
        if profile not in VERIFICATION_COMMANDS:
            reason = 'verification_profile_unknown'
            raise RuntimeError('No installed independent verification profile')
        progress.phase = 'running'
        if not capacity_model or r.MODEL not in ('auto', 'agentx-primary', capacity_model):
            reason = 'coding_model_mismatch'
            raise RuntimeError('The configured worker model differs from its native capacity')
        r.MODEL = capacity_model
        progress.model_context_size = task['codingCapacity'].get('numCtx')
        if prepared['conflicts']:
            if any(path not in manifest['scope'] for path in prepared['conflicts']):
                reason = 'git_conflict_remaining'
                raise coding_git.GitRefusal('Upstream conflicts exceed the authorized task scope')
            conflict_prompt = (
                'Resolve ONLY the runner-prepared Git conflicts in these authorized files: '\
                + json.dumps(prepared['conflicts']) +
                '. Preserve the task branch and current upstream intent. Do not implement the task, commit, push, '
                'or edit any other file. Git metadata is read-only; finish with all conflict markers removed.')
            calls, seconds = _session_budget(progress, 2)
            progress.begin_step(calls, seconds, f'git-conflicts:{key}', result_kind='source')
            try:
                conflict_run = r.run_worker(workspace, conflict_prompt, seconds, progress, model=r.MODEL)
            finally:
                progress.end_step()
            if conflict_run.returncode or progress.check_stop():
                reason = progress.stop_reason or 'worker_exit'
                raise RuntimeError('The conflict-resolution worker stopped')
            coding_git.finish_merge(r.git, workspace, r.AUTHOR)
            prepared = coding_git.reconcile(r.git, workspace, branch, r.BASE_BRANCH, r.AUTHOR,
                                            r.coding_progress.artifact)
            if prepared['conflicts']:
                reason = 'git_conflict_remaining'
                raise coding_git.GitRefusal('Another upstream conflict needs a coding turn')
        capability = _lane_capability(r, r.MODEL)
        budget = coding_code_steps.step_budget(capability)
        store, ledger, root_request_id = _prepare_ledger(
            r, workspace, task_id, key, task, manifest, progress, budget, capability)
        progress.checkpoint = r.git(workspace, 'rev-parse', 'HEAD')
        _write_index(r, progress, task_id, root_request_id, ledger, progress.checkpoint)
        # Refuse a malformed planner choice before a writable worker receives it.
        # This also proves every focused target exists in the installed profile.
        for planned_step in ledger['steps']:
            coding_verification.focused_command(workspace, profile, planned_step['testTargets'])
        _project(progress, ledger, budget)
        worker_summaries = []
        while True:
            step = coding_code_ledger.next_step(ledger)
            if step is None:
                unfinished = [row for row in ledger['steps'] if row['state'] != 'verified']
                if unfinished:
                    reason = 'code_step_blocked'
                    raise RuntimeError('The code-step plan has no runnable unfinished step')
                break
            if progress.check_stop():
                reason = progress.stop_reason
                raise RuntimeError('The cumulative execution budget stopped before the next code step')
            ledger = store.start(step['id'], ledger['revision'])
            _project(progress, ledger, budget)
            step = next(row for row in ledger['steps'] if row['id'] == step['id'])
            before_head = r.git(workspace, 'rev-parse', 'HEAD')
            before_dependencies = r.dependency_state(workspace)
            prompt = coding_code_steps.step_prompt(
                _bounded_task(task, manifest), step, coding_code_ledger.summary(ledger),
                {'id': profile, 'focusedTestTargets': step['testTargets'],
                 'runnerOwned': True, 'fullVerificationAfterAssembly': True})
            remaining_steps = sum(row['state'] != 'verified' for row in ledger['steps'])
            calls, seconds = _session_budget(progress, remaining_steps)
            progress.begin_step(calls, seconds, f"code-step:{step['id']}", result_kind='source')
            try:
                run = r.run_worker(workspace, prompt, seconds, progress, model=r.MODEL)
            finally:
                progress.end_step()
            worker_summaries.append(f"{step['id']}: " + (run.stdout or run.stderr or '(no summary)')[-1200:])
            changed = _changed_paths(r, workspace)
            outside = sorted(set(changed) - set(step['paths']))
            if run.returncode or progress.check_stop() or getattr(progress, 'last_step_failure', None):
                ledger = store.record_failure(step['id'], progress.stop_reason or
                    getattr(progress, 'last_step_failure', None) or 'worker_exit', ledger['revision'])
                _stash_failed_step(r, workspace, step['id'])
                _project(progress, ledger, budget)
                reason = progress.stop_reason or 'worker_exit'
                raise RuntimeError('The code-step worker stopped before independent verification')
            if outside:
                ledger = store.record_failure(step['id'], 'step_scope_changed', ledger['revision'])
                _stash_failed_step(r, workspace, step['id'])
                _project(progress, ledger, budget)
                reason = 'code_step_scope_changed'
                raise coding_git.GitRefusal('The code step changed files outside its exact planned scope')
            if not changed:
                ledger = store.record_failure(step['id'], 'no_changes', ledger['revision'])
                _project(progress, ledger, budget)
                reason = 'no_changes'
                raise RuntimeError('The code step produced no source change')
            if r.dependency_state(workspace) != before_dependencies or before_dependencies != installed:
                ledger = store.record_failure(step['id'], 'dependencies_changed', ledger['revision'])
                _stash_failed_step(r, workspace, step['id'])
                _project(progress, ledger, budget)
                reason = 'dependencies_changed'
                raise RuntimeError('Dependency changes need separate operator approval')
            diff_before_test = r.git(workspace, 'diff', '--binary', 'HEAD')
            progress.set_stage('test')
            command = coding_verification.focused_command(workspace, profile, step['testTargets'])
            started_test = time.monotonic()
            try:
                test = r.supervise(r.sandbox(workspace, r.worker_home(workspace), command, network=False,
                                             timeout_seconds=max(1, int(progress.test_remaining()))), progress)
            except Exception:
                ledger = store.record_failure(step['id'], 'focused_test_runner_error', ledger['revision'])
                _stash_failed_step(r, workspace, step['id'])
                _project(progress, ledger, budget)
                raise
            outcome = 'passed' if test.returncode == 0 and not progress.check_stop() else 'failed'
            receipt = {'profile': profile, 'targets': step['testTargets'], 'outcome': outcome,
                       'exitCode': test.returncode, 'durationMs': max(0, int((time.monotonic() - started_test) * 1000))}
            progress.last_test = {'name': 'unittest' if profile == 'agentx-dispatcher-tests/v1' else 'jest',
                                  'outcome': outcome}
            if outcome != 'passed' or r.git(workspace, 'diff', '--binary', 'HEAD') != diff_before_test:
                failure = 'focused_tests_failed' if outcome != 'passed' else 'focused_tests_modified_source'
                verification = 'failed'
                ledger = store.record_failure(step['id'], failure, ledger['revision'], verification=[receipt])
                _stash_failed_step(r, workspace, step['id'])
                _project(progress, ledger, budget)
                summary = ('Focused verification failed (untrusted test output):\n' +
                           (getattr(test, 'stdout', '') or getattr(test, 'stderr', '') or '(no output)')[-2000:])
                reason = progress.stop_reason or 'tests_failed'
                raise RuntimeError('Runner-owned focused verification did not pass cleanly')
            progress.set_stage('checkpoint')
            commit = _commit_step(r, workspace, step, changed)
            if before_head == commit:
                raise coding_git.GitRefusal('The code-step commit did not advance the assembly branch')
            ledger = store.record_verified(step['id'], commit, changed, [receipt], ledger['revision'])
            progress.checkpoint = commit
            _write_index(r, progress, task_id, root_request_id, ledger, commit)
            _project(progress, ledger, budget)
        summary = '\n'.join(worker_summaries)[-4000:] or 'Runner-owned code steps completed.'
        progress.checkpoint = r.git(workspace, 'rev-parse', 'HEAD')
        names = coding_git.audit(r.git, workspace, f'origin/{r.BASE_BRANCH}', r.coding_progress.artifact, manifest['scope'])
        if not names:
            reason = 'no_changes'
            raise RuntimeError('No source changes for publication')
        progress.phase = 'running'
        progress.set_stage('test')
        # Reuse the reviewed verification profile; commands are native constants,
        # never GitHub logs or task-provided shell fragments.
        test = r.supervise(r.sandbox(workspace, r.worker_home(workspace), coding_verification.full_command(profile), network=False,
                                  timeout_seconds=max(1, int(progress.test_remaining()))), progress)
        verification = 'passed' if test.returncode == 0 and not progress.check_stop() else 'failed'
        progress.last_test = {'name': 'unittest' if profile == 'agentx-dispatcher-tests/v1' else 'jest', 'outcome': verification}
        if verification != 'passed':
            summary = 'Independent verification failed (untrusted test output):\n' + (getattr(test, 'stdout', '') or getattr(test, 'stderr', '') or '(no output)')[-2000:] + '\n' + summary[-1500:]
            reason = progress.stop_reason or 'tests_failed'
            raise RuntimeError('Independent tests did not pass')
        if r.git(workspace, 'status', '--porcelain', '--untracked-files=no'):
            reason = 'tests_failed'
            raise RuntimeError('Independent verification modified tracked source; a new worker checkpoint is required')
        _write_index(r, progress, task_id, root_request_id, ledger, progress.checkpoint)
        progress.phase = 'delivering'
        progress.set_stage('checkpoint')
        token = os.environ.get('GH_TOKEN', '').strip()
        if not token:
            reason = 'github_token_missing'
            raise RuntimeError('GitHub token is not configured; checkpoint stays local')
        r.request(endpoint)  # Revalidate Core authority immediately before host publication lock.
        current = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/worker?agent={r.WORKER}')['data']['task']
        native_run = current['codingAutonomy']['runs'][-1]
        if (native_run['requestId'] != key or native_run.get('pendingInferences')
                or not native_run.get('modelReceipts')
                or any(item['state'] != 'completed' for item in native_run['modelReceipts'])):
            reason = 'model_termination_unverified'
            raise RuntimeError('Native model termination is required before publication')
        body = coding_git.publication_body(r.git, workspace, f'origin/{r.BASE_BRANCH}', task_id, verification)
        identity = {'repository': r.REPOSITORY, 'branch': branch, 'base': r.BASE_BRANCH}
        intent = {**identity, 'identity': identity, 'requestId': key, 'pipelineId': task_id,
                  'head': progress.checkpoint, 'expectedPR': manifest.get('pr'), 'body': body,
                  'title': f'Coding delivery (task {task_id})', 'stage': 'prepared',
                  'diffFingerprint': coding_git.diff_identity(r.git, workspace, f'origin/{r.BASE_BRANCH}'),
                  'verdict': native_verdict(r, task_id, key, lease, current, progress, 'review', verification, None)}
        if not r.begin_publication(progress):
            raise RuntimeError('Operator stop before publication')
        pr = coding_publication.publish(r, workspace, intent, progress.path.parent / f'{key}.publication.json', token)
        result = 'review'
    except coding_publication.PublicationUnknown:
        progress.write()
        return 2  # Durable intent; Core reconciles GET observations, never reruns the worker.
    except Exception as error:
        reason = reason or progress.stop_reason or ('git_reconciliation' if isinstance(error, coding_git.GitRefusal) else 'runner_error')
        summary = f'Attempt stopped: {type(error).__name__}; {reason}. Source and private receipts are preserved.\n' + summary
    progress.pr = pr
    progress.phase = 'delivering'
    current = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/worker?agent={r.WORKER}')['data']['task']
    body = native_verdict(r, task_id, key, lease, current, progress, result, verification, reason)
    body['text'] = f'Autonomous request {key}: {result}; {pr["url"] if pr else reason}.\n\n{summary}'
    # Save the exact native request before delivery. If its response is lost,
    # replay that immutable verdict through Core's existing result fingerprint.
    path = progress.path.parent / f'{key}.verdict.json'
    r.coding_dispatch_control.atomic_json(path, body)
    progress.write()
    r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/feedback', body)
    progress.core_recorded = True
    progress.finish(result, reason, progress.checkpoint)
    return 0 if result == 'review' else 1


def native_verdict(r, task_id, key, lease, current, progress, result, verification, reason):
    receipts = current['codingAutonomy']['runs'][-1].get('modelReceipts', [])
    verified = bool(receipts) and all(entry['state'] == 'completed' for entry in receipts)
    evidence = {'schema': 'agentx.pipeline-automation-evidence/v1', 'verification': {'status': verification},
                'changes': {}, 'usage': {'durationMs': int(progress.usage()['workSeconds'] * 1000)},
                'failureCodes': [] if result == 'review' else [reason],
                'workerReceiptFingerprint': hashlib.sha256(json.dumps([key, progress.checkpoint, verification]).encode()).hexdigest(),
                'source': 'coding-autonomous/v1'}
    code_steps = coding_step_progress.project(getattr(progress, 'code_steps', None))
    if code_steps:
        evidence['codeSteps'] = code_steps
    if verified:
        evidence['routing'] = {'status': 'verified', 'provider': 'ollama', 'effectiveModel': current['codingCapacity']['model'],
            'requestCount': len(receipts), 'sessionCallCount': len(receipts),
            'evidenceFingerprint': hashlib.sha256(json.dumps(receipts, sort_keys=True).encode()).hexdigest()}
    return {'by': r.WORKER, 'assignee': r.WORKER, 'leaseId': lease['leaseId'],
            'status': 'done' if result == 'review' else 'blocked', 'attemptEvidence': evidence}


def finish_preflight(r, progress, task_id, key):
    task = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}')['data']['task']
    if task.get('status') != 'queued' or task.get('automationLease'):
        raise RuntimeError('Preflight termination needs the original native owner')
    if task.get('codingCapacity'):
        r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}/capacity/cancel', {'requestId': key})
    final = r.request(f'{r.CORE}/api/pipeline/tasks/{task_id}')['data']['task']
    if (final.get('automationLease') or final.get('codingCapacity') or final.get('status') != 'queued'
            or final.get('automationAttemptCount', 0) != task.get('automationAttemptCount', 0)):
        raise RuntimeError('Preflight termination is uncertain')
    progress.core_recorded = True
    progress.preflight = True
    progress.finish('blocked', progress.stop_reason)
    return 1
