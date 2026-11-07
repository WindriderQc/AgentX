"""Operator-required test edits. Content evidence never proves semantic coverage."""
from __future__ import annotations

import json
import re
import stat
import subprocess


class RegressionRefusal(ValueError):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _read(path):
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16384:
            raise ValueError('Invalid requirement receipt')
        return json.loads(path.read_text())
    except (OSError, ValueError, TypeError) as error:
        raise RegressionRefusal('regression_requirement_unverified') from error


def prepare(r, workspace, progress, manifest, *, initialize=True):
    """Freeze one baseline outside the worker sandbox, never the rejected stash."""
    tests = (manifest.get('qualification') or {}).get('requiredRegressionTests', [])
    if (not isinstance(tests, list) or len(tests) > 20
            or any(not isinstance(name, str) or not name or len(name) > 240
                   or re.search(r'[\\\x00-\x20\x7f]', name)
                   or any(part in ('', '.', '..') for part in name.split('/')) for name in tests)
            or len(set(tests)) != len(tests)):
        raise RegressionRefusal('regression_requirement_unverified')
    tests = sorted(tests)
    path = progress.path.parent / f'task-{progress.task_id}.regression-requirement.json'
    if path.exists() or path.is_symlink():
        saved = _read(path)
        if (not isinstance(saved, dict) or set(saved) != {'schema', 'taskId', 'rootRequestId', 'baseHead', 'testPaths'}
                or saved.get('schema') != 'agentx.coding-regression-requirement/v1'
                or saved.get('taskId') != progress.task_id or saved.get('testPaths') != tests
                or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', str(saved.get('rootRequestId', '')))
                or not re.fullmatch(r'[a-f0-9]{40}(?:[a-f0-9]{24})?', str(saved.get('baseHead', '')))):
            raise RegressionRefusal('regression_requirement_unverified')
        try:
            r.git(workspace, 'merge-base', '--is-ancestor', saved['baseHead'], 'HEAD')
        except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
            raise RegressionRefusal('regression_requirement_unverified') from error
        return saved
    if not tests:
        return None
    if not initialize or manifest.get('parentRequestId') or manifest.get('correction'):
        raise RegressionRefusal('regression_requirement_unverified')
    if not set(tests).issubset(manifest['scope']):
        raise RegressionRefusal('regression_requirement_unverified')
    saved = {'schema': 'agentx.coding-regression-requirement/v1', 'taskId': progress.task_id,
             'rootRequestId': progress.request_id, 'baseHead': r.git(workspace, 'rev-parse', 'HEAD'),
             'testPaths': tests}
    r.coding_dispatch_control.atomic_json(path, saved)
    return saved


def verify(r, workspace, progress, requirement, *, worker_commits=()):
    """Inspect the committed delivery, after native tests and before publication."""
    if requirement is None:
        return
    head = r.git(workspace, 'rev-parse', 'HEAD')
    rows = []
    for name in requirement['testPaths']:
        entry = r.git(workspace, 'ls-tree', head, '--', name)
        old = r.git(workspace, 'ls-tree', requirement['baseHead'], '--', name)
        blob = entry.split()[2] if entry else None
        old_blob = old.split()[2] if old else None
        additions = r.git(workspace, 'diff', '--numstat', '--ignore-all-space', '--ignore-blank-lines',
                          requirement['baseHead'], head, '--', name).split('\t')[0]
        regular = bool(entry and entry.split()[0] in ('100644', '100755'))
        changed = regular and blob != old_blob and additions.isdigit() and int(additions) > 0
        commits = r.git(workspace, 'log', '--format=%H', requirement['baseHead'] + '..' + head,
                        '--', name).splitlines() if entry else []
        rows.append({'path': name, 'baseBlob': old_blob, 'candidateBlob': blob, 'satisfied': bool(changed),
                     'lastChangeCommit': commits[0] if commits else None,
                     'attribution': 'worker' if commits and set(commits).issubset(worker_commits)
                                    else 'external_or_prior_run'})
    passed = all(row['satisfied'] for row in rows)
    r.coding_dispatch_control.atomic_json(progress.path.parent / f'{progress.request_id}.regression-edits.json', {
        'schema': 'agentx.coding-regression-edits/v1', 'taskId': progress.task_id,
        'requestId': progress.request_id, 'baseHead': requirement['baseHead'], 'head': head,
        'status': 'passed' if passed else 'failed', 'semanticCoverage': 'not_verified', 'tests': rows})
    if not passed:
        raise RegressionRefusal('regression_edits_missing')
