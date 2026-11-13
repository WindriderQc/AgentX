"""Capture current native runtimes and shared stores into a private generation."""
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import uuid
import zipfile

from . import openclaw
from .common import archive_paths, digest, json_command, now, run, save, seal
from .queue import Queue, Uncertain
from .validate import POINT_DIGEST, validate


def node_in(container, script, log, output=None):
    run(['docker', 'exec', container, 'node', '-e', script], log, output=output)


def shared_fingerprint(config, work, suffix):
    """Detect critical owner/catalog/document changes across the capture window."""
    names = config['mongo']['consistencyCollections']
    code = 'print(EJSON.stringify(Object.fromEntries(' + json.dumps(names) + '.map(n=>[n,db.getCollection(n).find().sort({_id:1}).toArray()]))))'
    target = work / ('shared-' + suffix + '.private.ejson')
    run(['docker', 'exec', config['mongo']['container'], 'mongosh', '--quiet', config['mongo']['database'], '--eval', code],
        work / 'mongo-consistency.log', output=target)
    originals = {}
    for item in config.get('consistencyFiles', []):
        originals[item] = digest(item)
    for root in config.get('consistencyTrees', []):
        for path in sorted(Path(root).rglob('*')):
            if path.is_file() and not path.is_symlink():
                originals[str(path)] = digest(path)
    return {'mongo': digest(target), 'files': originals}


def fingerprint_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def repositories(config, work, artifacts):
    revisions = {}
    for repository in config:
        label, root = repository['id'], repository['path']
        args = ['git', '-C', root]
        revision = subprocess.check_output(args + ['rev-parse', 'HEAD'], text=True).strip()
        run(args + ['bundle', 'create', str(artifacts / (label + '.bundle')), 'HEAD'], work / (label + '-bundle.log'))
        run(args + ['diff', 'HEAD', '--binary'], work / (label + '-diff.log'), output=artifacts / (label + '-installed.private.patch'))
        # Untracked, nonignored source is part of the installed composition too.
        untracked = subprocess.check_output(args + ['ls-files', '--others', '--exclude-standard', '-z']).decode().split('\0')
        with tarfile.open(artifacts / (label + '-untracked.private.tar.gz'), 'w:gz', dereference=False) as archive:
            for name in filter(None, untracked):
                archive.add(Path(root) / name, arcname=name)
        revisions[label] = revision
    return revisions


def capture_qdrant(config, work, artifacts):
    container = config['clientContainer']
    log = work / 'qdrant.log'
    listing = 'fetch(process.env.QDRANT_URL+"/collections").then(async r=>{if(!r.ok)throw Error("inventory");console.log(JSON.stringify(await r.json()))}).catch(()=>process.exitCode=1)'
    inventory = work / 'qdrant-inventory-before.private.json'
    node_in(container, listing, log, inventory)
    before = json.loads(inventory.read_text())['result']['collections']
    node_in(container, POINT_DIGEST + 'digestAll(process.env.QDRANT_URL).then(x=>console.log(JSON.stringify(x))).catch(()=>process.exitCode=1)',
            log, work / 'qdrant-points-before.private.json')
    snapshot = work / 'qdrant-snapshot-result.private.json'
    # Durable intent precedes the one native mutation. Qdrant does not promise
    # idempotent POST /snapshots: an ambiguous result is fenced, never retried.
    save(work / 'qdrant-snapshot-intent.private.json', {'requestId': str(uuid.uuid4()), 'createdAt': now(), 'state': 'dispatching'})
    try:
        node_in(container, 'fetch(process.env.QDRANT_URL+"/snapshots",{method:"POST"}).then(async r=>{if(!r.ok)throw Error("snapshot");console.log(JSON.stringify(await r.json()))}).catch(()=>process.exitCode=1)', log, snapshot)
        result = json.loads(snapshot.read_text())['result']
        name = result['name']
        if Path(name).name != name or name in ('.', '..'):
            raise ValueError('Unsafe native snapshot identity')
    except Exception as error:
        raise Uncertain('Qdrant snapshot outcome requires the original native result') from error
    save(artifacts / 'qdrant-snapshot.private.json', {'native': result, 'collections': before})
    output = artifacts / 'qdrant-full-storage.snapshot'
    script = '''const {Readable}=require('node:stream');const {pipeline}=require('node:stream/promises');
fetch(process.env.QDRANT_URL+'/snapshots/'+encodeURIComponent(NAME)).then(async r=>{if(!r.ok)throw Error('download');await pipeline(Readable.fromWeb(r.body),process.stdout)}).catch(()=>process.exitCode=1);'''.replace('NAME', json.dumps(name))
    # Download is read-only and can be repeated after an interrupted transfer.
    node_in(container, script, log, output)
    if result.get('checksum') and digest(output) != result['checksum']:
        raise RuntimeError('Native Qdrant snapshot checksum mismatch')
    with tarfile.open(output) as archive:
        for member in archive:
            if member.isfile():
                stream = archive.extractfile(member)
                while stream.read(1024 * 1024):
                    pass
    after = work / 'qdrant-inventory-after.private.json'
    node_in(container, listing, log, after)
    after_collections = json.loads(after.read_text())['result']['collections']
    if sorted(x['name'] for x in before) != sorted(x['name'] for x in after_collections):
        raise RuntimeError('Qdrant collection inventory changed during capture')


