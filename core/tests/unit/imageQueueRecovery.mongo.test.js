'use strict';
jest.mock('../../src/services/images/config', () => ({ ...jest.requireActual('../../src/services/images/config'), loadConfig: jest.fn() }));
jest.mock('../../src/services/images/comfyClient', () => ({ createComfyClient: jest.fn() }));
const Images = require('../../models/ImageOperation');
const Queue = require('../../models/HeavyWorkQueue');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('../../src/services/heavyWorkQueueService');
const bridge = require('../../src/services/images/workQueue');
const service = require('../../src/services/images/imageService');
const { loadConfig } = require('../../src/services/images/config');
const { createComfyClient } = require('../../src/services/images/comfyClient');
test('startup preserves a crossed image dispatch gap as UNKNOWN and never contacts the worker', async () => {
  await Promise.all([Images, Queue, Runtime].map(model => model.deleteMany({})));
  const config = { workerUrl: 'http://127.0.0.1:8188', ollamaHosts: ['http://127.0.0.1:11434'],
    profiles: { fixture: { family: 'klein', maxPixels: 1048576 } }, defaultProfile: 'fixture' };
  loadConfig.mockReturnValue(config);
  const op = await Images.create({ _id: '11111111-1111-4111-8111-111111111111', actionKey: 'synthetic-restart-gap',
    requestHash: 'a'.repeat(64), state: 'queued', workerUrl: config.workerUrl, profile: { id: 'fixture' }, request: { prompt: 'Synthetic' } });
  const job = await bridge.enroll(op.toObject(), config, {});
  const slot = await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date().toISOString() }, 'fixture');
  const begun = await queue.begin(slot.id, { expectedRevision: slot.revision }, 'fixture');
  // The former process died here, before accepting/recording the native image.
  await service.dispatchQueued();
  expect((await service.get(op._id)).state).toBe('unknown');
  expect(createComfyClient).not.toHaveBeenCalled(); expect(await Runtime.countDocuments()).toBe(0);
  const result = await require('../../src/services/heavyWorkQueueEvidence').reconcile(begun.id, 'fixture');
  expect(result.state).toBe('uncertain'); expect(result.operation.id).toBe(op._id);
  await service.dispatchQueued(); expect(createComfyClient).not.toHaveBeenCalled();
});

test('a retained opportunistic request is cancelled before worker access rather than dispatched later', async () => {
  await Promise.all([Images, Queue, Runtime].map(model => model.deleteMany({})));
  const config = { workerUrl: 'http://127.0.0.1:8188', ollamaHosts: ['http://127.0.0.1:11434'],
    profiles: { fixture: { family: 'klein', maxPixels: 1048576 } }, defaultProfile: 'fixture' };
  loadConfig.mockReturnValue(config);
  const op = await Images.create({ _id: '22222222-2222-4222-8222-222222222222', actionKey: 'synthetic-immediate-restart',
    admissionPolicy: 'opportunistic', requestHash: 'b'.repeat(64), state: 'queued', workerUrl: config.workerUrl,
    profile: { id: 'fixture' }, request: { prompt: 'Synthetic' } });
  const job = await bridge.enroll(op.toObject(), config, {});
  // The prior process ended before its one immediate dispatch attempt.
  createComfyClient.mockClear();
  await service.dispatchQueued();
  expect(await service.get(op._id)).toMatchObject({ state: 'cancelled', admissionPolicy: 'opportunistic' });
  expect(await queue.get(job.id)).toMatchObject({ state: 'cancelled' });
  expect(createComfyClient).not.toHaveBeenCalled();
  expect(await Runtime.countDocuments()).toBe(0);
  await service.dispatchQueued();
  expect(createComfyClient).not.toHaveBeenCalled();
});

test('a lost cancellation reply reads the same queue identity and never repeats cancellation or dispatch', async () => {
  await Promise.all([Images, Queue, Runtime].map(model => model.deleteMany({})));
  const config = { workerUrl: 'http://127.0.0.1:8188', ollamaHosts: ['http://127.0.0.1:11434'] };
  const op = await Images.create({ _id: '33333333-3333-4333-8333-333333333333', actionKey: 'synthetic-cancel-lost-reply',
    admissionPolicy: 'opportunistic', requestHash: 'c'.repeat(64), state: 'queued', workerUrl: config.workerUrl,
    profile: { id: 'fixture' }, request: { prompt: 'Synthetic' } });
  const job = await bridge.enroll(op.toObject(), config, {});
  const cancel = queue.cancel;
  const lost = jest.spyOn(queue, 'cancel').mockImplementationOnce(async (...args) => {
    await cancel(...args); throw new Error('Cancellation response lost');
  });
  const launch = jest.fn();
  try {
    await bridge.dispatch({ ...op.toObject(), queueRequestId: job.id }, launch);
    expect(await service.get(op._id)).toMatchObject({ state: 'cancelled' });
    expect(await queue.get(job.id)).toMatchObject({ state: 'cancelled' });
    expect(lost).toHaveBeenCalledTimes(1); expect(launch).not.toHaveBeenCalled();
  } finally { lost.mockRestore(); }
});
