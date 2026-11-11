#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { MEDIA } = require('../../core/src/services/photos/photoImportService');
const { classifyInventory } = require('../../core/src/services/photos/importFormats');
const { hashFile } = require('../../core/src/services/photos/importFiles');
const { createRemote, createWpd, lockCache } = require('./transport.cjs');

const SHA = value => crypto.createHash('sha256').update(value).digest('hex');
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');

async function checkpoint(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, file);
}

async function runImport(config, { source, remote, deviceId, resume, limit = 100000, log = console.log } = {}) {
  if (!path.isAbsolute(config.cacheRoot || '')) throw new Error('cacheRoot must be an absolute local staging directory');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('limit must be 1–100000');
  await fs.mkdir(config.cacheRoot, { recursive: true, mode: 0o700 });
  source ||= createWpd(config.cacheRoot);
  remote ||= createRemote(config);
  let state, stateFile, currentInventory;
  if (resume) {
    if (!uuid(resume)) throw new Error('Invalid resume UUID');
    stateFile = path.join(config.cacheRoot, resume + '.json');
    state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (state.runId !== resume) throw new Error('Checkpoint identity mismatch');
    if (deviceId && SHA(deviceId) !== state.deviceKey) throw new Error('Selected phone differs from checkpoint');
    deviceId ||= state.deviceId;
  } else {
    const devices = await source.devices();
    if (!deviceId) {
      if (devices.length !== 1) throw new Error(devices.length ? 'Several WPD devices: select --device explicitly' : 'No WPD device. Unlock Android and select USB file transfer, then retry.');
      deviceId = devices[0].id;
    }
    if (!devices.some(d => d.id === deviceId)) throw new Error('Selected WPD device is unavailable');
    log('Lecture de l’inventaire USB en cours; le téléphone reste en lecture seule.');
    const inventory = await source.inventory(deviceId);
    currentInventory = inventory;
    const unknown = inventory.files.filter(item => item.size > 0 && !MEDIA.test(item.name));
    const prefixes = unknown.length && source.prefixes ? await source.prefixes(deviceId,
      unknown.map(({ objectId, key, size, modified }) => ({ objectId, key, size, modified })),
      path.join(config.cacheRoot, 'wpd-prefix-' + SHA(deviceId) + '.jsonl')) : { entries: [] };
    const audit = classifyInventory(inventory.files, prefixes.entries);
    const selected = audit.selected;
    if (!selected.length) throw new Error('No readable media exposed by USB. Check phone unlock/file-transfer mode.');
    const runId = crypto.randomUUID();
    const coverage = { transport: 'windows-wpd-mtp-read-only', enumerationComplete: inventory.complete,
      enumerationErrors: inventory.errors, objectsVisited: inventory.objectsVisited,
      mediaFound: selected.length, selected: Math.min(limit, selected.length), remaining: Math.max(0, selected.length - limit),
      signatureAuditComplete: audit.signatureAuditComplete, signatureMatches: audit.signatureMatches,
      signatureErrors: audit.errors, unprobedFiles: audit.unprobed,
      inaccessibleScope: 'App-private and cloud-only originals are not available through this USB inventory.' };
    state = { schema: 'agentx.photo-import-client/v1', runId, deviceId, deviceKey: SHA(deviceId), coverage,
      items: selected.slice(0, limit).map(item => ({ ...item, requestId: crypto.randomUUID() })) };
    stateFile = path.join(config.cacheRoot, runId + '.json');
    await checkpoint(stateFile, state);
  }
  // Host/configuration are transport choices, never persisted replacements for
  // Core receipts. A retry keeps the frozen run, source and request identities.
  const manifest = { runId: state.runId, deviceKey: state.deviceKey, coverage: state.coverage,
    sources: state.items.map(({ requestId, key, name, relativePath, size, modified, header }) => ({ requestId, key, name, relativePath, size, modified, ...(header ? { header } : {}) })) };
  log(`Import ${state.runId}: ${state.items.length} fichier(s). Reprise: --resume ${state.runId}`);
  await remote({ action: 'begin' }, { json: manifest });
  // Refuse concurrent local transport sessions without stealing an old lock.
  const lockFile = stateFile + '.lock';
  const releaseLock = await lockCache(lockFile);
  const failures = [];
  try {
    for (const item of state.items) {
      const spool = path.join(config.cacheRoot, item.requestId + '.media');
      try {
        let known = item.sha256 ? await remote({ action: 'lookup', runId: state.runId, requestId: item.requestId, size: item.size, sha256: item.sha256 }) : null;
        if (!known || known.needsUpload) {
          let local;
          try { local = await hashFile(spool); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (!local || !item.sha256 || local.sha256 !== item.sha256 || local.size !== item.size) {
            // A local partial has no successful WPD receipt. Preserve it for
            // diagnosis and use a fresh path; never trust its size alone.
            if (local) await fs.rename(spool, spool + '.incomplete-' + crypto.randomUUID());
            currentInventory ||= await source.inventory(deviceId);
            const candidates = currentInventory.files.filter(s => s.key === item.key && s.relativePath === item.relativePath);
            if (candidates.length !== 1 || candidates[0].size !== item.size || candidates[0].modified !== item.modified) throw new Error('Phone source changed or is unavailable; start a new run for changed content');
            const result = await source.read(deviceId, candidates[0], spool);
            local = await hashFile(spool);
            if (result.size !== item.size || result.sha256 !== local.sha256 || local.size !== item.size || result.source.key !== item.key || result.source.modified !== item.modified) throw new Error('WPD stream/source verification failed');
            if (item.sha256 && item.sha256 !== local.sha256) throw new Error('Source content changed; the original request hash remains frozen');
            item.sha256 = local.sha256;
            await checkpoint(stateFile, state);
          }
          const input = { runId: state.runId, requestId: item.requestId, size: item.size, sha256: item.sha256 };
          known = await remote({ action: 'lookup', ...input });
          if (known.needsUpload) known = await remote({ action: 'receive', ...input }, { file: spool });
        }
        if (known.runId !== state.runId || known.requestId !== item.requestId || known.sha256 !== item.sha256 || known.size !== item.size || !['copied', 'duplicate'].includes(known.disposition)) throw new Error('Invalid receiver verification receipt');
        item.receipt = known;
        delete item.error;
        await checkpoint(stateFile, state);
        await fs.rm(spool, { force: true });
        log(`${known.disposition === 'copied' ? 'Vérifié sur Media' : 'Doublon vérifié, copie évitée'}: ${item.relativePath}`);
      } catch (error) {
        item.error = { code: error.code || 'TRANSPORT_OR_SOURCE_FAILED', message: error.message };
        await checkpoint(stateFile, state);
        failures.push({ requestId: item.requestId, ...item.error });
        log(`Incomplet: ${item.relativePath}: ${error.message}`);
        // Connection failures leave the exact original identity pending; do not
        // walk the entire phone or launch replacement effects after uncertainty.
        break;
      }
    }
    const result = await remote({ action: 'status', runId: state.runId });
    result.failures = failures;
    state.lastResult = result;
    await checkpoint(stateFile, state);
    return result;
  } finally { await releaseLock(); }
}

async function main() {
  const values = process.argv.slice(2), args = {};
  for (let i = 0; i < values.length; i += 2) {
    if (!['--config', '--device', '--resume', '--limit'].includes(values[i]) || !values[i + 1]) throw new Error('Usage: import.cjs --config file [--device id] [--resume UUID] [--limit 100000]');
    args[values[i].slice(2)] = values[i + 1];
  }
  if (!args.config) throw new Error('--config is required');
  const config = JSON.parse(await fs.readFile(args.config, 'utf8'));
  const result = await runImport(config, { deviceId: args.device, resume: args.resume, limit: Number(args.limit || 100000) });
  console.log(JSON.stringify(result, null, 2));
  if (result.state !== 'complete') process.exitCode = 2;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runImport, checkpoint };
