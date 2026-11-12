'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createPhotoImportService } = require('../../../core/src/services/photos/photoImportService');
const { createImportInventory } = require('../../../core/src/services/photos/importInventory');
const { runImport, checkpoint } = require('../import.cjs');
const { readRequest, execute } = require('../receiver.cjs');
const { quote } = require('../transport.cjs');
const { signatureExtension, classifyInventory } = require('../../../core/src/services/photos/importFormats');
const { executeBatch } = require('../receiver.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('checkpoint contention retries only atomic replacement, keeping the previous durable state until success', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-contention-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'); await checkpoint(file, { verified: 372 });
  const waits = [], paths = [];
  await checkpoint(file, { verified: 373 }, { pause: async ms => waits.push(ms), rename: async (temp, target) => {
    paths.push(temp);
    assert.deepEqual(JSON.parse(await fs.readFile(target)), { verified: 372 });
    assert.deepEqual(JSON.parse(await fs.readFile(temp)), { verified: 373 });
    if (paths.length < 3) throw Object.assign(Error('shared reader'), { code: 'EPERM' });
    await fs.rename(temp, target);
  } });
  assert.deepEqual(waits, [20, 40]); assert.equal(new Set(paths).size, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(file)), { verified: 373 });
  let calls = 0;
  await assert.rejects(checkpoint(file, { verified: 374 }, { pause: async () => {}, rename: async () => {
    calls++; throw Object.assign(Error('persistent contention'), { code: 'EACCES' });
  } }), { code: 'EACCES' });
  assert.equal(calls, 8); assert.deepEqual(JSON.parse(await fs.readFile(file)), { verified: 373 });
  assert.equal((await fs.readdir(dir)).filter(x => x.endsWith('.tmp')).length, 1);
});

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-import-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'media'), cacheRoot = path.join(dir, 'cache');
  await fs.mkdir(root); await fs.mkdir(cacheRoot);
  const service = await createPhotoImportService({ root, ...options });
  const runId = crypto.randomUUID(), requestId = crypto.randomUUID();
  const item = { key: 'storage/dcim/1', name: 'photo.jpg', relativePath: 'Storage/DCIM/photo.jpg', size: 5, modified: null, requestId };
  const manifest = { runId, deviceKey: hash('phone'), coverage: { enumerationComplete: true, remaining: 0 }, sources: [item] };
  const input = { runId, requestId, size: 5, sha256: hash('hello') };
  return { dir, root, cacheRoot, service, manifest, input, item };
}

