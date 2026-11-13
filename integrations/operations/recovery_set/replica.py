"""Verified SSH replication; retain complete generations, never overwrite latest."""
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import uuid

from .common import digest, now, save, verify


# Runs beside the destination, with no dependencies or installed agent. All
# variable arguments are JSON, never shell fragments. Its root marker confines
# pruning to generations created by this protocol.
REMOTE = r'''
import hashlib,json,os,pathlib,shutil,sys,uuid
os.umask(0o077)
action,cfg=sys.argv[1],json.loads(sys.argv[2])
root=pathlib.Path(cfg['root'])
if not root.is_absolute() or root.is_symlink() or len(root.parts)<4:raise ValueError('unsafe replica root')
existed=root.exists()
root.mkdir(parents=True,exist_ok=True,mode=0o700)
marker=root/'.agentx-recovery-root'
if not marker.exists():
 if existed and any(root.iterdir()):raise ValueError('unowned replica root')
 marker.write_text('agentx.recovery-set/v1\n')
if marker.read_text()!='agentx.recovery-set/v1\n':raise ValueError('foreign replica root')
identifier=cfg['generation']
if str(uuid.UUID(identifier))!=identifier:raise ValueError('unsafe generation')
generation=root/'generations'/identifier
incoming=root/('.incoming-'+identifier)
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def verify(p,expected=None):
 if p.is_symlink() or not p.is_dir():raise ValueError('unsafe directory')
 m=p/'manifest.private.json'
 if m.is_symlink() or (expected and sha(m)!=expected):raise ValueError('manifest mismatch')
 d=json.loads(m.read_text())
 if d.get('contract')!='agentx.recovery-set/v1' or d.get('state')!='complete' or d.get('generation')!=p.name.removeprefix('.incoming-'):raise ValueError('incomplete generation')
 seen=set()
 for a in d['artifacts']:
  n=a['file'];f=p/n
  if pathlib.Path(n).name!=n or n in ('.','..','manifest.private.json') or n in seen:raise ValueError('unsafe artifact')
  seen.add(n)
  if f.is_symlink() or not f.is_file() or f.stat().st_size!=a['bytes'] or sha(f)!=a['sha256']:raise ValueError('artifact mismatch')
 if not seen:raise ValueError('empty generation')
 return d
def publish(d):
 value={'generation':identifier,'completedAt':d['completedAt'],'manifestSha256':cfg['manifestSha256']}
 t=root/'latest.private.json.tmp';t.write_text(json.dumps(value));os.replace(t,root/'latest.private.json')
 return {'state':'verified','generation':identifier,'verified':True,'files':len(d['artifacts']),'bytes':sum(a['bytes'] for a in d['artifacts']),'manifestSha256':cfg['manifestSha256']}
def prune(keep):
 directory=root/'generations';directory.mkdir(exist_ok=True,mode=0o700)
 candidates=[]
 for p in directory.iterdir():
  if p.is_symlink() or not p.is_dir():continue
  try:
   if str(uuid.UUID(p.name))!=p.name:continue
   d=json.loads((p/'manifest.private.json').read_text())
   if d.get('contract')!='agentx.recovery-set/v1' or d.get('state')!='complete':continue
   candidates.append((d['completedAt'],p))
  except (ValueError,KeyError,FileNotFoundError):continue
 latest=json.loads((root/'latest.private.json').read_text())['generation'] if (root/'latest.private.json').exists() else None
 retained={p.name for _,p in sorted(candidates,reverse=True)[:keep]}|{identifier,latest}
 for _,p in candidates:
  if p.name not in retained:shutil.rmtree(p)
if generation.exists():
 d=verify(generation,cfg['manifestSha256']);result=publish(d);prune(cfg['keep'])
elif action=='prepare':
 prune(max(1,cfg['keep']-1))
 if shutil.disk_usage(root).free < cfg['bytes']+cfg['minFreeBytes']:raise RuntimeError('insufficient destination space')
 incoming.mkdir(exist_ok=True,mode=0o700)
 if incoming.is_symlink():raise ValueError('unsafe incoming path')
 result={'state':'ready','verified':False}
elif action=='commit':
 d=verify(incoming,cfg['manifestSha256']);generation.parent.mkdir(exist_ok=True,mode=0o700);os.rename(incoming,generation)
 result=publish(d);prune(cfg['keep'])
else:raise ValueError('unsupported replica action')
print(json.dumps(result))
'''


