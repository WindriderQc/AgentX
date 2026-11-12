#!/usr/bin/env node
'use strict';

// Bounded stdio API over the instance's existing SSH identity. The receiver is
// a native Core worker, not an HTTP listener or another photo database.
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { createPhotoImportService } = require('../../core/src/services/photos/photoImportService');
const { createImportInventory } = require('../../core/src/services/photos/importInventory');
const { fail } = require('../../core/src/services/photos/importFiles');

async function readRequest(input) {
  const iterator = input[Symbol.asyncIterator]();
  let header = Buffer.alloc(0), rest = Buffer.alloc(0);
  while (true) {
    const next = await iterator.next();
    if (next.done) throw fail('INVALID_PROTOCOL', 'Missing request header');
    const index = next.value.indexOf(10);
    header = Buffer.concat([header, index < 0 ? next.value : next.value.subarray(0, index)]);
    if (header.length > 65536) throw fail('INVALID_PROTOCOL', 'Request header too large');
    if (index >= 0) { rest = next.value.subarray(index + 1); break; }
  }
  const body = Readable.from((async function* () {
    if (rest.length) yield rest;
    while (true) { const next = await iterator.next(); if (next.done) break; yield next.value; }
  })());
  return { header: JSON.parse(header.toString('utf8')), body };
}

async function readJsonBody(body) {
  const chunks = []; let size = 0;
  for await (const chunk of body) {
    if ((size += chunk.length) > 16 * 1024 * 1024) throw fail('INVALID_PROTOCOL', 'Manifest exceeds 16 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serviceFor(config) {
  if (config.expectedDevice !== undefined && (await fs.stat(config.root)).dev !== config.expectedDevice) {
    throw fail('MEDIA_VOLUME_MISMATCH', 'Media filesystem identity changed or is unmounted');
  }
  return createPhotoImportService({ root: config.root, findExisting: createImportInventory(config.inventory || {}) });
}

async function execute(config, header, body) {
  const service = await serviceFor(config);
  switch (header.action) {
    case 'begin': return service.begin(await readJsonBody(body));
    case 'lookup': return service.lookup(header);
    case 'receive': return service.receive(header, body);
    case 'status': return service.status(header);
    case 'library': {
      const library = await require('../../core/src/services/photos/phoneLibrary').createPhoneLibrary(config);
      const cleanup = require('../../core/src/services/photos/phoneCleanup').createPhoneCleanup(library);
      const input = await readJsonBody(body);
      const handlers = { runs: library.list, page: library.page, review: library.setReview, preview: library.preview,
        prepare: cleanup.prepare, plan: x => cleanup.prepared(x.planId), authorize: cleanup.authorize, deleted: cleanup.record, cleanupStatus: cleanup.status };
      if (!Object.hasOwn(handlers, input.op)) throw fail('INVALID_ACTION', 'Unknown phone operation');
      return handlers[input.op](input);
    }
    case 'ping': return { schema: 'agentx.photo-import/v1', ready: true, phoneReadOnly: true };
    default: throw fail('INVALID_ACTION', 'Unknown import action');
  }
}

async function executeBatch(config, plan, directory) {
  if (!Array.isArray(plan.contents) || plan.contents.length > 100000) throw fail('INVALID_PROTOCOL', 'Invalid batch content list');
  const service = await serviceFor(config);
  await service.begin(plan.manifest);
  const errors = [];
  let processed = 0;
  for (const item of plan.contents) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.requestId || '')) throw fail('INVALID_ID', 'Invalid batch request identity');
    const input = { runId: plan.manifest.runId, requestId: item.requestId, size: item.size, sha256: item.sha256 };
    try {
      const existing = await service.lookup(input);
      if (existing.needsUpload) {
        const file = path.join(directory, item.requestId + '.media');
        if (await fs.realpath(file) !== file) throw fail('UNSAFE_PATH', 'Batch payload cannot contain symlinks');
        await service.receive(input, createReadStream(file));
      }
    } catch (error) {
      errors.push({ requestId: item.requestId, code: error.code || 'IMPORT_FAILED', message: error.message });
      if (['INVENTORY_UNAVAILABLE', 'ENOSPC', 'MEDIA_VOLUME_MISMATCH'].includes(error.code)) break;
    }
    if (++processed % 100 === 0) process.stderr.write(`IMPORT_BATCH_PROCESSED ${processed}/${plan.contents.length}\n`);
  }
  return { ...await service.status({ runId: plan.manifest.runId }), errors };
}

async function main() {
  const args = process.argv.slice(2);
  if (![2, 4].includes(args.length) || args[0] !== '--config') throw fail('INVALID_CONFIG', 'Usage: receiver.cjs --config <host-only.json> [--job UUID]');
  const config = JSON.parse(await fs.readFile(args[1], 'utf8'));
  if (args.length === 4) {
    if (!['--job', '--cleanup'].includes(args[2]) || !/^[a-f0-9-]{36}$/.test(args[3]) || !path.isAbsolute(config.transportRoot || '')) throw fail('INVALID_PROTOCOL', 'Invalid native transport envelope');
    const dir = path.join(config.transportRoot, args[3]);
    if (await fs.realpath(dir) !== dir) throw fail('UNSAFE_PATH', 'Transport envelope cannot contain symlinks');
    if (args[2] === '--cleanup') {
      const response = JSON.parse(await fs.readFile(path.join(dir, 'response.json'), 'utf8'));
      if (!response.ok) throw fail('TRANSPORT_UNCERTAIN', 'Only a successful envelope can be cleaned');
      const header = JSON.parse(await fs.readFile(path.join(dir, 'request.json'), 'utf8'));
      if (header.action === 'batch') {
        if (response.data?.state !== 'complete') throw fail('TRANSPORT_UNCERTAIN', 'Incomplete batch payloads remain available for recovery');
        const plan = await readJsonBody(createReadStream(path.join(dir, 'payload.bin')));
        for (const item of plan.contents) {
          if (!/^[a-f0-9-]{36}$/.test(item.requestId || '')) throw fail('INVALID_ID', 'Invalid cleanup identity');
          await fs.rm(path.join(dir, item.requestId + '.media'), { force: true });
        }
      }
      for (const name of ['request.json', 'payload.bin', 'response.json']) await fs.rm(path.join(dir, name), { force: true });
      await fs.rmdir(dir);
      return;
    }
    if ((await fs.stat(path.join(dir, 'request.json'))).size > 65536) throw fail('INVALID_PROTOCOL', 'Request header too large');
    const header = JSON.parse(await fs.readFile(path.join(dir, 'request.json'), 'utf8'));
    const payload = path.join(dir, 'payload.bin');
    let result;
    try {
      const body = ['begin', 'receive', 'batch', 'library'].includes(header.action) ? createReadStream(payload) : Readable.from([]);
      result = { ok: true, data: header.action === 'batch'
        ? await executeBatch(config, await readJsonBody(body), dir) : await execute(config, header, body) };
    } catch (error) { result = { ok: false, error: { code: error.code || 'IMPORT_FAILED', message: error.message } }; }
    const handle = await fs.open(path.join(dir, 'response.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(result) + '\n'); await handle.sync(); } finally { await handle.close(); }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const { header, body } = await readRequest(process.stdin);
  const data = await execute(config, header, body);
  process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
}

if (require.main === module) main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code || 'IMPORT_FAILED', message: error.message } }) + '\n');
  process.exitCode = 1;
});

module.exports = { execute, executeBatch, readRequest };