test('complete source stream is independently read back and replays one immutable receipt', async t => {
  const f = await fixture(t);
  await f.service.begin(f.manifest);
  assert.equal((await f.service.lookup(f.input)).needsUpload, true);
  const result = await f.service.receive(f.input, Readable.from([Buffer.from('hello')]));
  assert.equal(result.disposition, 'copied');
  assert.equal(await fs.readFile(result.path, 'utf8'), 'hello');
  assert.equal((await fs.stat(result.path)).mode & 0o777, 0o644);
  assert.equal((await fs.stat(path.dirname(result.path))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(f.root, '.agentx-import/runs', f.input.runId, 'receipts', f.input.requestId, 'receipt.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await f.service.lookup(f.input), { ...result, reconciled: true });
  assert.equal((await f.service.status(f.input)).state, 'complete');
});

test('interrupted and oversized uploads never publish an original or a success receipt', async t => {
  const f = await fixture(t); await f.service.begin(f.manifest);
  for (const bytes of ['hel', 'hello!']) {
    await assert.rejects(f.service.receive(f.input, Readable.from([Buffer.from(bytes)])), /stream/);
    assert.equal((await f.service.status(f.input)).counts.pending, 1);
  }
  await f.service.receive(f.input, Readable.from([Buffer.from('hello')]));
  assert.equal((await f.service.status(f.input)).state, 'complete');
});

test('request hashes and manifests are frozen before publication', async t => {
  const f = await fixture(t); await f.service.begin(f.manifest);
  await f.service.lookup(f.input);
  await assert.rejects(f.service.lookup({ ...f.input, sha256: hash('other') }), { code: 'REQUEST_CONFLICT' });
  const changed = structuredClone(f.manifest); changed.sources[0].name = 'different.jpg';
  await assert.rejects(f.service.begin(changed), { code: 'REQUEST_CONFLICT' });
});

test('different names/extensions with the same content converge under concurrent publication', async t => {
  const f = await fixture(t);
  const other = { ...f.item, key: 'storage/2', requestId: crypto.randomUUID(), name: 'another.jpeg', relativePath: 'Pictures/another.jpeg' };
  f.manifest.sources.push(other); await f.service.begin(f.manifest);
  const second = { ...f.input, requestId: other.requestId };
  const result = await Promise.all([f.service.receive(f.input, Readable.from(['hello'])), f.service.receive(second, Readable.from(['hello']))]);
  assert.equal(result[0].path, result[1].path);
  assert.deepEqual(result.map(r => r.disposition).sort(), ['copied', 'duplicate']);
});

test('same filename and size with different content preserve both originals', async t => {
  const f = await fixture(t);
  const other = { ...f.item, key: 'storage/2', requestId: crypto.randomUUID(), relativePath: 'Pictures/photo.jpg' };
  f.manifest.sources.push(other); await f.service.begin(f.manifest);
  const a = await f.service.receive(f.input, Readable.from(['hello']));
  const b = await f.service.receive({ ...f.input, requestId: other.requestId, sha256: hash('world') }, Readable.from(['world']));
  assert.notEqual(a.path, b.path);
  assert.equal(await fs.readFile(a.path, 'utf8'), 'hello'); assert.equal(await fs.readFile(b.path, 'utf8'), 'world');
});

test('corruption or loss on Media invalidates resume and status rather than overwriting', async t => {
  const f = await fixture(t); await f.service.begin(f.manifest);
  const result = await f.service.receive(f.input, Readable.from(['hello']));
  await fs.writeFile(result.path, 'world');
  await assert.rejects(f.service.lookup(f.input), { code: 'COPY_VERIFICATION_FAILED' });
  assert.equal((await f.service.status(f.input)).counts.failedVerification, 1);
  assert.equal(await fs.readFile(result.path, 'utf8'), 'world');
});

test('a publication whose receipt was lost is reconciled through the original content owner', async t => {
  const f = await fixture(t); await f.service.begin(f.manifest);
  const result = await f.service.receive(f.input, Readable.from(['hello']));
  await fs.rm(path.join(f.root, '.agentx-import/runs', f.input.runId, 'receipts', f.input.requestId), { recursive: true });
  const recovered = await f.service.lookup(f.input);
  assert.equal(recovered.path, result.path); assert.equal(recovered.disposition, 'copied');
});

test('missing Media, escaped state directories, unsafe ids and wrong volumes fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(createPhotoImportService({ root: path.join(f.dir, 'missing') }), { code: 'ENOENT' });
  const root = path.join(f.dir, 'other'); await fs.mkdir(root);
  await fs.symlink(f.cacheRoot, path.join(root, '.agentx-import'));
  await assert.rejects(createPhotoImportService({ root }), { code: 'UNSAFE_PATH' });
  await assert.rejects(f.service.status({ runId: '../outside' }), { code: 'INVALID_ID' });
  await assert.rejects(execute({ root: f.root, expectedDevice: -1 }, { action: 'ping' }), { code: 'MEDIA_VOLUME_MISMATCH' });
});

test('partial enumeration and explicit file limits remain incomplete in Core', async t => {
  const f = await fixture(t); f.manifest.coverage.remaining = 5;
  await f.service.begin(f.manifest); await f.service.receive(f.input, Readable.from(['hello']));
  const status = await f.service.status(f.input);
  assert.equal(status.state, 'incomplete'); assert.equal(status.counts.pending, 0); assert.equal(status.libraryCoverageComplete, false);
});

test('existing indexed copies are rehashed; backups, stale hashes and same-size differences are handled', async t => {
  const f = await fixture(t);
  const existing = path.join(f.dir, 'existing'); await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, 'one.jpg'), 'world');
  await fs.writeFile(path.join(existing, 'two.jpg'), 'hello');
  const findExisting = createImportInventory({ coreUrl: 'http://core.example', mappings: [{ indexedRoot: '/mnt/photos', physicalRoot: existing }], fetchImpl: async () => ({ ok: true, json: async () => ({ data: { pagination: { pages: 1 }, files: [
    { path: '/mnt/photos/one.jpg', sha256: hash('hello') }, { path: '/mnt/photos/two.jpg', sha256: null }
  ] } }) }) });
  const service = await createPhotoImportService({ root: f.root, findExisting });
  await service.begin(f.manifest);
  const result = await service.lookup(f.input);
  assert.equal(result.disposition, 'duplicate'); assert.equal(result.path, path.join(existing, 'two.jpg'));
  assert.equal((await fs.readdir(path.join(f.root, 'Originals'))).length, 0);
});

