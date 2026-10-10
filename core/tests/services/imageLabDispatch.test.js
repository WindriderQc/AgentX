'use strict';
jest.mock('../../models/ImageOperation', () => ({ createCollection: jest.fn(), createIndexes: jest.fn(), updateMany: jest.fn(), create: jest.fn(),
  find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) }));
jest.mock('../../src/services/images/config', () => ({ loadConfig: jest.fn() }));
jest.mock('../../src/services/imageArchive', () => ({ defaultArchive: jest.fn() }));
jest.mock('../../src/services/images/comfyClient', () => ({ createComfyClient: jest.fn() }));
jest.mock('../../src/services/images/gpuReservation', () => ({ reserve: jest.fn() }));
const model = require('../../models/ImageOperation');
const config = require('../../src/services/images/config');
const archive = require('../../src/services/imageArchive');
const worker = require('../../src/services/images/comfyClient');
const gpu = require('../../src/services/images/gpuReservation');
const service = require('../../src/services/images/imageService');
test.each([null, false, {}, { catalogueId: 'scenes', qualified: true }])('labSelection=%o refuses before Mongo, archive, worker or reservation effects', async labSelection => {
  await expect(service.accept({ actionKey: 'ordinary-key', prompt: 'A lake', labSelection })).rejects.toMatchObject({ statusCode: 409 });
  for (const provider of [model, config, archive, worker, gpu]) for (const effect of Object.values(provider)) expect(effect).not.toHaveBeenCalled();
});
test('an earlier prepared-only intent is also refused before initialization', async () => {
  await expect(service.accept({ state: 'prepared_only', actionKey: 'legacy-hq-key', prompt: 'A lake' })).rejects.toMatchObject({ statusCode: 409 });
  expect(model.createCollection).not.toHaveBeenCalled();
});
test('the HTTP operation route also refuses a prepared selection before service initialization', async () => {
  const express = require('express'), request = require('supertest');
  const { createRouter } = require('../../routes/local-images');
  const app = express(); app.use(express.json()); app.use('/api/images', createRouter());
  await request(app).post('/api/images/operations').send({ actionKey: 'ordinary-key', prompt: 'A lake', labSelection: null }).expect(409);
  for (const provider of [model, config, archive, worker, gpu]) for (const effect of Object.values(provider)) expect(effect).not.toHaveBeenCalled();
});
test('an ordinary image request retains its normal initialization path', async () => {
  await expect(service.accept({ actionKey: 'ordinary-key', prompt: 'A lake' })).rejects.toMatchObject({ statusCode: 503 });
  expect(model.createCollection).toHaveBeenCalledTimes(1); expect(model.createIndexes).toHaveBeenCalledTimes(1);
  expect(config.loadConfig).toHaveBeenCalledTimes(1); expect(worker.createComfyClient).not.toHaveBeenCalled();
});
