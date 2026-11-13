"""Private files, native commands and immutable recovery manifests."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile


def now():
    return datetime.now(timezone.utc).isoformat()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.flush()
        os.fsync(out.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, path)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def run(args, log, env=None, output=None):
    """No shell; all diagnostics stay beside the private generation."""
    with Path(log).open('ab') as errors:
        if output:
            with Path(output).open('wb') as stream:
                result = subprocess.run(args, env=env, stdout=stream, stderr=errors)
        else:
            result = subprocess.run(args, env=env, stdout=errors, stderr=errors)
    if result.returncode:
        raise RuntimeError('Native command failed; inspect private log ' + Path(log).name)


def json_command(args):
    result = subprocess.run(args, capture_output=True, check=True, text=True)
    return json.loads(result.stdout)


def archive_paths(output, paths):
    """No dereference: explicit external targets must be configured separately."""
    with tarfile.open(output, 'w:gz', dereference=False) as archive:
        for source in paths:
            source = Path(source)
            if not source.exists() and not source.is_symlink():
                raise RuntimeError('Required recovery source is absent: ' + str(source))
            archive.add(source, arcname=str(source).lstrip('/'))


def verify(directory):
    directory = Path(directory)
    manifest = json.loads((directory / 'manifest.private.json').read_text())
    if manifest.get('contract') != 'agentx.recovery-set/v1' or manifest.get('state') != 'complete':
        raise ValueError('Recovery generation is not complete')
    seen = set()
    for artifact in manifest['artifacts']:
        name = artifact['file']
        if name in seen or name in {'.', '..', 'manifest.private.json'} or Path(name).name != name:
            raise ValueError('Unsafe or duplicate artifact name')
        seen.add(name)
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != artifact['bytes'] or digest(path) != artifact['sha256']:
            raise ValueError('Recovery artifact integrity mismatch: ' + name)
    if not seen:
        raise ValueError('Empty recovery generation')
    return manifest


def seal(directory, metadata):
    directory = Path(directory)
    artifacts = []
    for path in sorted(directory.iterdir()):
        if path.name == 'manifest.private.json':
            continue
        if not path.is_file() or path.is_symlink():
            raise ValueError('Only regular recovery artifacts can be sealed')
        path.chmod(0o600)
        artifacts.append({'file': path.name, 'bytes': path.stat().st_size, 'sha256': digest(path)})
    save(directory / 'manifest.private.json', {
        'contract': 'agentx.recovery-set/v1', 'state': 'complete',
        'completedAt': now(), **metadata, 'artifacts': artifacts,
        'assurance': 'native-backups, isolated imports, durable runtime files, Core critical records and all RAG vectors/payloads compared',
    })
    return verify(directory)
