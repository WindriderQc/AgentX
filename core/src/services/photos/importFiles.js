'use strict';

// Filesystem primitives for the native Core photo-import capability. Only
// receiver-owned staging files are writable; candidate originals are read-only.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

async function hashFile(file) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw fail('UNSAFE_FILE', 'Expected a regular file');
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  const after = await fs.lstat(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== before.size) {
    throw fail('FILE_CHANGED', 'File changed during verification');
  }
  return { sha256: hash.digest('hex'), size };
}

async function verify(file, expected) {
  const actual = await hashFile(file);
  if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
    throw fail('COPY_VERIFICATION_FAILED', 'Destination bytes do not match the transferred source');
  }
  return actual;
}

async function syncDir(dir) {
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJson(file, value) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}

// Publish a complete immutable directory. A concurrent winner is never replaced.
async function publishDirectory(temp, target) {
  try { await syncDir(temp); await fs.rename(temp, target); await syncDir(path.dirname(target)); return true; }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    return false;
  }
}

async function safeDirectory(root, relative, mode = 0o700) {
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw fail('UNSAFE_PATH', 'Path leaves the configured import root');
  let current = root;
  for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let created = false;
    try { await fs.mkdir(current, { mode }); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('UNSAFE_PATH', 'Import directories cannot be symlinks');
    // Some NAS ACL policies ignore mode bits on creation. Seal Core-owned
    // private state explicitly, and set new archive modes after creation.
    if (created || mode === 0o700) await fs.chmod(current, mode);
    if (created) await syncDir(path.dirname(current));
  }
  return target;
}

module.exports = { digest, fail, inside, hashFile, verify, syncDir, writeJson, publishDirectory, safeDirectory };
