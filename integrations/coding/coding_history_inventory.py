"""Read-only file inventory for a native harness archive; never converts history.

Manifests contain private paths and digests. Keep them outside public Git. An
inventory is not a backup: verify an independent, quiescent copy before cutover.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat

SCHEMA = 'agentx.coding-history-inventory/v1'


def fingerprint(path: Path) -> dict:
    before = path.lstat()
    if stat.S_ISLNK(before.st_mode):
        value = {'kind': 'symlink', 'target': os.readlink(path)}
    elif stat.S_ISREG(before.st_mode):
        digest = hashlib.sha256()
        # O_NOFOLLOW also refuses a file swapped for a symlink after lstat.
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                raise ValueError('Archive file changed during inventory')
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        value = {'kind': 'file', 'bytes': before.st_size, 'sha256': digest.hexdigest()}
    else:
        raise ValueError('Archive contains a non-file entry')
    after = path.lstat()
    identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    if identity(before) != identity(after):
        raise ValueError('Archive file changed during inventory')
    return value


def inventory(root: Path, *, exclude=('node_modules',)) -> dict:
    root = root.absolute()
    if root.is_symlink() or not root.is_dir() or root.resolve() != root:
        raise ValueError('Archive root must be a real directory without symlink parents')
    entries = {}
    directories = ['.']
    def visit(directory):
        for path in sorted(directory.iterdir()):
            if path.name in exclude:
                continue
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                # Record the link itself. Never read an external target.
                entries[relative] = fingerprint(path)
            elif path.is_dir():
                directories.append(relative)
                visit(path)
            else:
                entries[relative] = fingerprint(path)
    visit(root)
    return {'schema': SCHEMA, 'excludedNames': list(exclude), 'directories': sorted(directories), 'entries': entries}


def compare(expected: dict, root: Path) -> dict:
    if expected.get('schema') != SCHEMA:
        raise ValueError('Unsupported history inventory schema')
    exclusions = expected.get('excludedNames')
    if (not isinstance(exclusions, list) or any(not isinstance(x, str) or not x or '/' in x or x in ('.', '..')
                                                for x in exclusions)):
        raise ValueError('Invalid inventory exclusions')
    actual = inventory(root, exclude=tuple(exclusions))
    old, new = expected['entries'], actual['entries']
    missing = sorted(set(old) - set(new))
    added = sorted(set(new) - set(old))
    changed = sorted(p for p in set(old) & set(new) if old[p] != new[p])
    directories_match = expected['directories'] == actual['directories']
    return {'matches': not (missing or added or changed) and directories_match,
            'missing': missing, 'added': added, 'changed': changed, 'directoriesMatch': directories_match}


def write_private(path: Path, value: dict, roots: list[Path]):
    destination = path.absolute()
    parent = destination.parent.resolve(strict=True)
    destination = parent / destination.name
    if any(destination.is_relative_to(root.resolve()) for root in roots):
        raise ValueError('Write the inventory outside its source roots')
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('capture', 'verify'))
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    if args.operation == 'capture':
        value = inventory(args.root)
        # Re-read to detect growing or rewritten files and changing directory sets.
        if not compare(value, args.root)['matches']:
            raise ValueError('Archive changed during inventory; quiesce its writer and retry')
        write_private(args.manifest, value, [args.root])
        print(json.dumps({'files': len(value['entries']), 'directories': len(value['directories']),
                          'bytes': sum(v.get('bytes', 0) for v in value['entries'].values()),
                          'backupVerified': False}))
    else:
        result = compare(json.loads(args.manifest.read_text()), args.root)
        print(json.dumps(result))
        raise SystemExit(0 if result['matches'] else 1)


if __name__ == '__main__':
    main()
