"""Runner-owned Git reconciliation. Conflict files are left for the worker."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
import subprocess

PRIVATE = re.compile(r'(^|/)(\.env(?:\..*)?|credentials?[^/]*|secrets?[^/]*|transcripts?|memory|volumes?|backups?|campaign-[^/]*|receipts?|host-inventory[^/]*)(/|$)', re.I)
SECRET = re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{24,})\b')

class GitRefusal(RuntimeError):
    pass

def changes(git, workspace, base):
    return [p for p in git(workspace, 'diff', '--name-only', '-z', base, 'HEAD').split('\0') if p]

def audit(git, workspace, base, artifact, scope=None):
    """Inspect every newly published commit, including added-then-removed files."""
    paths = set(changes(git, workspace, base))
    commits = git(workspace, 'rev-list', f'{base}..HEAD').splitlines()
    if len(commits) > 100:
        raise GitRefusal('Publication history exceeds the reviewed budget')
    for commit in commits:
        names = git(workspace, 'diff-tree', '--root', '--no-commit-id', '-r', '-m', '--name-only', '-z', commit).split('\0')
        for name in filter(None, names):
            try:
                if git(workspace, 'rev-parse', '--verify', f'{commit}:{name}') == git(workspace, 'rev-parse', '--verify', f'{base}:{name}'):
                    continue  # A reviewed upstream blob brought in by a merge.
            except subprocess.CalledProcessError:
                pass
            paths.add(name)
            if artifact(name) or PRIVATE.search(name):
                raise GitRefusal('Publication contains private or generated artifacts')
            try:
                content = git(workspace, 'show', f'{commit}:{name}').encode()
            except subprocess.CalledProcessError:
                continue  # Deleted in this commit; earlier content is inspected above.
            if len(content) > 2 * 1024 * 1024 or SECRET.search(content):
                raise GitRefusal('Publication contains unreviewed large content or credentials')
            mode = git(workspace, 'ls-tree', commit, '--', name).split(' ', 1)[0]
            if mode in {'120000', '160000'}:
                raise GitRefusal('Publication introduces a link or submodule')
    for name in changes(git, workspace, base):
        if Path(name).suffix not in {'.js', '.cjs', '.mjs', '.py', '.ts', '.tsx', '.jsx', '.ejs'} or '/tests/' in f'/{name}' or '/test/' in f'/{name}':
            continue
        try:
            content = git(workspace, 'show', f'HEAD:{name}')
        except subprocess.CalledProcessError:
            continue  # An authorized deletion has no final source size.
        try:
            before = git(workspace, 'show', f'{base}:{name}')
        except subprocess.CalledProcessError:
            before = ''
        limit = 1200 if any(part in f'/{name}' for part in ['/public/', '/views/', '/frontend/']) else 700
        if len(content.splitlines()) > max(limit, len(before.splitlines())):
            raise GitRefusal('Publication exceeds the repository source file size rule')
    if scope is not None and any(name not in scope for name in paths):
        raise GitRefusal('Publication exceeds the exact authorized file scope')
    return sorted(paths)

def checkpoint(git, workspace, author, artifact):
    names = [p for p in git(workspace, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0') if p and not artifact(p)]
    if names:
        git(workspace, 'add', '-A', '--', *names)
    if git(workspace, 'diff', '--cached', '--name-only'):
        git(workspace, *author, 'commit', '--quiet', '-m', 'Preserve coding source checkpoint')
    return git(workspace, 'rev-parse', 'HEAD')

def reconcile(git, workspace, branch, base, author, artifact):
    if not re.fullmatch(r'agentx/coding-task-\d{4}', branch) or branch.endswith('-0909') or base != 'main':
        raise GitRefusal('Unapproved task branch or base')
    if git(workspace, 'branch', '--show-current') != branch:
        raise GitRefusal('The task workspace is on another branch')
    # An interrupted merge retains all three versions and local resolution.
    unmerged = git(workspace, 'diff', '--name-only', '--diff-filter=U').splitlines()
    if unmerged:
        return {'conflicts': unmerged, 'base': git(workspace, 'rev-parse', f'origin/{base}'), 'interruptedMerge': True}
    checkpoint(git, workspace, author, artifact)
    git(workspace, 'fetch', '--no-tags', 'origin', f'+refs/heads/{base}:refs/remotes/origin/{base}')
    remote = git(workspace, 'ls-remote', '--heads', 'origin', f'refs/heads/{branch}').split()
    manual_head = None
    targets = []
    if remote:
        git(workspace, 'fetch', '--no-tags', 'origin', f'+refs/heads/{branch}:refs/remotes/origin/{branch}')
        head = git(workspace, 'rev-parse', 'HEAD')
        try:
            git(workspace, 'merge-base', '--is-ancestor', remote[0], head)
        except subprocess.CalledProcessError:
            manual_head = remote[0]
        targets.append(f'origin/{branch}')
    targets.append(f'origin/{base}')
    pending = []
    for target in targets:
        try:
            git(workspace, *author, 'merge', '--no-edit', '--no-verify', target)
        except subprocess.CalledProcessError:
            conflicts = git(workspace, 'diff', '--name-only', '--diff-filter=U').splitlines()
            if not conflicts:
                raise GitRefusal('Git reconciliation failed without resolvable conflict files')
            pending = targets[targets.index(target) + 1:]
            return {'conflicts': conflicts, 'pendingMerges': pending,
                    'base': git(workspace, 'rev-parse', f'origin/{base}'), 'manualHead': manual_head}
    return {'conflicts': [], 'pendingMerges': pending, 'base': git(workspace, 'rev-parse', f'origin/{base}'), 'manualHead': manual_head}

def finish_merge(git, workspace, author):
    conflicts = git(workspace, 'diff', '--name-only', '--diff-filter=U').splitlines()
    for name in conflicts:
        path = workspace / name
        if path.is_file() and re.search(rb'(?m)^(<<<<<<< |=======$|>>>>>>> )', path.read_bytes()):
            raise GitRefusal('Conflict markers remain after the coding turn')
    if conflicts:
        git(workspace, 'add', '-A', '--', *conflicts)
    # The worker cannot mutate Git metadata. Complete only the runner's merge.
    if (workspace / '.git/MERGE_HEAD').exists():
        git(workspace, *author, 'commit', '--quiet', '--no-verify', '-m', 'Reconcile task branch with current upstream')

def diff_identity(git, workspace, base):
    return hashlib.sha256(git(workspace, 'diff', '--binary', base, 'HEAD').encode()).hexdigest()

def publication_body(git, workspace, base, task_id, test_result):
    names = changes(git, workspace, base)
    # No raw model answer, external logs, task prose or private context leaves
    # the instance. The public description is derived from the final source diff.
    return (f'Pipeline coding delivery {task_id}.\n\nChanged files:\n' +
            ''.join(f'- `{name}`\n' for name in names) +
            f'\nIndependent local verification: {test_result}.\n'
            'Human review, merge, installation and product acceptance remain separate.\n')