def remote(config, action, arguments):
    target = config['sshTarget']
    if not re.fullmatch(r'[A-Za-z0-9_.@:-]+', target) or target.startswith('-'):
        raise ValueError('Invalid replica SSH target')
    command = shlex.join([config.get('python', 'python3'), '-c', REMOTE, action, json.dumps(arguments)])
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
                             target, command], capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise RuntimeError('Replica destination is unavailable or refused verification; private SSH diagnostics retained by supervisor')
    return json.loads(result.stdout)


def local_retention(root, keep):
    """Remove only acknowledged complete copies; always protect current latest."""
    root = Path(root)
    latest = json.loads((root / 'latest.private.json').read_text())['generation']
    candidates = []
    for path in (root / 'generations').iterdir():
        if path.is_symlink() or not path.is_dir():
            continue
        try:
            if str(uuid.UUID(path.name)) != path.name:
                continue
            manifest = json.loads((path / 'manifest.private.json').read_text())
            receipt = json.loads((root / 'replicas' / (path.name + '.private.json')).read_text())
            if manifest['state'] == 'complete' and receipt.get('verified') is True:
                candidates.append((manifest['completedAt'], path))
        except (ValueError, KeyError, FileNotFoundError):
            continue
    retained = {p.name for _, p in sorted(candidates, reverse=True)[:keep]} | {latest}
    for _, path in candidates:
        if path.name not in retained:
            shutil.rmtree(path)


def replicate(config):
    root = Path(config['root'])
    latest = json.loads((root / 'latest.private.json').read_text())
    identifier = latest['generation']
    if str(uuid.UUID(identifier)) != identifier:
        raise ValueError('Unsafe source generation')
    source = root / 'generations' / identifier
    manifest = verify(source)
    replica = config['replica']
    arguments = {'root': replica['root'], 'generation': identifier,
                 'manifestSha256': digest(source / 'manifest.private.json'),
                 'bytes': sum(a['bytes'] for a in manifest['artifacts']),
                 'keep': max(2, int(replica.get('keep', 2))),
                 'minFreeBytes': max(0, int(replica.get('minFreeBytes', 1024 ** 3)))}
    if arguments['manifestSha256'] != latest['manifestSha256']:
        raise ValueError('Source manifest changed after publication')
    result = remote(replica, 'prepare', arguments)
    if not result.get('verified'):
        # rsync never deletes destination files. A lost transfer resumes the
        # same incoming generation; commit requires every source SHA-256.
        target = replica['sshTarget'] + ':' + shlex.quote(replica['root'].rstrip('/') + '/.incoming-' + identifier + '/')
        result = subprocess.run(['rsync', '-a', '--checksum', '--partial', '--chmod=D700,F600',
                                 '-e', 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8',
                                 str(source) + '/', target], capture_output=True, timeout=3600)
        if result.returncode:
            raise RuntimeError('Replica transfer incomplete; same generation will resume')
        result = remote(replica, 'commit', arguments)
    if result.get('verified') is not True or result.get('manifestSha256') != arguments['manifestSha256']:
        raise ValueError('Replica verification receipt does not match the source')
    receipt = {**result, 'verifiedAt': now(), 'capturedAt': manifest['completedAt']}
    save(root / 'replicas' / (identifier + '.private.json'), receipt)
    save(root / 'replica-latest.private.json', receipt)
    local_retention(root, max(2, int(config.get('keep', 7))))
    return receipt