test('inventory refuses unavailable service, candidate bounds, traversal and symlinks', async t => {
  const f = await fixture(t); const candidate = path.join(f.dir, 'candidate'); await fs.mkdir(candidate);
  const base = { coreUrl: 'http://core.example', mappings: [{ indexedRoot: '/mnt/photos', physicalRoot: candidate }] };
  const fetchRows = rows => async () => ({ ok: true, json: async () => ({ data: { files: rows, pagination: { pages: 1 } } }) });
  await assert.rejects(createImportInventory({ ...base, retryWindowMs: 0, fetchImpl: async () => ({ ok: false, status: 503 }) })(f.input), { code: 'INVENTORY_UNAVAILABLE' });
  await assert.rejects(createImportInventory({ ...base, fetchImpl: fetchRows([{ path: '/mnt/photos/../outside.jpg' }]) })(f.input), { code: 'UNSAFE_INVENTORY_PATH' });
  await fs.symlink(path.join(f.root, 'anything'), path.join(candidate, 'escape.jpg'));
  // Existing targets outside the approved root must be refused.
  await fs.writeFile(path.join(f.root, 'anything'), 'hello');
  await assert.rejects(createImportInventory({ ...base, fetchImpl: fetchRows([{ path: '/mnt/photos/escape.jpg' }]) })(f.input), { code: 'UNSAFE_INVENTORY_PATH' });
  await assert.rejects(createImportInventory({ ...base, maxCandidates: 1, fetchImpl: fetchRows([{ path: '/mnt/photos/a.jpg' }, { path: '/mnt/photos/b.jpg' }]) })(f.input), { code: 'INVENTORY_LIMIT' });
  const backup = await createImportInventory({ ...base, fetchImpl: fetchRows([{ path: '/mnt/photos/escape.jpg', storage_role: 'backup_copy' }]) })(f.input);
  assert.equal(backup.path, null);
});

test('native imports can read Data directly while Core is absent and survive a transient inventory outage', async t => {
  const f = await fixture(t), existing = path.join(f.dir, 'prior');
  await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'photo.jpg'), 'hello');
  let clock = 0, calls = 0;
  const requests = [];
  const lookup = createImportInventory({ dataUrl: 'http://data.example',
    mappings: [{ indexedRoot: '/mnt/photos', physicalRoot: existing }],
    retryWindowMs: 1500, now: () => clock, pause: async ms => { clock += ms; },
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), method: options.method || 'GET' });
      if (++calls === 1) return { ok: false, status: 503 };
      if (calls === 2) throw new TypeError('fetch failed');
      return { ok: true, json: async () => ({ data: { pagination: { pages: 1 },
        files: [{ path: '/mnt/photos/photo.jpg', size: 5 }] } }) };
    } });
  assert.equal((await lookup(f.input)).path, path.join(existing, 'photo.jpg'));
  assert.equal(calls, 3);
  assert.equal(new Set(requests.map(r => r.url)).size, 1);
  assert.ok(requests.every(r => r.url.startsWith('http://data.example/api/v1/storage/files/browse?') && r.method === 'GET'));
  assert.throws(() => createImportInventory({ coreUrl: 'http://core.example', dataUrl: 'http://data.example' }), { code: 'INVALID_CONFIG' });
});

