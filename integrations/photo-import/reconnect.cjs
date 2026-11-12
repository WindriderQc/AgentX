#!/usr/bin/env node
'use strict';
// Explicit read-only recovery when Windows reissues a phone's USB identity.
// The frozen manifest/device key and all cleanup authorization remain unchanged.
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { hashFile, fail, writeJson, publishDirectory, safeDirectory } = require('../../core/src/services/photos/importFiles');
const { id, hash, optional } = require('../../core/src/services/photos/phoneLibrary');
const { createWpd, createRemote, lockCache } = require('./transport.cjs');
// Windows cannot fsync directory handles through Node. Use flushed files and
// atomic immutable directory rename locally; retain NAS POSIX barriers there.
async function localDirectory(root, relative) {
  if (process.platform !== 'win32') return safeDirectory(root, relative);
  let current = root;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..' || /[\\\/]/.test(part)) throw fail('UNSAFE_PATH', 'Invalid local state directory');
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('UNSAFE_PATH', 'Recovery state cannot use links');
  }
  return current;
}
async function publishLocal(temporary, slot) {
  if (process.platform !== 'win32') return publishDirectory(temporary, slot);
  try { await fs.rename(temporary, slot); }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code) || !await optional(path.join(slot, 'binding.json'))) throw error;
  }
}
const same = (a, b) => ['name', 'relativePath', 'size', 'modified'].every(k => a[k] === b[k]);
const identity = state => hash([state.runId, state.deviceId, state.deviceKey,
  state.items.map(({ requestId, key, name, relativePath, size, modified, header }) => ({ requestId, key, name, relativePath, size, modified, ...(header ? { header } : {}) }))]);
