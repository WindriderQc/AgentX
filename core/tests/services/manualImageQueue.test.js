'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { PNG } = require('pngjs');
jest.mock('../../src/services/images/config', () => ({ ...jest.requireActual('../../src/services/images/config'), loadConfig: jest.fn() }));
jest.mock('../../src/services/images/comfyClient', () => ({ createComfyClient: jest.fn() }));
jest.mock('../../src/services/images/gpuReservation', () => ({ reserve: jest.fn() }));
const Images = require('../../models/ImageOperation');
const Queue = require('../../models/HeavyWorkQueue');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('../../src/services/heavyWorkQueueService');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const bridge = require('../../src/services/images/workQueue');
const images = require('../../src/services/images/imageService');
const { loadConfig } = require('../../src/services/images/config');
const { createComfyClient } = require('../../src/services/images/comfyClient');
const { reserve } = require('../../src/services/images/gpuReservation');
const { main } = require('../../../integrations/operations/heavy-work-queue.cjs');
const app = express();
app.use(express.json());
app.use('/api/cluster/schedule/work-queue', require('../../routes/heavy-work-queue'));
app.use('/api/images', require('../../routes/local-images').createRouter());
const fetchImpl = async (url, options) => {
  const call = request(app)[options.body === undefined ? 'get' : 'post'](new URL(url).pathname);
  const result = await (options.body === undefined ? call : call.send(JSON.parse(options.body)));
  return { ok: result.status < 400, status: result.status, json: async () => result.body };
};
const workers = [
  { id: 'desk', url: 'http://127.0.0.1:8188', ollamaHosts: ['http://127.0.0.1:11434'] },
  { id: 'lab', url: 'http://127.0.0.2:8188', ollamaHosts: ['http://127.0.0.2:11434'] }
];
const profile = { family: 'klein', diffusion: 'fixture.safetensors', encoder: 'encoder.safetensors',
  vae: 'vae.safetensors', steps: 4, maxPixels: 1048576 };
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
let directory, clients;
beforeEach(async () => {
  jest.restoreAllMocks(); jest.clearAllMocks();
  await Promise.all([Images, Queue, Runtime].map(model => model.deleteMany({})));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-image-queue-'));
  process.env.IMAGE_ARCHIVE_DIR = directory;
  loadConfig.mockReturnValue({ workers, profiles: { fixture: profile }, defaultProfile: 'fixture' });
  clients = workers.map(() => ({ ready: jest.fn(async () => ({})),
    json: jest.fn(async () => ({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] })),
    submit: jest.fn(async () => ({})),
    observe: jest.fn(async (_id, options) => { await options.onTerminal(); return { filename: 'fixture.png', subfolder: 'agentx', type: 'output' }; }),
    read: jest.fn(async () => png), free: jest.fn(async () => ({})) }));
  createComfyClient.mockImplementation(url => clients[workers.findIndex(worker => worker.url === url)]);
  reserve.mockResolvedValue({ assertOwned: jest.fn(async () => {}), verified: jest.fn(async () => {}),
    restore: jest.fn(async () => {}), quarantine: jest.fn(async () => {}) });
});
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); delete process.env.IMAGE_ARCHIVE_DIR; });