test('a persistent inventory outage stays pending instead of declaring no duplicates', async t => {
  const f = await fixture(t); let clock = 0, calls = 0;
  const lookup = createImportInventory({ dataUrl: 'http://data.example',
    mappings: [{ indexedRoot: '/mnt/photos', physicalRoot: f.root }],
    retryWindowMs: 1000, now: () => clock, pause: async ms => { clock += ms; },
    fetchImpl: async () => { calls++; return { ok: false, status: 503 }; } });
  await assert.rejects(lookup(f.input), { code: 'INVENTORY_UNAVAILABLE' });
  assert.equal(calls, 3);
});

test('stdio framing preserves bytes split across headers and refuses oversized headers', async () => {
  const request = await readRequest(Readable.from([Buffer.from('{"action":"rec'), Buffer.from('eive"}\nhe'), Buffer.from('llo')]));
  assert.equal(request.header.action, 'receive');
  let body = ''; for await (const chunk of request.body) body += chunk;
  assert.equal(body, 'hello');
  await assert.rejects(readRequest(Readable.from([Buffer.alloc(65537, 65)])), { code: 'INVALID_PROTOCOL' });
  assert.equal(quote("a'b;$()"), "'a'\\''b;$()'");
});

test('native file envelopes publish a durable response and clean only their own successful files', async t => {
  const f = await fixture(t);
  const jobs = path.join(f.dir, 'transport'); await fs.mkdir(jobs);
  const config = path.join(f.dir, 'receiver.json'); await fs.writeFile(config, JSON.stringify({ root: f.root, transportRoot: jobs }));
  const receiver = path.resolve(__dirname, '../receiver.cjs');
  const run = async (header, payload) => {
    const job = crypto.randomUUID(), dir = path.join(jobs, job); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify(header));
    if (payload) await fs.writeFile(path.join(dir, 'payload.bin'), payload);
    require('node:child_process').execFileSync(process.execPath, [receiver, '--config', config, '--job', job]);
    const result = JSON.parse(await fs.readFile(path.join(dir, 'response.json'), 'utf8'));
    require('node:child_process').execFileSync(process.execPath, [receiver, '--config', config, '--cleanup', job]);
    assert.equal(await fs.stat(dir).then(() => true, () => false), false);
    return result.data;
  };
  await run({ action: 'begin' }, JSON.stringify(f.manifest));
  const result = await run({ action: 'receive', ...f.input }, 'hello');
  assert.equal(result.disposition, 'copied');
  assert.equal((await f.service.lookup(f.input)).path, result.path);
});

test('signatures recover extensionless/cache images without guessing from arbitrary text', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex').toString('base64');
  assert.equal(signatureExtension(png), '.png');
  assert.equal(signatureExtension(Buffer.from('not a picture').toString('base64')), null);
  assert.equal(signatureExtension('not base64'), null);
  const files = [{ objectId: '1', key: '1', name: 'cache.file', size: 16 }, { objectId: '2', key: '2', name: 'picture.jpg', size: 16 }, { objectId: '3', key: '3', name: 'noextension', size: 10 }];
  const audit = classifyInventory(files, [{ objectId: '1', header: png }, { objectId: '3', header: Buffer.from('plain text').toString('base64') }]);
  assert.equal(audit.selected.length, 2); assert.equal(audit.signatureMatches, 1); assert.equal(audit.nonMedia, 1); assert.equal(audit.signatureAuditComplete, true);
  assert.equal(classifyInventory(files, []).signatureAuditComplete, false);
  assert.equal(classifyInventory(files, [{ objectId: '1', header: '' }]).errors.length, 1);
});

