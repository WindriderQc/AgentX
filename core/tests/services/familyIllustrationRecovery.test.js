'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { PNG } = require('pngjs');
jest.mock('../../src/services/images/config', () => ({ ...jest.requireActual('../../src/services/images/config'), loadConfig: jest.fn() }));
jest.mock('../../src/services/images/comfyClient', () => ({ createComfyClient: jest.fn() }));
jest.mock('../../src/services/hostPinPrimitives', () => ({ ...jest.requireActual('../../src/services/hostPinPrimitives'), fetchRunningModelInfosStrict: jest.fn() }));
jest.mock('../../src/services/hostModelRuntime', () => ({ warmDefaultModel: jest.fn(), unloadModel: jest.fn() }));
jest.mock('../../src/services/benchmarkRuntimeSnapshot', () => ({ ...jest.requireActual('../../src/services/benchmarkRuntimeSnapshot'), captureBenchmarkRuntime: jest.fn() }));
const Image = require('../../models/ImageOperation');
const Runtime = require('../../models/RuntimeCoordination');
const Queue = require('../../models/HeavyWorkQueue');
const Conversation = require('../../models/Conversation');
const { loadConfig } = require('../../src/services/images/config');
const { createComfyClient } = require('../../src/services/images/comfyClient');
const { fetchRunningModelInfosStrict } = require('../../src/services/hostPinPrimitives');
const { captureBenchmarkRuntime, benchmarkRuntimeSnapshotIdentity } = require('../../src/services/benchmarkRuntimeSnapshot');
const { forSurface } = require('../../src/services/surfaceConversationService');
const service = require('../../src/services/images/imageService');
const storage = require('../../src/services/images/illustrationStorage');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const queue = require('../../src/services/heavyWorkQueueService');
const conversations = forSurface('household');
const scope = { surface: 'household', sessionId: 'family-recovery', packId: 'kidx_nestor', scopeId: 'family' };
const sessionQuery = { sessionId: scope.sessionId, packId: scope.packId, scopeId: scope.scopeId };
const bytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const sha256 = createHash('sha256').update(bytes).digest('hex');
let client, dir, epoch;
beforeEach(async () => {
  jest.clearAllMocks();
  await Promise.all([Image, Runtime, Queue, Conversation].map(model => model.deleteMany({})));
  await Queue.create({ _id: 'heavy-work', jobs: [] });
  epoch = randomUUID();
  await conversations.createSession({ ...sessionQuery, modeId: 'family', illustrationRetention: { epoch, expiresAt: new Date(Date.now()+600000).toISOString() } });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'illustration-recovery-')); process.env.IMAGE_ARCHIVE_DIR = dir;
  loadConfig.mockReturnValue({ workerUrl: 'http://127.0.0.1:8188', ollamaHosts: ['http://127.0.0.1:11434'], drainMs: 0,
    defaultProfile: 'quick', profiles: { quick: { family: 'klein', diffusion: 'fixture.safetensors', encoder: 'encoder.safetensors',
      vae: 'vae.safetensors', steps: 4, maxPixels: 1048576 } } });
  const snapshot = { exact: true, capturedAt: new Date(), source: 'ollama_ps', residents: [] };
  snapshot.identityDigest = benchmarkRuntimeSnapshotIdentity(snapshot);
  captureBenchmarkRuntime.mockResolvedValue(snapshot); fetchRunningModelInfosStrict.mockResolvedValue([]);
  client = { ready: jest.fn().mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] }),
    json: jest.fn(async route => route.startsWith('/history/') ? { [route.slice('/history/'.length)]: {
      status: { status_str: 'success', completed: true }, outputs: { save: { images: [{ type: 'output', subfolder: 'agentx', filename: 'fixture.png' }] } }
    } } : { devices: [{ vram_total: 12e9, vram_free: 11e9 }] }),
    submit: jest.fn().mockRejectedValue(new Error('Original submission ACK lost')), observe: jest.fn(),
    free: jest.fn().mockResolvedValue({}), read: jest.fn().mockResolvedValue(bytes),
    discardOutput: jest.fn(async (jobId, hash) => {
      if (!/^[a-f0-9]{64}$/.test(hash || '')) throw new Error('Original content hash unavailable');
      return { contract: 'agentx.image-output-removal/v1', jobId, sha256: hash, removed: true };
    }) };
  createComfyClient.mockReturnValue(client);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.IMAGE_ARCHIVE_DIR; });
async function unknown() {
  const op = await service.acceptOpportunistic({ actionKey: 'illustrated-recovery:' + randomUUID(), prompt: 'A fictional lake' },
    { workerId: 'default', conversation: scope, temporary: true });
  for (let i = 0; i < 200 && (await service.get(op.id)).state !== 'unknown'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect((await service.get(op.id)).state).toBe('unknown');
  expect((await Runtime.findById('runtime').lean()).workloads).toHaveLength(1);
  await conversations.deleteSession(sessionQuery);
  return op;
}
test('unknown → canonical erase → native recovery removes the exact worker output and releases only the original workload', async () => {
  const op = await unknown();
  const recovered = await service.recover(op.id);
  expect(recovered).toMatchObject({ id: op.id, state: 'completed', runtimeRestored: true });
  expect(recovered).not.toHaveProperty('artifact');
  expect(client.discardOutput).toHaveBeenCalledWith(op.id, sha256);
  expect((await Image.findById(op.id).lean()).illustration.workerRemoval.removed).toBe(true);
  const row = await Image.findById(op.id).select('+temporaryImage +request +execution').lean();
  expect(row).not.toHaveProperty('temporaryImage'); expect(row.request).not.toHaveProperty('prompt');
  expect(row.execution).not.toHaveProperty('graph'); expect(row.queueRequestId).toBe(op.queueRequestId);
  expect((await Runtime.findById('runtime').lean()).workloads).toHaveLength(0);
  await evidence.reconcile(op.queueRequestId, 'fixture');
  expect(await queue.get(op.queueRequestId)).toMatchObject({ state: 'completed' });
  expect(client.submit).toHaveBeenCalledTimes(1); expect(client.observe).not.toHaveBeenCalled();
});
test('a lost removal reply after recovery retries only the same terminal output identity through the existing dispatcher', async () => {
  const op = await unknown();
  client.discardOutput.mockRejectedValueOnce(new Error('Original removal response lost'));
  await service.recover(op.id);
  expect((await Image.findById(op.id).lean()).illustration.workerRemovalPending).toBe(true);
  await service.dispatchQueued();
  expect((await Image.findById(op.id).lean()).illustration.workerRemoval.removed).toBe(true);
  expect(client.discardOutput.mock.calls).toEqual([[op.id, sha256], [op.id, sha256]]);
  expect(client.submit).toHaveBeenCalledTimes(1);
});
test('an expired illustration whose recovery storage read failed removes its output after storage-only retry', async () => {
  const op = await unknown(); client.read.mockRejectedValueOnce(new Error('Output read unavailable'));
  expect(await service.recover(op.id)).toMatchObject({ state: 'archive_failed', runtimeRestored: true });
  expect(await service.retryArchive(op.id)).toMatchObject({ state: 'completed', runtimeRestored: true });
  expect((await Image.findById(op.id).lean()).illustration.workerRemoval.removed).toBe(true);
  expect(client.discardOutput).toHaveBeenLastCalledWith(op.id, sha256);
  expect(client.submit).toHaveBeenCalledTimes(1); expect(client.free).toHaveBeenCalledTimes(1);
  expect(fs.readdirSync(dir)).toEqual([]);
});
