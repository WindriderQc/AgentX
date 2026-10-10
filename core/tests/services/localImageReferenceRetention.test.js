'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { calculateObjectSize } = require('bson');
const ImageOperation = require('../../models/ImageOperation');
const { defaultArchive } = require('../../src/services/imageArchive');
const { reference } = require('../../src/services/images/codec');
jest.mock('../../src/services/images/config', () => ({ ...jest.requireActual('../../src/services/images/config'), loadConfig: jest.fn() }));
jest.mock('../../src/services/images/comfyClient', () => ({ createComfyClient: jest.fn() }));
jest.mock('../../src/services/images/gpuReservation', () => ({ reserve: jest.fn() }));
const { loadConfig } = require('../../src/services/images/config');
const { createComfyClient } = require('../../src/services/images/comfyClient');
const { reserve } = require('../../src/services/images/gpuReservation');
const service = require('../../src/services/images/imageService');
const presentation = require('../../src/services/images/workshopPresentation');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const small = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const profile = { family: 'klein', diffusion: 'fixture.safetensors', encoder: 'encoder.safetensors', vae: 'vae.safetensors', steps: 4, maxPixels: 4194304 };
let directory, client, uploads, atSubmit;
let storageModule;
try { storageModule = require('../../src/services/images/referenceStorage'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND' || !error.message.includes("'../../src/services/images/referenceStorage'")) throw error; }
const storage = () => { expect(storageModule).toBeDefined(); return storageModule; };
const body = extra => ({ actionKey: `refs-${crypto.randomUUID()}`, prompt: 'Synthetic reference retention', seed: 42,
  references: [small.toString('base64')], ...extra });
const terminal = async id => {
  for (let i = 0; i < 200; i++) {
    const op = await service.get(id);
    if (['completed', 'failed', 'unknown', 'archive_failed', 'cancelled'].includes(op.state)) return op;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not settle');
};
const archivedFiles = async root => {
  const names = await fs.promises.readdir(root, { withFileTypes: true }); let result = [];
  for (const n of names) {
    const p = path.join(root, n.name);
    if (n.isDirectory()) result = result.concat(await archivedFiles(p)); else result.push(p);
  }
  return result;
};
const prepared = (source = small) => {
  const worker = reference(source);
  return { sources: [source], references: [worker], lineage: { version: 1,
    references: [{ sourceSha256: sha(source), workerSha256: sha(worker), transform: 'decoded-pixels-to-png-v1' }] } };
};
beforeEach(async () => {
  jest.restoreAllMocks(); jest.clearAllMocks(); await ImageOperation.createCollection(); await ImageOperation.deleteMany({});
    await require('../../models/HeavyWorkQueue').deleteMany({});
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-retention-fixture-')); process.env.IMAGE_ARCHIVE_DIR = directory;
  loadConfig.mockReturnValue({ workerUrl: 'http://127.0.0.1:8188', ollamaHosts: ['http://127.0.0.1:11434'], profiles: { quality: profile }, defaultProfile: 'quality' });
  uploads = []; atSubmit = [];
  client = { ready: jest.fn().mockResolvedValue({}), json: jest.fn().mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] }),
    upload: jest.fn(async (bytes, name) => { uploads.push(Buffer.from(bytes)); return name; }),
    submit: jest.fn(async id => { atSubmit.push(await ImageOperation.findById(id).select('+references +referenceStorage +execution').lean()); }),
    observe: jest.fn(async (_id, o) => { await o.onTerminal(); return { filename: 'fixture.png', subfolder: '', type: 'output' }; }),
    read: jest.fn().mockResolvedValue(small), free: jest.fn().mockResolvedValue({}) };
  createComfyClient.mockReturnValue(client);
  reserve.mockResolvedValue({ assertOwned: jest.fn().mockResolvedValue(), verified: jest.fn().mockResolvedValue(),
    restore: jest.fn().mockResolvedValue(), quarantine: jest.fn().mockResolvedValue() });
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); delete process.env.IMAGE_ARCHIVE_DIR; });