test('a signature-selected original retains its original name in provenance and verifies the prefix', async t => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(64); Buffer.from('ffd8ffe1', 'hex').copy(bytes);
  f.manifest.sources[0] = { ...f.item, name: 'image.file', size: 64, header: bytes.toString('base64') };
  await f.service.begin(f.manifest);
  const input = { ...f.input, size: 64, sha256: hash(bytes) };
  const result = await f.service.receive(input, Readable.from([bytes]));
  assert.match(result.path, /original\.jpg$/); assert.equal(result.source.name, 'image.file');
  const g = await fixture(t);g.manifest.sources[0] = { ...g.item, name: 'image.file', size: 64, header: bytes.toString('base64') };
  await g.service.begin(g.manifest);
  const changed = Buffer.from(bytes);changed[8] = 1;
  await assert.rejects(g.service.receive({ ...g.input, size: 64, sha256: hash(changed) }, Readable.from([changed])), { code: 'SOURCE_FORMAT_CHANGED' });
});

test('batch transfer keeps canonical resume and exact duplicate semantics with missing payloads', async t => {
  const f = await fixture(t); const directory = path.join(f.dir, 'batch'); await fs.mkdir(directory);
  const other = { ...f.item, key: 'two', requestId: crypto.randomUUID(), relativePath: 'Pictures/other.jpg' };
  f.manifest.sources.push(other);
  const plan = { manifest: f.manifest, contents: [f.input, { ...f.input, requestId: other.requestId }] };
  await fs.writeFile(path.join(directory, f.input.requestId + '.media'), 'hello');
  // A duplicate is resolved through Core and needs no second transported file.
  const result = await executeBatch({ root: f.root }, plan, directory);
  assert.equal(result.state, 'complete'); assert.equal(result.counts.copied, 1); assert.equal(result.counts.duplicates, 1);
  await fs.rm(path.join(directory, f.input.requestId + '.media'));
  const resumed = await executeBatch({ root: f.root }, plan, directory);
  assert.deepEqual(resumed.counts, result.counts);
});

function sourceAdapter(files) {
  let reads = 0;
  const source = {
    devices: async () => [{ id: 'phone' }],
    inventory: async () => ({ complete: true, errors: [], objectsVisited: files.length, files: files.map((bytes, i) => ({ objectId: String(i), key: 'source-'+i, name: 'photo.jpg', relativePath: 'DCIM/'+i+'/photo.jpg', size: Buffer.byteLength(bytes), modified: null })) }),
    read: async (device, item, destination) => { reads++; const bytes = files[Number(item.objectId)]; await fs.writeFile(destination, bytes, { flag: 'wx' }); return { size: Buffer.byteLength(bytes), sha256: hash(bytes), source: item }; },
    get reads() { return reads; }
  };
  return source;
}

function remoteAdapter(service) {
  return async (input, body) => {
    if (input.action === 'begin') return service.begin(body.json);
    if (input.action === 'receive') return service.receive(input, require('node:fs').createReadStream(body.file));
    return service[input.action](input);
  };
}

test('native client imports all media, dedupes exact content and resumes without touching the phone', async t => {
  const f = await fixture(t), source = sourceAdapter(['hello','hello','world']);
  const remote = remoteAdapter(f.service), config = { cacheRoot: f.cacheRoot };
  const result = await runImport(config, { source, remote, log: () => {} });
  assert.equal(result.state, 'complete'); assert.equal(result.counts.copied, 2); assert.equal(result.counts.duplicates, 1);
  const again = await runImport(config, { source, remote, resume: result.runId, log: () => {} });
  assert.equal(again.state, 'complete'); assert.equal(source.reads, 3);
});