async function reconnect(config, input, deps = {}) {
  const runId = id(input.runId), operationId = id(input.operationId);
  if (input.samePhone !== true || typeof input.deviceId !== 'string' || !input.deviceId || input.deviceId.length > 2048)
    throw fail('PHONE_IDENTITY_REQUIRED', 'Explicitly identify the same connected phone before read-only recovery');
  if (!path.isAbsolute(config.cacheRoot || '')) throw fail('INVALID_CONFIGURATION', 'An absolute staging root is required');
  const release = await (deps.lock || lockCache)(path.join(config.cacheRoot, 'phone-workbench.lock'));
  let releaseImport;
  try {
    releaseImport = await (deps.lock || lockCache)(path.join(config.cacheRoot, runId+'.json.lock'));
    const state = JSON.parse(await fs.readFile(path.join(config.cacheRoot, runId+'.json'), 'utf8'));
    if (state.runId !== runId || state.deviceKey !== crypto.createHash('sha256').update(state.deviceId).digest('hex'))
      throw fail('INVALID_CHECKPOINT', 'Original device identity differs');
    const fingerprint = identity(state), parent = await localDirectory(config.cacheRoot, 'source-bindings/'+runId);
    const slot = path.join(parent, operationId), prior = await optional(path.join(slot, 'binding.json'));
    if (prior) {
      if (prior.manifestHash !== fingerprint || prior.deviceId !== input.deviceId)
        throw fail('REQUEST_CONFLICT', 'This recovery identity already selects another source');
      return prior;
    }
    const source = deps.source || createWpd(config.cacheRoot), devices = await source.devices();
    if (!devices.some(d => d.id === input.deviceId)) throw fail('PHONE_UNAVAILABLE', 'The selected phone is unavailable');
    if (input.deviceId === state.deviceId || devices.some(d => d.id === state.deviceId))
      throw fail('PHONE_RECONNECT_NOT_REQUIRED', 'The original phone identity is available; use normal resume');
    const inventory = await source.inventory(input.deviceId);
    if (inventory.complete !== true || inventory.errors?.length)
      throw fail('PHONE_INVENTORY_INCOMPLETE', 'Complete the connected phone inventory before recovery');
    const byPath = new Map();
    for (const file of inventory.files) {
      const rows = byPath.get(file.relativePath) || []; rows.push(file); byPath.set(file.relativePath, rows);
    }
    const current = item => {
      const rows = byPath.get(item.relativePath) || [];
      if (rows.length !== 1 || !same(item, rows[0]))
        throw fail('PHONE_SOURCE_CHANGED', 'A selected source is missing, ambiguous or changed');
      return rows[0];
    };
    // Every still-needed source must retain its frozen facts. Existing backups
    // may be absent from the phone, except for the three explicit hash anchors.
    for (const item of state.items.filter(x => !x.receipt)) current(item);
    const candidates = state.items.filter(x => x.receipt?.sha256 === x.sha256 && /^[a-f0-9]{64}$/.test(x.sha256 || '')
      && x.receipt.size === x.size && x.size > 0 && x.size <= 16 * 1024 * 1024
      && (byPath.get(x.relativePath) || []).length === 1 && same(x, byPath.get(x.relativePath)[0]))
      .sort((a, b) => a.size - b.size);
    const anchors = [...new Map(candidates.map(x => [x.sha256, x])).values()].slice(0, 3);
    if (anchors.length !== 3 || new Set(anchors.map(x => x.sha256)).size !== 3)
      throw fail('PHONE_IDENTITY_UNPROVEN', 'Three distinct verified content anchors are required');
    const remote = deps.remote || createRemote(config);
    const verified = await remote({ action: 'lookupMany' }, { json: { runId, items: anchors.map(item => ({
      requestId: item.requestId, sha256: item.sha256, size: item.size, ...(item.readSource ? { readSource: item.readSource } : {})
    })) } });
    if (verified.runId !== runId || !Array.isArray(verified.results) || verified.results.length !== anchors.length
      || anchors.some(item => !verified.results.some(row => row.requestId === item.requestId && row.runId === runId
        && !row.error && !row.needsUpload && row.sha256 === item.sha256 && row.size === item.size
        && ['copied', 'duplicate'].includes(row.disposition))))
      throw fail('BACKUP_REQUIRED', 'Verify the three canonical Media backups before phone recovery');
    const temporary = await fs.mkdtemp(path.join(parent, '.proof-')), proofs = [];
    try {
      for (const item of anchors) {
        const observed = current(item), target = path.join(temporary, item.requestId+'.media');
        const result = await source.read(input.deviceId, observed, target), bytes = await hashFile(target);
        if (!same(result.source || {}, item) || result.source.key !== observed.key || result.sha256 !== item.sha256
          || result.size !== item.size || bytes.sha256 !== item.sha256 || bytes.size !== item.size)
          throw fail('PHONE_IDENTITY_UNPROVEN', 'Connected phone content differs from its verified backup');
        proofs.push({ requestId: item.requestId, sha256: bytes.sha256, size: bytes.size });
        await fs.rm(target);
      }
      const binding = { schema: 'agentx.photo-source-binding/v1', operationId, runId, manifestHash: fingerprint,
        originalDeviceKey: state.deviceKey, deviceId: input.deviceId, samePhone: true, anchors: proofs,
        phoneReadOnly: true, phoneDeletes: 0, createdAt: new Date().toISOString() };
      await writeJson(path.join(temporary, 'binding.json'), binding);
      await publishLocal(temporary, slot);
      const saved = await optional(path.join(slot, 'binding.json'));
      if (saved.manifestHash !== fingerprint || saved.deviceId !== input.deviceId)
        throw fail('REQUEST_CONFLICT', 'Recovery receipt differs');
      return saved;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  } finally { if (releaseImport) await releaseImport(); await release(); }
}
async function binding(config, state) {
  const parent = path.join(config.cacheRoot, 'source-bindings', id(state.runId));
  let names; try { names = await fs.readdir(parent); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const rows = [];
  for (const name of names.filter(x => /^[a-f0-9-]{36}$/.test(x))) {
    const value = await optional(path.join(parent, name, 'binding.json'));
    if (value?.schema === 'agentx.photo-source-binding/v1' && value.runId === state.runId && value.manifestHash === identity(state)
      && value.originalDeviceKey === state.deviceKey && value.samePhone === true && value.phoneReadOnly === true
      && value.anchors?.length === 3) rows.push(value);
  }
  return rows.sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--command' || !/^[A-Za-z0-9+/]{1,12000}={0,2}$/.test(args[3]))
    throw Error('Use --config absolute-client.json --command base64-recovery-request');
  const config = JSON.parse(await fs.readFile(args[1], 'utf8'));
  const result = await reconnect(config, JSON.parse(Buffer.from(args[3], 'base64')));
  process.stdout.write(JSON.stringify({ ok: true, data: result })+'\n');
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ code: error.code || 'PHONE_RECONNECT_FAILED', message: error.message })); process.exitCode = 1; });
module.exports = { reconnect, binding, identity };