test('two admitted 2048-square JPEG references persist lightly and upload the exact retained PNGs', async () => {
  const testStarted = Date.now();
  const width = 2048, height = 2048, data = Buffer.alloc(width * height * 4); let state = 0x12345678;
  for (let i = 0; i < data.length; i += 4) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    data[i] = state & 255; data[i + 1] = (state >>> 8) & 255; data[i + 2] = (state >>> 16) & 255; data[i + 3] = 255;
  }
  const source = jpeg.encode({ width, height, data }, 20).data, base64 = source.toString('base64'), worker = reference(source);
  expect(base64.length).toBeLessThan(3 * 1024 * 1024);
  expect(sha(source)).toBe('6de9b1e3f5872355fec66eda8497ac592982401a418df41b10e9674f18116f25');
  expect(sha(worker)).toBe('fc16be9a523ab01d1a63650e7b62fbc7e1ae3eb92709161d39fe72d671eb3440');
  const inlineBytes = calculateObjectSize({ _id: 'synthetic-envelope-fixture', references: [worker, worker] });
  expect(inlineBytes).toBeGreaterThan(16 * 1024 * 1024);
  console.log(JSON.stringify({ fixture: 'two-2048-JPEG20', sourceBytes: source.length, base64Characters: base64.length,
    workerBytes: worker.length, inlineBsonBytes: inlineBytes }));
  const fixtureMs = Date.now() - testStarted;
  let accepted, error;
  try { accepted = await service.accept(body({ references: [base64, base64] })); } catch (e) { error = e; }
  if (error) console.log(JSON.stringify({ baselineAcceptRejected: true, errorName: error.name, message: error.message }));
  expect(error).toBeUndefined();
  const acceptedMs = Date.now() - testStarted;
  expect((await terminal(accepted.id)).state).toBe('completed');
  const stored = await ImageOperation.findById(accepted.id).select('+references +referenceStorage +execution').lean();
  expect(stored.referenceStorage).toMatchObject({ version: 1, entries: [{ source: { sha256: sha(source), size: source.length }, worker: { sha256: sha(worker), size: worker.length } },
    { source: { sha256: sha(source) }, worker: { sha256: sha(worker) } }] });
  expect(stored.references == null || stored.references.length === 0).toBe(true);
  expect(calculateObjectSize(stored)).toBeLessThan(64 * 1024); expect(atSubmit[0].references == null || atSubmit[0].references.length === 0).toBe(true);
  expect(uploads).toHaveLength(2);
  for (const uploaded of uploads) expect(uploaded.equals(worker)).toBe(true);
  for (const entry of stored.referenceStorage.entries) {
    expect((await defaultArchive().read(entry.source)).bytes.equals(source)).toBe(true);
    expect((await defaultArchive().read(entry.worker)).bytes.equals(worker)).toBe(true);
  }
  expect((await service.get(accepted.id)).referenceStorage).toBeUndefined();
  expect((await presentation.details(accepted.id)).referenceStorage).toBeUndefined();
  console.log(JSON.stringify({ fixture: 'two-2048-JPEG20-completed', fixtureMs, acceptedMs, totalMs: Date.now() - testStarted,
    retainedDocumentBsonBytes: calculateObjectSize(stored), retainedReferences: stored.referenceStorage.entries.length, uploadedReferences: uploads.length }));
}, 300000);