test('lost upload acknowledgment reconciles the same request with the phone disconnected', async t => {
  const f = await fixture(t), source = sourceAdapter(['hello']);
  const original = remoteAdapter(f.service); let lost = true;
  const remote = async (input, body) => {
    const answer = await original(input, body);
    if (input.action === 'receive' && lost) { lost = false; throw new Error('SSH response lost'); }
    return answer;
  };
  const config = { cacheRoot: f.cacheRoot };
  const first = await runImport(config, { source, remote, log: () => {} });
  source.inventory = async () => { throw new Error('Phone disconnected'); };
  const resumed = await runImport(config, { source, remote, resume: first.runId, log: () => {} });
  assert.equal(resumed.state, 'complete'); assert.equal(resumed.counts.copied, 1); assert.equal(source.reads, 1);
});

test('an interrupted upload keeps a verified local spool and resumes without a new phone read', async t => {
  const f = await fixture(t), source = sourceAdapter(['hello']);
  const original = remoteAdapter(f.service); let interrupted = true;
  const remote = async (input, body) => {
    if (input.action === 'receive' && interrupted) { interrupted = false; throw new Error('Network disconnected'); }
    return original(input, body);
  };
  const config = { cacheRoot: f.cacheRoot };
  const first = await runImport(config, { source, remote, log: () => {} });
  assert.equal(first.state, 'incomplete');
  source.inventory = async () => { throw new Error('Phone disconnected'); };
  const resumed = await runImport(config, { source, remote, resume: first.runId, log: () => {} });
  assert.equal(resumed.state, 'complete'); assert.equal(source.reads, 1);
});

test('source identity or stream mismatch remains incomplete and never records a successful copy', async t => {
  const f = await fixture(t), source = sourceAdapter(['hello']);
  const read = source.read; source.read = async (...args) => ({ ...await read(...args), sha256: hash('wrong') });
  const result = await runImport({ cacheRoot: f.cacheRoot }, { source, remote: remoteAdapter(f.service), log: () => {} });
  assert.equal(result.state, 'incomplete'); assert.equal(result.counts.pending, 1);
  assert.equal((await fs.readdir(path.join(f.root, 'Originals'))).length, 0);
});

test('same-run recovery tolerates reissued WPD keys while preserving frozen selections and verified receipts', async t => {
  const f = await fixture(t), source = sourceAdapter(['hello', 'world']);
  const remote = remoteAdapter(f.service), config = { cacheRoot: f.cacheRoot };
  const read = source.read;
  source.read = async (...args) => {
    if (args[1].objectId === '1') throw new Error('USB disconnected before read');
    return read(...args);
  };
  const first = await runImport(config, { source, remote, log: () => {} });
  assert.equal(first.counts.copied, 1);
  const inventory = source.inventory;
  source.inventory = async () => ({ ...await inventory(), files: (await inventory()).files.map(item => ({
    ...item, key: 'reissued-' + item.key, objectId: 'new-' + item.objectId
  })) });
  source.read = async (device, item, destination) => {
    assert.equal(item.key, 'reissued-source-1');
    return { ...await read(device, { ...item, objectId: item.objectId.replace('new-', '') }, destination), source: item };
  };
  const result = await runImport(config, { source, remote, resume: first.runId, log: () => {} });
  assert.equal(result.runId, first.runId); assert.equal(result.state, 'complete');
  assert.equal(source.reads, 2);
  const state = JSON.parse(await fs.readFile(path.join(f.cacheRoot, first.runId + '.json')));
  const item = state.items[1];
  assert.equal(item.key, 'source-1'); assert.equal(item.receipt.source.key, item.key);
  assert.equal(item.receipt.readSource.key, 'reissued-source-1');
  assert.equal(item.receipt.sourceReassociated, true);
  assert.equal(await fs.readFile(item.receipt.path, 'utf8'), 'world');
  assert.equal((await f.service.lookup({ runId: result.runId, requestId: item.requestId, size: item.size, sha256: item.sha256 })).readSource.key, 'reissued-source-1');
});

