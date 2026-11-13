"""Restore each generation into empty homes and network-isolated stores."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import zipfile

from .common import digest, json_command, run, save
from .queue import Uncertain


POINT_DIGEST = r'''
const {createHash}=require('node:crypto');
function stable(v){if(Array.isArray(v))return '['+v.map(stable).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';return JSON.stringify(v);}
async function digestAll(base){const response=await fetch(base+'/collections');if(!response.ok)throw Error('inventory');const list=await response.json();const all={};
for(const {name} of list.result.collections){let offset,hashes=[];do{const r=await fetch(base+'/collections/'+encodeURIComponent(name)+'/points/scroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:100,with_vector:true,with_payload:true,...(offset===undefined?{}:{offset})})});if(!r.ok)throw Error('scroll');const result=(await r.json()).result;for(const p of result.points)hashes.push(createHash('sha256').update(stable(p)).digest('hex'));offset=result.next_page_offset;}while(offset!==null&&offset!==undefined);all[name]={points:hashes.length,sha256:createHash('sha256').update(hashes.sort().join('\n')).digest('hex')};}
return Object.fromEntries(Object.entries(all).sort());}
'''


def sqlite_rows(path):
    with sqlite3.connect(Path(path).as_uri() + '?mode=ro', uri=True) as db:
        if db.execute('PRAGMA quick_check').fetchone() != ('ok',):
            raise RuntimeError('Restored SQLite failed its integrity check')
        values = {}
        for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            quoted = '"' + table.replace('"', '""') + '"'
            rows = db.execute('SELECT * FROM ' + quoted)
            encoded = sorted(json.dumps([v.hex() if isinstance(v, bytes) else v for v in row], ensure_ascii=False) for row in rows)
            values[table] = hashlib.sha256('\n'.join(encoded).encode()).hexdigest()
        return values


@contextmanager
def isolated(config, work, name, image, command):
    log = work / (name + '.log')
    if subprocess.run(['docker', 'inspect', name], capture_output=True).returncode == 0:
        raise Uncertain('Restore container name already exists')
    identifier = None
    try:
        result = subprocess.run(['docker', 'create', '--pull=never', '--network', 'none', '--name', name,
            '--label', 'agentx.recovery-request=' + work.name,
            '--mount', 'type=bind,src=' + str(work / 'artifacts') + ',dst=/source,readonly', image] + command,
            capture_output=True, text=True)
        if result.returncode:
            raise Uncertain('Native restore container creation outcome requires reconciliation')
        identifier = result.stdout.strip()
        save(work / (name + '.container.private.json'), {'id': identifier, 'name': name})
        run(['docker', 'start', identifier], log)
        yield identifier
    finally:
        if identifier:
            try:
                run(['docker', 'stop', identifier], log)
                run(['docker', 'rm', '-v', identifier], log)
                save(work / (name + '.release.private.json'), {'id': identifier, 'stoppedAndRemoved': True})
            except Exception as error:
                raise Uncertain('Restore container release has not been acknowledged') from error


def validate(config, work, artifacts):
    restored = work / 'restore-check'
    restored.mkdir(mode=0o700)
    counts = {'hermesFiles': 0, 'hermesSQLite': 0, 'openclawDurableFiles': 0}
    for runtime in config.get('hermes', []):
        home = restored / runtime['id']
        home.mkdir(mode=0o700)
        archive_path = artifacts / (runtime['id'] + '.zip')
        run(runtime['command'] + ['import', '--force', str(archive_path)], work / (runtime['id'] + '-restore.log'),
            env=dict(os.environ, HERMES_HOME=str(home)))
        with zipfile.ZipFile(archive_path) as archive:
            for member in archive.infolist():
                if member.is_dir() or Path(member.filename).name in {'gateway_state.json', 'gateway.pid', 'cron.pid', 'gateway.lock', 'processes.json'}:
                    continue
                destination = home / member.filename
                if not destination.is_file():
                    raise RuntimeError('Hermes restore omitted a durable file')
                data = archive.read(member)
                if data.startswith(b'SQLite format 3\x00'):
                    source = restored / 'compare.sqlite'
                    source.write_bytes(data)
                    if sqlite_rows(source) != sqlite_rows(destination):
                        raise RuntimeError('Hermes restored SQLite contents differ')
                    source.unlink()
                    counts['hermesSQLite'] += 1
                elif hashlib.sha256(data).hexdigest() != digest(destination):
                    raise RuntimeError('Hermes restored file differs')
                counts['hermesFiles'] += 1
    runtime = config.get('openclaw')
    if runtime:
        target, stage = restored / 'openclaw', work / 'portable-source'
        receipt = work / 'openclaw-restore.private.json'
        run(runtime['command'] + ['backup', 'restore', str(artifacts / 'openclaw-portable.tar.gz'), '--target', str(target), '--json'],
            work / 'openclaw-restore.log', output=receipt,
            env=dict(os.environ, OPENCLAW_STATE_DIR=str(restored / 'command-state'), OPENCLAW_CONFIG_PATH=str(stage / 'openclaw.json')))
        result = json.loads(receipt.read_text())
        if not result.get('ok'):
            raise RuntimeError('OpenClaw native restore did not confirm success')
        configs = [p for p in target.rglob('openclaw.json') if p.as_posix().endswith(stage.as_posix() + '/openclaw.json')]
        if len(configs) != 1:
            raise RuntimeError('Restored OpenClaw home is ambiguous')
        home = configs[0].parent
        inventory = json.loads((artifacts / 'openclaw-inventory.private.json').read_text())
        for item in inventory['files']:
            relative = Path(item['path'])
            durable = ((relative.parts[0].startswith('workspace-') and
                       ((len(relative.parts) == 2 and relative.suffix == '.md') or (len(relative.parts) > 1 and relative.parts[1] == 'memory')))
                       or relative.parts[0] in {'identity', 'credentials'} or str(relative) == '.env')
            if durable and not item['sqlite']:
                if digest(home / relative) != item['sha256']:
                    raise RuntimeError('OpenClaw durable instruction/personality/memory differs')
                counts['openclawDurableFiles'] += 1
        counts['openclawNativeEntries'] = result.get('entryCount')
    mongo = config['mongo']
    image = json_command(['docker', 'inspect', mongo['container']])[0]['Image']
    name = 'agentx-recovery-mongo-' + work.name
    with isolated(config, work, name, image, ['mongod', '--setParameter', 'ttlMonitorEnabled=false']) as container:
        for _ in range(60):
            r = subprocess.run(['docker', 'exec', container, 'mongosh', '--quiet', '--eval', 'db.runCommand({ping:1}).ok'], capture_output=True)
            if r.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Isolated Mongo did not become ready')
        run(['docker', 'exec', container, 'mongorestore', '--archive=/source/mongo.archive.gz', '--gzip'], work / 'mongo-restore.log')
        code = 'print(EJSON.stringify(Object.fromEntries(' + json.dumps(mongo['consistencyCollections']) + '.map(n=>[n,db.getCollection(n).find().sort({_id:1}).toArray()]))))'
        target = work / 'mongo-restored.private.ejson'
        run(['docker', 'exec', container, 'mongosh', '--quiet', mongo['database'], '--eval', code], work / 'mongo-compare.log', output=target)
        if json.loads(target.read_text()) != json.loads((work / 'shared-before.private.ejson').read_text()):
            raise RuntimeError('Core memory, versions or embedding profile differ after restore')
        counts['mongoCriticalCollections'] = len(mongo['consistencyCollections'])
    qdrant = config['qdrant']
    image = json_command(['docker', 'inspect', qdrant['container']])[0]['Image']
    node_image = json_command(['docker', 'inspect', qdrant['clientContainer']])[0]['Image']
    name = 'agentx-recovery-qdrant-' + work.name
    with isolated(config, work, name, image, ['./qdrant', '--disable-telemetry', '--storage-snapshot', '/source/qdrant-full-storage.snapshot']) as container:
        for _ in range(60):
            r = subprocess.run(['docker', 'run', '--rm', '--pull=never', '--network', 'container:' + container,
                '--entrypoint', 'node', node_image, '-e', "fetch('http://127.0.0.1:6333/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], capture_output=True)
            if r.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Isolated Qdrant did not become ready')
        output = work / 'qdrant-restored.private.json'
        run(['docker', 'run', '--rm', '--pull=never', '--network', 'container:' + container, '--entrypoint', 'node', node_image, '-e',
            POINT_DIGEST + 'digestAll("http://127.0.0.1:6333").then(x=>console.log(JSON.stringify(x))).catch(()=>process.exitCode=1)'],
            work / 'qdrant-compare.log', output=output)
        actual = json.loads(output.read_text())
        if actual != json.loads((work / 'qdrant-points-before.private.json').read_text()):
            raise RuntimeError('RAG point/vector/payload contents changed during snapshot or failed restoration')
        counts['qdrantCollections'] = len(actual)
        counts['qdrantPoints'] = sum(value['points'] for value in actual.values())
    save(artifacts / 'restore-validation.private.json', {'state': 'passed', 'counts': counts,
         'isolated': True, 'nativeStoresRestored': True, 'liveModelCalls': 0})