def release_snapshot(config, work, artifacts):
    descriptor_path = artifacts / 'qdrant-snapshot.private.json'
    if not descriptor_path.exists():
        return
    descriptor = json.loads(descriptor_path.read_text())['native']
    name = descriptor['name']
    if Path(name).name != name or name in ('.', '..'):
        raise ValueError('Unsafe owned snapshot identity')
    deletion = 'fetch(process.env.QDRANT_URL+"/snapshots/"+encodeURIComponent(' + json.dumps(name) + '),{method:"DELETE"}).then(async r=>{if(!r.ok&&r.status!==404)throw Error("cleanup");console.log(JSON.stringify({released:true}))}).catch(()=>process.exitCode=1)'
    node_in(config['clientContainer'], deletion, work / 'qdrant-cleanup.log', work / 'qdrant-cleanup.private.json')


def capture(config, request_id):
    root = Path(config['root'])
    work = root / 'runs' / request_id
    if work.exists():
        raise Uncertain('This recovery capture identity already exists; reconcile it instead of replaying')
    work.mkdir(parents=True, mode=0o700)
    artifacts = work / 'artifacts'
    artifacts.mkdir(mode=0o700)
    queue = Queue(config['queue'], work, request_id)
    save(work / 'capture.private.json', {'state': 'preparing', 'requestId': request_id, 'startedAt': now()})
    uncertain, success = False, False
    try:
        queue.admit()
        before = shared_fingerprint(config, work, 'before')
        started = now()
        versions = {}
        for runtime in config.get('hermes', []):
            output = artifacts / (runtime['id'] + '.zip')
            run(runtime['command'] + ['backup', '--output', str(output), '--keep', '0'], work / (runtime['id'] + '.log'),
                env=dict(os.environ, HERMES_HOME=runtime['home']))
            with zipfile.ZipFile(output) as archive:
                if archive.testzip():
                    raise RuntimeError('Hermes native archive failed its CRC check')
        save(artifacts / 'hermes-links.private.json', {
            runtime['id']: [{'path': str(path.relative_to(runtime['home'])), 'target': os.readlink(path)}
                            for path in Path(runtime['home']).rglob('*') if path.is_symlink()]
            for runtime in config.get('hermes', [])})
        save(artifacts / 'recovery-config.private.json', config)
        runtime = config.get('openclaw')
        if runtime:
            run(runtime['command'] + ['--version'], work / 'openclaw-version.log', output=artifacts / 'openclaw-version.txt')
            archive_paths(artifacts / 'openclaw-runtime.tar.gz', [runtime['packageRoot']])
            openclaw.capture(runtime, work, artifacts)
        mongo = config['mongo']
        run(['docker', 'exec', mongo['container'], 'mongodump', '--db', mongo['database'], '--archive', '--gzip'],
            work / 'mongo.log', output=artifacts / 'mongo.archive.gz')
        # Validate the entire compressed stream; the native restore drill remains
        # a distinct assurance level from a recurring successful capture.
        import gzip
        with gzip.open(artifacts / 'mongo.archive.gz', 'rb') as stream:
            while stream.read(1024 * 1024):
                pass
        capture_qdrant(config['qdrant'], work, artifacts)
        archive_paths(artifacts / 'instance-private.tar.gz', config['privatePaths'])
        revisions = repositories(config['repositories'], work, artifacts)
        runtime_settings = {}
        for name in config.get('runtimeContainers', []):
            inspected = json_command(['docker', 'inspect', name])[0]
            runtime_settings[name] = {'image': inspected['Image'], 'environment': inspected['Config']['Env']}
        save(artifacts / 'runtime-settings.private.json', runtime_settings)
        after = shared_fingerprint(config, work, 'after')
        if before != after:
            raise RuntimeError('Critical memory, catalog or original sources changed during capture; generation is not published')
        validate(config, work, artifacts)
        # The downloaded and restored full snapshot is the recovery copy. Remove
        # only this job's native server duplicate, never unrelated snapshots.
        release_snapshot(config['qdrant'], work, artifacts)
        if config.get('restoreReadme'):
            shutil.copyfile(config['restoreReadme'], artifacts / 'RESTORE.md')
        save(artifacts / 'capture-evidence.private.json', {
            'requestId': request_id, 'startedAt': started, 'finishedAt': now(),
            'criticalSourcesStable': True, 'nativeArchivesVerified': True,
            'sharedStoreSnapshotWindow': [started, now()], 'liveModelCalls': 0,
            'limits': ['Per-store native snapshots; sessions may include a captured growing-file prefix.',
                       'No global transaction spans MongoDB and Qdrant; critical source stability is checked.'],
        })
        # Preserve exact native commands and their private results for recovery.
        with tarfile.open(artifacts / 'native-receipts.private.tar.gz', 'w:gz') as archive:
            for path in sorted(work.iterdir()):
                if path.is_file():
                    archive.add(path, arcname=path.name)
        manifest = seal(artifacts, {'generation': request_id, 'startedAt': started, 'sourceRevisions': revisions,
                                   'scope': config['scope'], 'sourceHost': config['sourceHost']})
        generations = root / 'generations'
        generations.mkdir(exist_ok=True, mode=0o700)
        destination = generations / request_id
        os.rename(artifacts, destination)
        save(root / 'latest.private.json', {'generation': request_id, 'completedAt': manifest['completedAt'],
                                           'criticalFingerprint': fingerprint_hash(before),
                                           'manifestSha256': digest(destination / 'manifest.private.json')})
        save(work / 'capture.private.json', {'state': 'complete', 'requestId': request_id, 'finishedAt': now()})
        success = True
        return manifest
    except Uncertain:
        uncertain = True
        save(work / 'capture.private.json', {'state': 'unknown', 'requestId': request_id, 'observedAt': now()})
        raise
    except Exception:
        save(work / 'capture.private.json', {'state': 'failed', 'requestId': request_id, 'finishedAt': now()})
        raise
    finally:
        if not uncertain:
            # Failed captures also release their own known snapshot duplicate.
            # An unknown POST stays fenced and never enters this cleanup path.
            if not success and (artifacts / 'qdrant-snapshot.private.json').exists():
                try:
                    release_snapshot(config['qdrant'], work, artifacts)
                except Exception:
                    save(work / 'qdrant-cleanup-pending.private.json', {'state': 'pending', 'observedAt': now()})
            try:
                queue.finish(success)
            except Exception as error:
                raise Uncertain('Core has not acknowledged the original operator release receipt') from error
            # Only this request's expendable source copy is removed. Failed
            # artifacts and all receipts remain for diagnosis, not as latest.
            stage = work / 'portable-source'
            if stage.exists() and not stage.is_symlink():
                shutil.rmtree(stage)
            restored = work / 'restore-check'
            if restored.exists() and not restored.is_symlink():
                shutil.rmtree(restored)
