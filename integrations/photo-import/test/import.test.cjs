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
const { runImport } = require('../import.cjs');
const { readRequest, execute } = require('../receiver.cjs');
const { quote } = require('../transport.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

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
  await assert.rejects(createImportInventory({ ...base, fetchImpl: async () => ({ ok: false, status: 503 }) })(f.input), { code: 'INVENTORY_UNAVAILABLE' });
  await assert.rejects(createImportInventory({ ...base, fetchImpl: fetchRows([{ path: '/mnt/photos/../outside.jpg' }]) })(f.input), { code: 'UNSAFE_INVENTORY_PATH' });
  await fs.symlink(path.join(f.root, 'anything'), path.join(candidate, 'escape.jpg'));
  // Existing targets outside the approved root must be refused.
  await fs.writeFile(path.join(f.root, 'anything'), 'hello');
  await assert.rejects(createImportInventory({ ...base, fetchImpl: fetchRows([{ path: '/mnt/photos/escape.jpg' }]) })(f.input), { code: 'UNSAFE_INVENTORY_PATH' });
  await assert.rejects(createImportInventory({ ...base, maxCandidates: 1, fetchImpl: fetchRows([{ path: '/mnt/photos/a.jpg' }, { path: '/mnt/photos/b.jpg' }]) })(f.input), { code: 'INVENTORY_LIMIT' });
  const backup = await createImportInventory({ ...base, fetchImpl: fetchRows([{ path: '/mnt/photos/escape.jpg', storage_role: 'backup_copy' }]) })(f.input);
  assert.equal(backup.path, null);
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
