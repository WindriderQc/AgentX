'use strict';

const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { error } = require('./financeAccess');

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])]));
  return value;
}
function canonical(value) { return JSON.stringify(sorted(plain(value))); }
function hash(value) { return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex'); }
async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function immutable(file, value) {
  const content = `${canonical(value)}\n`;
  const temporary = file + '.' + randomUUID() + '.partial';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const existing = await fs.readFile(file, 'utf8');
    if (existing !== content) throw error('Immutable Finance evidence differs', 'FINANCE_REPAIR_EVIDENCE_CONFLICT', 409);
  } finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function privateRoot(directory) {
  if (!path.isAbsolute(directory || '')) throw error('An absolute private repair root is required', 'FINANCE_REPAIR_ROOT_REQUIRED', 400);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw error('Finance repair root must be a private directory', 'FINANCE_REPAIR_ROOT_UNSAFE', 400);
  }
  const real = await fs.realpath(directory);
  const marker = path.join(real, 'executor.json');
  const temporary = marker + '.' + randomUUID() + '.partial';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ id: randomUUID() })); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, marker);
    await syncDirectory(real);
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  for (const name of ['executor.json', 'executor.lock']) {
    const stat = await fs.lstat(path.join(real, name)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw error('Unsafe Finance executor file', 'FINANCE_REPAIR_ROOT_UNSAFE', 400);
  }
  const { id } = JSON.parse(await fs.readFile(marker, 'utf8'));
  if (!/^[a-f0-9-]{36}$/.test(id || '')) throw error('Invalid Finance executor identity', 'FINANCE_REPAIR_ROOT_UNSAFE', 400);
  return { directory: real, id };
}
async function lock(root) {
  if (process.platform !== 'linux') throw error('Finance repair requires native Linux flock', 'FINANCE_EXECUTOR_LOCK_UNAVAILABLE');
  // The writer itself retains the open file description. flock(1) receives a
  // dup of this FD, locks it and exits; the parent's FD keeps that SAME kernel
  // lock until close/process death. A separate keeper process cannot lose the
  // lock while an old writer is still alive. Mongo also pins this root's ID.
  const handle = await fs.open(path.join(root.directory,'executor.lock'),'a+',0o600);
  let stat, identity;
  try {
  stat = await handle.stat({bigint:true});
  const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
  identity = hash({root:root.id,boot,device:String(stat.dev),inode:String(stat.ino)});
  const child = spawn('flock',['--exclusive','--nonblock','--conflict-exit-code','73','3'],
    {stdio:['ignore','ignore','pipe',handle.fd]});
    await new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(error('Finance executor lock did not answer','FINANCE_EXECUTOR_LOCK_UNCERTAIN'));},5000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(error('Another Finance executor owns the process lock','FINANCE_EXECUTOR_BUSY',409));});
    });
  } catch (e) { await handle.close(); throw e; }
  let alive = true;
  return {
    identity,
    assert() {
      const current = syncFs.lstatSync(path.join(root.directory,'executor.lock'),{bigint:true});
      if (!alive || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
        throw error('Finance executor process lock was lost', 'FINANCE_EXECUTOR_LOCK_UNCERTAIN');
      }
    },
    async release() {
      if (!alive) return;
      alive=false;
      await handle.close();
    }
  };
}
async function verifyOriginal(manifest, archiveRoot) {
  if (!path.isAbsolute(archiveRoot || '')) throw error('Finance archive root is required', 'FINANCE_REPAIR_ARCHIVE_REQUIRED', 400);
  try {
  const root = await fs.realpath(archiveRoot);
  const file = manifest.verifiedIdentity.originalArchivePath;
  const resolved = await fs.realpath(file);
  if (!resolved.startsWith(root + path.sep)) throw error('Original is outside the Finance archive', 'FINANCE_REPAIR_ORIGINAL_INVALID', 400);
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > 25 * 1024 * 1024 || hash(await fs.readFile(resolved)) !== manifest.verifiedIdentity.pdfSha256) {
    throw error('Original Finance PDF differs from the reviewed identity', 'FINANCE_REPAIR_ORIGINAL_CHANGED', 409);
  }
  } catch (e) {
    if (String(e.code).startsWith('FINANCE_')) throw e;
    throw error('Reviewed Finance original is unavailable','FINANCE_REPAIR_ORIGINAL_CHANGED',409);
  }
}

module.exports = { plain, canonical, hash, immutable, privateRoot, lock, verifyOriginal };