async function planned(worker) {
  const job = await queue.submit({ key: 'manual-image-fixture', title: 'Synthetic manual image', kind: 'image',
    hosts: worker.ollamaHosts, estimatedMinutes: 5,
    executor: { actionKey: 'manual-image-action', prompt: 'Synthetic lake', profile: 'fixture', seed: 42, width: 512, height: 512 } }, 'fixture');
  return queue.reserve(job.id, { expectedRevision: job.revision, start: new Date().toISOString() }, 'fixture');
}
const terminal = async id => {
  for (let i = 0; i < 200; i++) {
    const op = await images.get(id);
    if (['completed', 'failed', 'unknown', 'archive_failed'].includes(op.state)) return op;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Synthetic image did not settle: ${id}`);
};

describe.each(workers.map((worker, index) => [worker.id, worker, index]))('manual queue CLI on %s', (_name, worker, index) => {
  test.each(['ordinary', 'observer-before-enroll', 'observer-after-enroll', 'dispatcher-after-enroll'])(
    'reaches the real Core image service exactly once with %s', async interference => {
      const ready = await planned(worker);
      const observations = [];
      if (interference === 'observer-before-enroll') {
        const create = Images.create.bind(Images);
        jest.spyOn(Images, 'create').mockImplementation(async (...args) => {
          const rows = await create(...args);
          observations.push(...await Promise.all([evidence.reconcile(ready.id, 'observer-a'), evidence.reconcile(ready.id, 'observer-b')]));
          return rows;
        });
      }
      if (['observer-after-enroll', 'dispatcher-after-enroll'].includes(interference)) {
        const enroll = bridge.enroll;
        jest.spyOn(bridge, 'enroll').mockImplementation(async (...args) => {
          const result = await enroll(...args);
          if (interference === 'dispatcher-after-enroll') await images.dispatchQueued();
          else observations.push(await evidence.reconcile(ready.id, 'observer-after'));
          return result;
        });
      }
      const result = await main(['run', '--core', 'http://localhost:3180', '--actor', 'fixture', '--id', ready.id,
        '--revision', String(ready.revision)], { fetchImpl });
      const op = await terminal(result.operation.id);
      expect(op).toMatchObject({ state: 'completed', runtimeRestored: true, worker: worker.id, queueRequestId: ready.id });
      expect(observations.every(job => job.state === 'dispatching' && !job.operation)).toBe(true);
      await evidence.reconcile(ready.id, 'final-observer');
      expect(await queue.get(ready.id)).toMatchObject({ state: 'completed', operation: { id: op.id },
        releaseReceipt: { authority: 'core.image-operation' } });
      await Promise.all([images.dispatchQueued(), images.dispatchQueued(), evidence.reconcile(ready.id, 'repeat-observer')]);
      expect((await images.accept({ ...ready.executor, queueRequestId: ready.id, queueDispatchId: result.dispatchId })).id).toBe(op.id);
      expect(clients[index].submit).toHaveBeenCalledTimes(1);
      expect(clients[1 - index].submit).not.toHaveBeenCalled();
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(await Images.countDocuments()).toBe(1);
      expect((await queue.get(ready.id)).events.some(event => event.action === 'uncertain')).toBe(false);
    });
});

test.each(['wrong-dispatch', 'expired-window', 'another-operation'])('retains the dispatch assertion for %s', async scenario => {
  const ready = await planned(workers[0]);
  const begun = await queue.begin(ready.id, { expectedRevision: ready.revision }, 'fixture');
  const op = await Images.create({ _id: '11111111-1111-4111-8111-111111111111', actionKey: ready.executor.actionKey,
    requestHash: 'a'.repeat(64), state: 'queued', request: { prompt: 'Synthetic' }, profile: { id: 'fixture' },
    workerUrl: workers[0].url, queueRequestId: ready.id,
    queueDispatchId: scenario === 'wrong-dispatch' ? 'another-dispatch' : begun.dispatchId });
  if (scenario === 'expired-window') {
    await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': ready.id }, { $set: { 'jobs.$.reservation.end': new Date(0).toISOString() } });
  }
  if (scenario === 'another-operation') {
    await queue.record(ready.id, { dispatchId: begun.dispatchId, state: 'running', operationId: '22222222-2222-4222-8222-222222222222' }, 'fixture');
  }
  const launch = jest.fn();
  await expect(bridge.dispatch(op.toObject(), launch)).rejects.toMatchObject({ code: 'HEAVY_QUEUE_WINDOW_CLOSED' });
  expect(launch).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  expect((await Images.findById(op._id).lean()).state).toBe('queued');
});

test('a lost native submit reply remains unknown and the original manual request is never relaunched', async () => {
  const ready = await planned(workers[0]);
  clients[0].submit.mockRejectedValue(new Error('Synthetic reply lost after native submit'));
  const result = await main(['run', '--core', 'http://localhost:3180', '--actor', 'fixture', '--id', ready.id,
    '--revision', String(ready.revision)], { fetchImpl });
  const op = await terminal(result.operation.id);
  expect(op).toMatchObject({ state: 'unknown', runtimeRestored: false });
  await Promise.all([images.dispatchQueued(), evidence.reconcile(ready.id, 'observer')]);
  expect((await queue.get(ready.id)).state).toBe('uncertain');
  expect(clients[0].submit).toHaveBeenCalledTimes(1);
  expect(clients[1].submit).not.toHaveBeenCalled();
});
