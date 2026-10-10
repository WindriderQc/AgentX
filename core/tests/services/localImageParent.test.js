'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
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
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pixels = { width: 2, height: 2, data: Buffer.alloc(16, 255) };
const original = jpeg.encode(pixels, 90).data;
const output = PNG.sync.write(pixels);
const profile = { family: 'klein', diffusion: 'diffusion.safetensors', encoder: 'encoder.safetensors',
  vae: 'vae.safetensors', steps: 4, maxPixels: 4194304, label: 'Fixture' };
const scope = { surface: 'household', sessionId: 'fixture-session', packId: 'fixture-pack', scopeId: 'family' };

describe('server-verified archived image parents', () => {
  let directory, client;
  async function parent(extra = {}, bytes = original) {
    const id = crypto.randomUUID();
    const artifact = await defaultArchive().store({ bytes, name: `${id}.jpg`, origin: 'generated', context: {} });
    const op = await ImageOperation.create({ _id: id, actionKey: `parent-${id}`, requestHash: sha(id),
      state: 'completed', runtimeRestored: true, profile: { ...profile, id: 'quality' },
      request: { prompt: 'Fixture parent', seed: 3, width: 1024, height: 1024 },
      artifact: { ...artifact, width: 2, height: 2 }, ...extra });
    return op.toObject();
  }
  const body = (p, extra = {}) => ({ actionKey: `child-${crypto.randomUUID()}`, prompt: 'Keep the scene, add a tree',
    seed: 42, parent: { operationId: p._id, sha256: p.artifact.sha256 }, ...extra });
  async function completed(id) {
    for (let i = 0; i < 100; i++) {
      const op = await service.get(id);
      if (op.state === 'completed') return op;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Child not completed: ${JSON.stringify(await service.get(id))}`);
  }
  async function refused(input, statusCode, options) {
    await expect(service.accept(input, options)).rejects.toMatchObject({ statusCode });
    expect(createComfyClient).not.toHaveBeenCalled();
    expect(client.ready).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
  }
  beforeEach(async () => {
    jest.clearAllMocks();
    await ImageOperation.createCollection();
    await ImageOperation.deleteMany({});
    await require('../../models/HeavyWorkQueue').deleteMany({});
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-parent-fixture-'));
    process.env.IMAGE_ARCHIVE_DIR = directory;
    loadConfig.mockReturnValue({ workerUrl: 'http://127.0.0.1:8188', ollamaHosts: ['http://127.0.0.1:11434'], profiles: { quality: profile }, defaultProfile: 'quality' });
    client = { ready: jest.fn().mockResolvedValue({}), json: jest.fn().mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] }),
      upload: jest.fn().mockImplementation(async (_bytes, name) => name), submit: jest.fn().mockResolvedValue({}),
      observe: jest.fn().mockImplementation(async (_id, options) => { await options.onTerminal(); return { filename: 'fixture.png', subfolder: '', type: 'output' }; }),
      read: jest.fn().mockResolvedValue(output), free: jest.fn().mockResolvedValue({}) };
    createComfyClient.mockReturnValue(client);
    reserve.mockResolvedValue({ assertOwned: jest.fn().mockResolvedValue(), verified: jest.fn().mockResolvedValue(),
      restore: jest.fn().mockResolvedValue(), quarantine: jest.fn().mockResolvedValue() });
  });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); delete process.env.IMAGE_ARCHIVE_DIR; });

  test('uses the verified server original and keeps source and worker hashes after completion', async () => {
    const p = await parent(), input = body(p);
    const child = await service.accept(input); await completed(child.id);
    const derived = reference(original);
    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(client.upload.mock.calls[0][0]).toEqual(derived);
    expect(sha(derived)).not.toBe(p.artifact.sha256);
    const stored = await ImageOperation.findById(child.id).select('+references').lean();
    expect(stored.lineage).toMatchObject({ version: 1, parent: { operationId: p._id, sha256: sha(original), width: 2, height: 2 },
      references: [{ sourceSha256: sha(original), workerSha256: sha(derived), transform: 'decoded-pixels-to-png-v1', parentOperationId: p._id }] });
    expect(stored.references == null || stored.references.length === 0).toBe(true);
    expect((await service.image(p._id)).bytes).toEqual(original);
    const details = await presentation.details(child.id);
    expect(details.lineage).toEqual(stored.lineage);
    const replay = await service.accept(input);
    expect(replay.id).toBe(child.id); expect(client.submit).toHaveBeenCalledTimes(1);
  });
  test('replays the accepted identity without rereading a now missing parent archive or contacting the worker', async () => {
    const p = await parent(), input = body(p);
    const child = await service.accept(input); await completed(child.id);
    await fs.promises.unlink(path.join(directory, p.artifact.path));
    createComfyClient.mockClear(); client.ready.mockClear(); client.submit.mockClear();
    expect((await service.accept(input)).id).toBe(child.id);
    expect(createComfyClient).not.toHaveBeenCalled(); expect(client.submit).not.toHaveBeenCalled();
  });
  test('two operations with identical image bytes keep distinct parent identities', async () => {
    const firstParent = await parent(), secondParent = await parent();
    expect(firstParent.artifact.sha256).toBe(secondParent.artifact.sha256);
    const input = body(firstParent), child = await service.accept(input); await completed(child.id);
    createComfyClient.mockClear(); client.ready.mockClear(); client.upload.mockClear(); client.submit.mockClear(); reserve.mockClear();
    await refused({ ...input, parent: { operationId: secondParent._id, sha256: secondParent.artifact.sha256 } }, 409);
    const other = await service.accept(body(secondParent)); await completed(other.id);
    expect((await presentation.details(other.id)).lineage.parent.operationId).toBe(secondParent._id);
    expect((await presentation.details(child.id)).lineage.parent.operationId).toBe(firstParent._id);
  });
  test('refuses a forged parent checksum before any worker call', async () => {
    const p = await parent(); await refused(body(p, { parent: { operationId: p._id, sha256: '0'.repeat(64) } }), 409);
  });
  test('refuses a nonexistent parent before any worker call', async () => {
    await refused({ actionKey: 'fixture-parent-missing', prompt: 'Edit', parent: { operationId: crypto.randomUUID(), sha256: sha(original) } }, 404);
  });
  test.each([{ state: 'unknown' }, { runtimeRestored: false }, { state: 'archive_failed' }])('refuses an unreceived parent %j', async extra => {
    const p = await parent(extra); await refused(body(p), 409);
  });
  test('refuses corrupted bytes of the same size rather than accepting the stored checksum', async () => {
    const p = await parent(); await fs.promises.writeFile(path.join(directory, p.artifact.path), Buffer.alloc(original.length));
    await refused(body(p), 503);
  });
  test('refuses another conversation parent and keeps the exact scoped parent', async () => {
    const p = await parent({ conversation: scope });
    await refused(body(p), 404, { conversation: { ...scope, sessionId: 'other-session' } });
    const child = await service.accept(body(p), { conversation: scope }); await completed(child.id);
    expect((await presentation.details(child.id)).lineage.parent.operationId).toBe(p._id);
  });
  test('a scoped caller cannot borrow an unscoped studio parent', async () => {
    const p = await parent(); await refused(body(p), 404, { conversation: scope });
  });
  test.each([null, {}, { operationId: 'bad/id', sha256: sha(original) }, { operationId: crypto.randomUUID(), sha256: 'bad' },
    { operationId: crypto.randomUUID(), sha256: sha(original), workflow: 'untrusted' }])('refuses malformed parent %j before worker readiness', async value => {
    await refused({ actionKey: 'fixture-parent-shape', prompt: 'Edit', parent: value }, 400);
  });
  test('the chosen parent is reference zero and the manual image follows it with durable ordered hashes', async () => {
    const p = await parent(); const manual = PNG.sync.write({ ...pixels, data: Buffer.alloc(16, 0) });
    const child = await service.accept(body(p, { references: [manual.toString('base64')] })); await completed(child.id);
    expect(client.upload.mock.calls.map(call => sha(call[0]))).toEqual([sha(reference(original)), sha(reference(manual))]);
    const details = await presentation.details(child.id);
    expect(details.lineage.references.map(x => x.sourceSha256)).toEqual([sha(original), sha(manual)]);
    expect(details.lineage.references.map(x => x.workerSha256)).toEqual([sha(reference(original)), sha(reference(manual))]);
  });
  test('the two-reference limit includes the archived parent', async () => {
    const p = await parent(); await refused(body(p, { references: [output.toString('base64'), output.toString('base64')] }), 400);
  });
  test('an oversized original parent refuses before worker readiness without silently reducing pixels', async () => {
    const oversized = PNG.sync.write({ width: 2049, height: 2048, data: Buffer.alloc(2049 * 2048 * 4, 255) });
    const p = await parent({}, oversized); await refused(body(p), 400);
  });
  test('historical operations keep their existing reading without an invented parent', async () => {
    const p = await parent(); const details = await presentation.details(p._id);
    expect(details.lineage == null).toBe(true);
    expect(details.recipe.id).toBe('quality'); expect(details.request.prompt).toBe('Fixture parent');
  });
  test('manual-only references keep their descriptors without inventing a parent', async () => {
    const child = await service.accept({ actionKey: 'fixture-manual-only', prompt: 'Edit the uploaded image', seed: 42,
      references: [output.toString('base64')] }); await completed(child.id);
    const details = await presentation.details(child.id);
    expect(details.lineage.version).toBe(1);
    expect(details.lineage.parent).toBeUndefined();
    expect(details.lineage.references).toMatchObject([{ sourceSha256: sha(output), workerSha256: sha(reference(output)), transform: 'decoded-pixels-to-png-v1' }]);
  });
});
