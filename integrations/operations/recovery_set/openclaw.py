"""Prepare a relocation-safe copy; let OpenClaw own its backup exclusions."""
import json
import os
from pathlib import Path
import sqlite3
import stat
import tarfile

from .common import archive_paths, digest, run, save


def stage_home(source, stage, artifacts, historical):
    source, stage, artifacts = map(Path, (source, stage, artifacts))
    stage.mkdir(parents=True, mode=0o700)
    links, databases, files = [], [], []
    closed = [source / name for name in historical if (source / name).exists()]
    archive_paths(artifacts / 'openclaw-historical.tar.gz', closed)
    for directory, dirs, names in os.walk(source, followlinks=False):
        base = Path(directory)
        if base == source:
            dirs[:] = [name for name in dirs if name not in historical]
        target_dir = stage / base.relative_to(source)
        target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in list(dirs) + names:
            path = base / name
            relative = path.relative_to(source)
            target = stage / relative
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue  # Process sockets/cache files can disappear during discovery.
            if stat.S_ISLNK(info.st_mode):
                links.append({'path': str(relative), 'target': os.readlink(path)})
                if name in dirs:
                    dirs.remove(name)
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            if any(str(path).endswith(ext + tail) for ext in ('.sqlite', '.db', '.sqlite3') for tail in ('-wal', '-shm', '-journal')):
                continue
            with path.open('rb') as stream:
                is_db = stream.read(16) == b'SQLite format 3\x00'
            if is_db:
                with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=30) as origin:
                    origin.execute('BEGIN')
                    origin.execute('PRAGMA schema_version').fetchall()
                    with sqlite3.connect(target) as copy:
                        origin.backup(copy)
                        if copy.execute('PRAGMA quick_check').fetchone() != ('ok',):
                            raise RuntimeError('SQLite recovery integrity check failed')
                databases.append(str(relative))
            else:
                # A growing session has a captured prefix, never an inconsistent
                # mid-stream append; a shortened required source fails the capture.
                with path.open('rb') as stream, target.open('xb') as out:
                    left = info.st_size
                    while left:
                        chunk = stream.read(min(left, 1024 * 1024))
                        if not chunk:
                            raise RuntimeError('Source shortened during recovery capture')
                        out.write(chunk)
                        left -= len(chunk)
            target.chmod(0o600 if is_db else stat.S_IMODE(info.st_mode) & 0o777)
            files.append({'path': str(relative), 'sha256': digest(target), 'sqlite': is_db})
    original = (stage / 'openclaw.json').read_bytes()
    (artifacts / 'openclaw-original-config.private.json').write_bytes(original)

    def rebase(value):
        if isinstance(value, list):
            return [rebase(v) for v in value]
        if isinstance(value, dict):
            return {k: rebase(v) for k, v in value.items()}
        if isinstance(value, str):
            for prefix in (str(source), '~/.openclaw'):
                if value == prefix or value.startswith(prefix + '/'):
                    return str(stage) + value[len(prefix):]
        return value

    save(stage / 'openclaw.json', rebase(json.loads(original)))
    for link in links:
        resolved = (source / link['path']).parent.joinpath(link['target']).resolve()
        try:
            actual = stage / resolved.relative_to(source)
        except ValueError:
            continue
        if actual.exists():
            target = stage / link['path']
            target.symlink_to(os.path.relpath(actual, target.parent))
    save(artifacts / 'openclaw-links.private.json', links)
    save(artifacts / 'openclaw-inventory.private.json', {'files': files, 'databases': databases, 'historicalTrees': historical})
    return stage


def capture(config, work, artifacts):
    stage = stage_home(config['home'], work / 'portable-source', artifacts, config.get('historicalTrees', []))
    run(config['command'] + ['backup', 'create', '--output', str(artifacts / 'openclaw-portable.tar.gz'), '--verify', '--json'],
        work / 'openclaw.log', env=dict(os.environ, OPENCLAW_STATE_DIR=str(stage), OPENCLAW_CONFIG_PATH=str(stage / 'openclaw.json')))
    # Read every member to detect compressed-stream truncation, without restoring
    # any live state or replacing the native verify receipt.
    with tarfile.open(artifacts / 'openclaw-portable.tar.gz') as archive:
        for member in archive:
            if member.isfile():
                stream = archive.extractfile(member)
                while stream.read(1024 * 1024):
                    pass
