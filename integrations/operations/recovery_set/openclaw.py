"""Prepare a relocation-safe copy; let OpenClaw own its backup exclusions."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import stat
import tarfile
import time

from .common import archive_paths, digest, run, save


AUDIT_LEASE_TIMEOUT = (
    b'[openclaw] Reason: timed out waiting for legacy audit migration lease '
    b'migration.legacy-audit/filesystem-sqlite-boundary'
)
AUDIT_LEASE_RETRY_DELAYS = (8, 60)


def is_sqlite(path):
    with path.open('rb') as stream:
        return stream.read(16) == b'SQLite format 3\x00'


def is_sqlite_sidecar(path):
    database_name, _, suffix = path.name.rpartition('-')
    if not database_name or suffix not in ('wal', 'shm', 'journal'):
        return False
    database = path.with_name(database_name)
    if database.suffix in ('.sqlite', '.db', '.sqlite3'):
        return True
    # SQLite also uses these suffixes for renamed or extensionless databases.
    try:
        return stat.S_ISREG(database.lstat().st_mode) and is_sqlite(database)
    except FileNotFoundError:
        return False


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
            if is_sqlite_sidecar(path):
                continue
            is_db = is_sqlite(path)
            if is_db:
                with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=30)) as origin:
                    origin.execute('BEGIN')
                    origin.execute('PRAGMA schema_version').fetchall()
                    with closing(sqlite3.connect(target)) as copy:
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


def audit_lease_timed_out(log):
    # Match the native command's final reason, keeping any other failure visible.
    with log.open('rb') as stream:
        stream.seek(-min(log.stat().st_size, 65536), os.SEEK_END)
        reasons = [line for line in stream.read().splitlines() if line.startswith(b'[openclaw] Reason: ')]
    return reasons == [AUDIT_LEASE_TIMEOUT]


def create_backup(command, stage, work, archive):
    args = command + ['backup', 'create', '--output', str(archive), '--verify', '--json']
    env = dict(os.environ, OPENCLAW_STATE_DIR=str(stage), OPENCLAW_CONFIG_PATH=str(stage / 'openclaw.json'))
    for attempt, retry_delay in enumerate((*AUDIT_LEASE_RETRY_DELAYS, None), start=1):
        log = work / ('openclaw.log' if attempt == 1 else f'openclaw-retry-{attempt}.log')
        try:
            run(args, log, env=env)
            return
        except RuntimeError:
            # The synchronous CLI has exited. Reuse only the private staging
            # copy after a known pre-publication refusal, under the same capture.
            if retry_delay is None or archive.exists() or archive.is_symlink() or not audit_lease_timed_out(log):
                raise
            time.sleep(retry_delay)


def capture(config, work, artifacts):
    stage = stage_home(config['home'], work / 'portable-source', artifacts, config.get('historicalTrees', []))
    archive_path = artifacts / 'openclaw-portable.tar.gz'
    create_backup(config['command'], stage, work, archive_path)
    # Read every member to detect compressed-stream truncation, without restoring
    # any live state or replacing the native verify receipt.
    with tarfile.open(archive_path) as archive:
        for member in archive:
            if member.isfile():
                stream = archive.extractfile(member)
                while stream.read(1024 * 1024):
                    pass
