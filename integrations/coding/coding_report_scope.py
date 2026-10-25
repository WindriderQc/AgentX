"""Frozen source inventory and model-declared, source-checked review coverage."""
from __future__ import annotations
import hashlib
import json
from pathlib import PurePosixPath
import subprocess

MAX_BYTES = 2 * 1024 * 1024


def source_bytes(workspace, commit, name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or len(name) > 300:
        raise ValueError('Coverage source must belong to the frozen repository')
    try:
        data = subprocess.check_output(['git', '-C', str(workspace), 'show', f'{commit}:{name}'], timeout=15, stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise ValueError('Coverage source is unavailable in the frozen snapshot') from error
    if len(data) > MAX_BYTES:
        raise ValueError('Review source exceeds its bounded evidence size')
    return data


def inventory(workspace, commit, selected=None):
    names = subprocess.check_output(['git', '-C', str(workspace), 'ls-tree', '-r', '--name-only', commit], timeout=15).decode().splitlines()
    markdown = [name for name in names if name.endswith('.md')]
    if selected is not None:
        if not selected or len(set(selected)) != len(selected) or any(name not in markdown for name in selected):
            raise ValueError('The selected review documents differ from the frozen source')
        markdown = selected
    return {'sourceCommit': commit, 'documents': [{'path': name, 'sha256': hashlib.sha256(source_bytes(workspace, commit, name)).hexdigest()}
            for name in sorted(markdown)]}


def seed(root, snapshot, previous=None):
    """The runner supplies an inventory, never invented review findings."""
    (root / 'source-inventory.json').write_text(json.dumps(snapshot, indent=2) + '\n')
    value = previous or {'inventorySha256': snapshot['sha256'], 'documents': [dict(row, state='pending', evidence=[]) for row in snapshot['documents']]}
    (root / 'coverage.json').write_text(json.dumps(value, indent=2) + '\n')


def read(read_bytes, workspace, root, snapshot):
    raw = read_bytes(root / 'coverage.json', root)
    if len(raw) > 512 * 1024:
        raise ValueError('Coverage exceeds its bounded receipt size')
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get('inventorySha256') != snapshot['sha256']:
        raise ValueError('Coverage belongs to a different source inventory')
    if not isinstance(value.get('documents'), list) or len(value['documents']) != len(snapshot['documents']):
        raise ValueError('Coverage must retain all frozen documents')
    docs = {row['path']: row for row in snapshot['documents']}
    seen = set()
    for row in value['documents']:
        if not isinstance(row, dict) or not isinstance(row.get('path'), str) or row.get('path') not in docs or row['path'] in seen or row.get('sha256') != docs[row['path']]['sha256']:
            raise ValueError('Coverage document identity changed')
        seen.add(row['path'])
        if row.get('state') not in ('pending', 'reviewed', 'partial', 'blocked') or not isinstance(row.get('evidence'), list) or len(row['evidence']) > 100:
            raise ValueError('Coverage needs an explicit document state and evidence list')
        if row['state'] == 'reviewed' and not row['evidence']:
            raise ValueError('Reviewed documents require source evidence')
        ranges = row.get('ranges', [])
        lines = len(source_bytes(workspace, snapshot['sourceCommit'], row['path']).splitlines()) if ranges else 0
        if not isinstance(ranges, list) or len(ranges) > 2000:
            raise ValueError('Reviewed ranges must be bounded')
        end = 0
        for span in ranges:
            if (not isinstance(span, list) or len(span) != 2 or any(type(n) is not int for n in span)
                    or not end < span[0] <= span[1] <= lines):
                raise ValueError('Reviewed ranges must belong to the frozen document and not overlap')
            end = span[1]
        for ref in row['evidence']:
            if not isinstance(ref, dict) or not isinstance(ref.get('path'), str):
                raise ValueError('Coverage references need exact source paths')
            data = source_bytes(workspace, snapshot['sourceCommit'], ref['path'])
            if hashlib.sha256(data).hexdigest() != ref.get('sha256') or type(ref.get('line')) is not int or not 1 <= ref['line'] <= len(data.splitlines()):
                raise ValueError('Coverage source digest or line is unverified')
            if not isinstance(ref.get('check'), str) or not ref['check'].strip() or len(ref['check']) > 1000:
                raise ValueError('Coverage needs the concrete checked claim')
    return value
