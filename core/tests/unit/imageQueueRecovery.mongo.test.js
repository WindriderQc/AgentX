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