test('reassociation refuses ambiguous paths or changed source metadata before reading', async t => {
  for (const change of ['ambiguous', 'name', 'size', 'modified']) {
    const f = await fixture(t), source = sourceAdapter(['hello']);
    const inventory = source.inventory, read = source.read;
    source.read = async () => { throw new Error('disconnected'); };
    const options = { source, remote: remoteAdapter(f.service), log: () => {} };
    const first = await runImport({ cacheRoot: f.cacheRoot }, options);
    source.inventory = async () => {
      const value = await inventory();
      if (change === 'ambiguous') value.files.push({ ...value.files[0], key: 'other' });
      else value.files[0][change] = change === 'size' ? 6 : 'different';
      return value;
    };
    source.read = read;
    const resumed = await runImport({ cacheRoot: f.cacheRoot }, { ...options, resume: first.runId });
    assert.equal(resumed.state, 'incomplete', change); assert.equal(source.reads, 0, change);
    assert.match(resumed.failures[0].message, /changed or is unavailable/);
  }
});

test('a reissued key cannot replace an already frozen content hash', async t => {
  const f = await fixture(t), source = sourceAdapter(['hello']);
  const original = remoteAdapter(f.service);
  const first = await runImport({ cacheRoot: f.cacheRoot }, { source, remote: async (input, body) => {
    if (input.action === 'receive') throw new Error('network interrupted');
    return original(input, body);
  }, log: () => {} });
  const state = JSON.parse(await fs.readFile(path.join(f.cacheRoot, first.runId + '.json')));
  await fs.rm(path.join(f.cacheRoot, state.items[0].requestId + '.media'));
  const inventory = source.inventory;
  source.inventory = async () => {
    const value = await inventory(); value.files[0].key = 'new-key'; return value;
  };
  source.read = async (device, item, destination) => {
    await fs.writeFile(destination, 'world'); return { size: 5, sha256: hash('world'), source: item };
  };
  const resumed = await runImport({ cacheRoot: f.cacheRoot }, { source, remote: original, resume: first.runId, log: () => {} });
  assert.match(resumed.failures[0].message, /original request hash remains frozen/);
  assert.equal(resumed.counts.pending, 1); assert.equal(resumed.counts.copied, 0);
});

test('the source observed at stream read must match every selected metadata field', async t => {
  for (const field of ['key', 'name', 'relativePath', 'size', 'modified']) {
    const f = await fixture(t), source = sourceAdapter(['hello']);
    const read = source.read;
    source.read = async (...args) => {
      const result = await read(...args); return { ...result, source: { ...result.source, [field]: field === 'size' ? 6 : 'different' } };
    };
    const result = await runImport({ cacheRoot: f.cacheRoot }, { source, remote: remoteAdapter(f.service), log: () => {} });
    assert.equal(result.counts.pending, 1, field); assert.match(result.failures[0].message, /verification failed/);
  }
});

test('receiver freezes read observations independently of the immutable original manifest', async t => {
  const f = await fixture(t); await f.service.begin(f.manifest);
  const { requestId, ...readSource } = { ...f.item, key: 'reissued' };
  const input = { ...f.input, readSource };
  await f.service.lookup(input);
  await assert.rejects(f.service.lookup({ ...input, readSource: { ...readSource, key: 'another' } }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(f.service.lookup({ ...input, readSource: { ...readSource, relativePath: 'other/photo.jpg' } }), { code: 'SOURCE_CHANGED' });
  const result = await f.service.receive(f.input, Readable.from(['hello']));
  assert.equal(result.source.key, f.item.key); assert.equal(result.readSource.key, readSource.key);
  assert.equal(result.sourceReassociated, true);
});