test('the actual retained source/worker receipts survive terminal buffer removal and remain private', async () => {
  const source = jpeg.encode({ width: 2, height: 2, data: Buffer.alloc(16, 255) }, 30).data;
  const accepted = await service.accept(body({ references: [source.toString('base64')] })); await terminal(accepted.id);
  const op = await ImageOperation.findById(accepted.id).select('+references +referenceStorage').lean();
  expect(op.referenceStorage).toBeDefined(); expect(op.references == null || op.references.length === 0).toBe(true);
  const entry = op.referenceStorage.entries[0];
  expect(entry.source.sha256).toBe(sha(source)); expect(entry.worker.sha256).toBe(sha(reference(source)));
  expect(entry.source.sha256).not.toBe(entry.worker.sha256);
  expect((await defaultArchive().read(entry.source)).bytes).toEqual(source);
  expect((await storage().loadReferences(op))[0]).toEqual(reference(source));
  expect((await ImageOperation.findById(accepted.id).lean()).referenceStorage).toBeUndefined();
});
test('an exact prior receipt returns before any archive read/store or new worker after its retained files vanish', async () => {
  const input = body(), accepted = await service.accept(input); await terminal(accepted.id);
  for (const file of await archivedFiles(directory)) await fs.promises.unlink(file);
  const reads = jest.spyOn(fs.promises, 'readFile'), writes = jest.spyOn(fs.promises, 'writeFile'), opens = jest.spyOn(fs.promises, 'open');
  createComfyClient.mockClear(); reserve.mockClear(); client.submit.mockClear();
  expect((await service.accept(input)).id).toBe(accepted.id);
  expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(opens).not.toHaveBeenCalled();
  expect(createComfyClient).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(client.submit).not.toHaveBeenCalled();
});
test('offline readiness keeps orphan source/worker archives without a dormant operation or garbage collection', async () => {
  client.ready.mockRejectedValue(new Error('Fixture offline'));
  await expect(service.accept(body())).rejects.toMatchObject({ statusCode: 503 });
  expect(await ImageOperation.countDocuments()).toBe(0);
  const blobs = (await archivedFiles(directory)).filter(f => !f.endsWith('.json'));
  expect(blobs.length).toBeGreaterThan(0); expect(fs.readFileSync(blobs[0]).length).toBeGreaterThan(0);
  expect(reserve).not.toHaveBeenCalled(); expect(client.submit).not.toHaveBeenCalled();
});
test('an abort after retention keeps blobs and creates no accepted operation', async () => {
  const abort = new AbortController(), write = fs.promises.writeFile.bind(fs.promises);
  jest.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
    const result = await write(...args); if (String(args[0]).startsWith(directory)) abort.abort(); return result;
  });
  let accepted, error;
  try { accepted = await service.accept(body(), { signal: abort.signal }); } catch (e) { error = e; }
  if (accepted) await terminal(accepted.id);
  expect(error).toMatchObject({ name: 'AbortError' });
  expect((await archivedFiles(directory)).length).toBeGreaterThan(0);
  expect(await ImageOperation.countDocuments()).toBe(0); expect(reserve).not.toHaveBeenCalled(); expect(client.submit).not.toHaveBeenCalled();
});
test.each(['omit-storage', 'corrupt-source'])('acknowledged Mongo insert with %s refuses before reservation rather than trusting prepared memory', async mode => {
  const collection = ImageOperation.collection, insert = collection.insertOne.bind(collection); let changed = false;
  jest.spyOn(collection, 'insertOne').mockImplementation(async (doc, ...args) => {
    if (doc.referenceStorage) {
      changed = true;
      if (mode === 'omit-storage') { const copy = { ...doc }; delete copy.referenceStorage; return insert(copy, ...args); }
      const result = await insert(doc, ...args), file = path.join(directory, doc.referenceStorage.entries[0].source.path);
      const corrupted = Buffer.from(fs.readFileSync(file)); corrupted[corrupted.length - 1] ^= 1; fs.writeFileSync(file, corrupted);
      return result;
    }
    return insert(doc, ...args);
  });
  const accepted = await service.accept(body()); const done = await terminal(accepted.id);
  expect(changed).toBe(true); expect(done.state).not.toBe('completed');
  expect(reserve).not.toHaveBeenCalled(); expect(client.upload).not.toHaveBeenCalled(); expect(client.submit).not.toHaveBeenCalled();
});
test('a real legacy lean Mongo buffer remains readable without fabricating storage', async () => {
  const id = crypto.randomUUID();
  await ImageOperation.create({ _id: id, actionKey: `legacy-${id}`, requestHash: sha(id), state: 'unknown', profile: { ...profile, id: 'quality' },
    request: { prompt: 'Synthetic legacy', width: 1024, height: 1024, seed: 1 }, references: [small] });
  const op = await ImageOperation.findById(id).select('+references +referenceStorage').lean();
  expect(op.referenceStorage).toBeUndefined(); expect(await storage().loadReferences(op)).toEqual([small]);
});
test.each([null, {}, { version: 2, entries: [] }, { version: 1, entries: [] }])('declared invalid storage %j refuses despite available legacy bytes', async referenceStorage => {
  await expect(storage().loadReferences({ references: [small], referenceStorage, lineage: prepared().lineage })).rejects.toMatchObject({ statusCode: 503 });
});
test.each(['count', 'source-sha', 'worker-sha', 'width'])('stored reference %s inconsistency refuses instead of using legacy buffers', async mismatch => {
  const p = prepared(), retained = await storage().retainReferences(p), corrupted = JSON.parse(JSON.stringify(retained));
  if (mismatch === 'count') corrupted.entries.push(corrupted.entries[0]);
  if (mismatch === 'source-sha') corrupted.entries[0].source.sha256 = '0'.repeat(64);
  if (mismatch === 'worker-sha') corrupted.entries[0].worker.sha256 = '0'.repeat(64);
  if (mismatch === 'width') corrupted.entries[0].worker.width = 3;
  await expect(storage().loadReferences({ referenceStorage: corrupted, references: [small], lineage: p.lineage })).rejects.toMatchObject({ statusCode: 503 });
});

test('a lost submission keeps the retained inputs without an automatic second submission', async () => {
  client.submit.mockRejectedValue(new Error('Fixture acknowledgement lost'));
  const accepted = await service.accept(body()); expect((await terminal(accepted.id)).state).toBe('unknown');
  const op = await ImageOperation.findById(accepted.id).select('+referenceStorage +references').lean();
  expect(op.referenceStorage).toBeDefined();
  expect(await storage().loadReferences(op)).toEqual([reference(small)]);
  expect(client.submit).toHaveBeenCalledTimes(1);
});
test('a chosen parent retains its existing generated original before the manual reference', async () => {
  const id = crypto.randomUUID(), original = jpeg.encode({ width: 2, height: 2, data: Buffer.alloc(16, 255) }, 30).data;
  const artifact = await defaultArchive().store({ bytes: original, origin: 'generated', name: `${id}.jpg` });
  await ImageOperation.create({ _id: id, actionKey: `parent-${id}`, requestHash: sha(id), state: 'completed', runtimeRestored: true,
    profile: { ...profile, id: 'quality' }, request: { prompt: 'Synthetic parent', width: 1024, height: 1024, seed: 1 },
    artifact: { ...artifact, width: 2, height: 2 } });
  const accepted = await service.accept(body({ parent: { operationId: id, sha256: artifact.sha256 } })); await terminal(accepted.id);
  const op = await ImageOperation.findById(accepted.id).select('+referenceStorage').lean();
  expect(op.referenceStorage).toBeDefined();
  expect(op.referenceStorage.entries.map(entry => entry.source.sha256)).toEqual([sha(original), sha(small)]);
  expect(op.referenceStorage.entries[0].source).toMatchObject({ path: artifact.path, origin: 'generated' });
  expect(uploads).toEqual([reference(original), reference(small)]);
});
