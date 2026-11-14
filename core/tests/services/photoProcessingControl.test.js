'use strict';
const crypto = require('node:crypto'), mongoose = require('mongoose');
const Runtime = require('../../models/RuntimeCoordination');
const control = require('../../src/services/photos/photoProcessingControl');
const writer = require('../../src/services/photos/photoProcessingWriter');
const runtime = require('../../src/services/runtimeCoordinationService');
const drain = require('../../src/services/runtimeDrainIntent');
const uuid = () => crypto.randomUUID();
const request = expectedRevision => ({ requestId: uuid(), expectedRevision });
const row = () => ({ _id: uuid(), queueId: uuid(), processId: uuid(), target: { host: 'http://localhost:11434' } });

beforeEach(async () => {
  drain.clear();
  process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'synthetic', endpoints: ['http://localhost:11434'] }]);
  await Runtime.deleteMany({});
});
afterEach(() => { drain.clear(); delete process.env.AGENTX_RUNTIME_RESOURCES_JSON; jest.restoreAllMocks(); });

test('legacy state is open; an exact pause receipt is durable, private by default and idempotent', async () => {
  expect(await control.status()).toMatchObject({ paused: false, revision: 0, inFlight: [], drained: true });
  const input = request(0), result = await control.pause(input, 'synthetic-operator');
  expect(result).toMatchObject({ paused: true, revision: 1, requestId: input.requestId, idempotent: false });
  expect(await control.pause(input, 'synthetic-operator')).toMatchObject({ paused: true, revision: 1, idempotent: true });
  expect((await Runtime.findById('runtime').lean()).photoProcessingControl).toBeUndefined();
  const saved = await Runtime.collection.findOne({ _id: 'runtime' });
  expect(saved.photoProcessingControl).toMatchObject({ paused: true, requestId: input.requestId, revision: 1 });
  expect(saved.photoProcessingControl.expiresAt).toBeUndefined();
  expect(saved.photoProcessingControl.resumeAt).toBeUndefined();
  // A new model/service instance reads the same canonical state; time/reaping
  // and a recreated Core module cannot turn this into an implicit resume.
  await runtime.reapExpired(new Date(Date.now() + 30 * 86400000));
  const fresh = control.createPhotoProcessingControl();
  expect(await fresh.status()).toMatchObject({ paused: true, revision: 1, requestId: input.requestId });
  expect(await writer.acquire(row())).toBe(false);
});

test('only a fresh explicit resume opens admissions; old pause receipts cannot replay after it', async () => {
  const pause = request(0); await control.pause(pause, 'operator');
  const resume = request(1);
  await expect(control.resume(resume, 'operator')).rejects.toMatchObject({ code: 'PHOTO_CONTROL_INVALID' });
  await expect(control.resume({ ...resume, confirmation: 'later' }, 'operator')).rejects.toMatchObject({ code: 'PHOTO_CONTROL_INVALID' });
  const input = { ...resume, confirmation: control.RESUME };
  expect(await control.resume(input, 'operator')).toMatchObject({ paused: false, revision: 2, idempotent: false });
  expect(await control.resume(input, 'operator')).toMatchObject({ paused: false, revision: 2, idempotent: true });
  await expect(control.pause(pause, 'operator')).rejects.toMatchObject({ code: 'PHOTO_CONTROL_CONFLICT' });
  expect(await writer.acquire(row())).toBe(true);
});

test('changed identities, revisions and timed resumes refuse without modifying the saved pause', async () => {
  const input = request(0); await control.pause(input, 'operator');
  for (const changed of [{ ...input, expectedRevision: 1 }, { ...input, resumeAt: new Date().toISOString() },
    { ...input, requestId: 'invalid' }, { ...input, expectedRevision: -1 }]) {
    await expect(control.pause(changed, 'operator')).rejects.toBeTruthy();
  }
  await expect(control.pause(input, 'another')).rejects.toMatchObject({ code: 'PHOTO_CONTROL_CONFLICT' });
  await expect(control.resume({ ...input, confirmation: control.RESUME }, 'operator')).rejects.toMatchObject({ code: 'PHOTO_CONTROL_CONFLICT' });
  expect(await control.status()).toMatchObject({ paused: true, revision: 1, requestId: input.requestId });
});

test('pause and writer admission share an atomic boundary in either order', async () => {
  for (let n = 0; n < 12; n++) {
    await Runtime.deleteMany({});
    const candidate = row(), input = request(0);
    const calls = [() => writer.acquire(candidate), () => control.pause(input, 'operator')];
    if (n % 2) calls.reverse();
    await Promise.all(calls.map(call => call()));
    expect(await control.status()).toMatchObject({ paused: true, revision: 1 });
    const saved = await Runtime.collection.findOne({ _id: 'runtime' });
    expect(saved.coreWriters.length).toBeLessThanOrEqual(1);
    expect(await writer.acquire(row())).toBe(false);
    if (saved.coreWriters.length) {
      expect(await writer.held(candidate, 'ACTIVE')).toBeTruthy();
      await writer.assert(candidate); // The already admitted writer is not interrupted.
      await writer.release(candidate);
    }
    expect(await control.status()).toMatchObject({ paused: true, drained: true });
  }
});

test('an admitted or unknown writer stays fenced while paused; no unrelated runtime state is cleared', async () => {
  const candidate = row(); expect(await writer.acquire(candidate)).toBe(true);
  await writer.unknown(candidate);
  const before = await Runtime.collection.findOne({ _id: 'runtime' });
  const result = await control.pause(request(0), 'operator');
  expect(result).toMatchObject({ paused: true, drained: false,
    inFlight: [{ operationId: candidate._id, queueId: candidate.queueId, state: 'UNKNOWN' }] });
  const after = await Runtime.collection.findOne({ _id: 'runtime' });
  expect(after.coreWriters).toEqual(before.coreWriters);
  expect(after.workloads).toEqual(before.workloads);
  expect(after.inferences).toEqual(before.inferences);
  expect(after.maintenance).toEqual(before.maintenance);
  expect(await writer.acquire(row())).toBe(false);
});

test('a photo-only pause leaves interactive admission and its exact release intact', async () => {
  // Mongo admission metadata only; no runtime or model is contacted.
  const acquire = () => runtime.acquireInference({ principal: 'synthetic-interactive', requestId: uuid(),
    host: 'http://localhost:11434', model: 'synthetic-model', kind: 'trusted-runtime' });
  const first = await acquire(); expect(first.acquired).toBe(true);
  await control.pause(request(0), 'operator');
  const second = await acquire(); expect(second.acquired).toBe(true);
  expect((await Runtime.collection.findOne({ _id: 'runtime' })).inferences).toHaveLength(2);
  for (const admission of [first, second]) await runtime.releaseInference({ id: admission.admissionId,
    generation: admission.generation, principal: 'synthetic-interactive' });
  expect(await control.status()).toMatchObject({ paused: true, drained: true });
});

test('concurrent explicit controls commit one revision and the same lost acknowledgement is recoverable', async () => {
  const input = request(0);
  const results = await Promise.all(Array.from({ length: 6 }, () => control.pause(input, 'operator')));
  expect(results.every(x => x.paused && x.revision === 1)).toBe(true);
  expect(results.filter(x => !x.idempotent)).toHaveLength(1);
  const other = request(0);
  await expect(control.pause(other, 'operator')).rejects.toMatchObject({ code: 'PHOTO_CONTROL_CONFLICT' });
  expect(await control.status()).toMatchObject({ revision: 1, requestId: input.requestId });
});

test('a lost write acknowledgement is observed and recovered with the same intent, never a second revision', async () => {
  const update = Runtime.findOneAndUpdate.bind(Runtime), input = request(0);
  const spy = jest.spyOn(Runtime, 'findOneAndUpdate').mockImplementation((...args) => ({ select: selection => ({ lean: async () => {
    await update(...args).select(selection).lean();
    throw Error('Synthetic acknowledgement lost after commit');
  } }) }));
  await expect(control.pause(input, 'operator')).rejects.toThrow('acknowledgement lost');
  spy.mockRestore();
  expect(await control.status()).toMatchObject({ paused: true, revision: 1, requestId: input.requestId });
  expect(await control.pause(input, 'operator')).toMatchObject({ paused: true, revision: 1, idempotent: true });
});

test('a missing post-write projection is not reported as a successful open control', async () => {
  const update = Runtime.findOneAndUpdate.bind(Runtime), input = request(0);
  const spy = jest.spyOn(Runtime, 'findOneAndUpdate').mockImplementation((...args) => ({ select: selection => ({ lean: async () => {
    const value = await update(...args).select(selection).lean();
    delete value.photoProcessingControl;
    return value;
  } }) }));
  await expect(control.pause(input, 'operator')).rejects.toMatchObject({ code: 'PHOTO_CONTROL_RECEIPT_UNAVAILABLE' });
  spy.mockRestore();
  expect(await control.pause(input, 'operator')).toMatchObject({ paused: true, revision: 1, idempotent: true });
});

test.each([null, {}, { version: 1, revision: 1, paused: false },
  { version: 1, revision: 1, paused: false, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    inputHash: 'a'.repeat(64), principal: 'operator', changedAt: null }])('malformed stored control fails closed (%j)', async value => {
  await Runtime.collection.insertOne({ _id: 'runtime', maintenance: null, coreWriters: [], workloads: [], inferences: [], photoProcessingControl: value });
  await expect(control.status()).rejects.toMatchObject({ code: 'PHOTO_CONTROL_INVALID' });
  await expect(writer.acquire(row())).rejects.toMatchObject({ code: 'PHOTO_CONTROL_INVALID' });
  expect((await Runtime.collection.findOne({ _id: 'runtime' })).coreWriters).toHaveLength(0);
});

test('the exact owner artifact can stage and reconcile a pause with a legacy strict schema', async () => {
  const legacy = mongoose.models.PhotoPauseLegacy || mongoose.model('PhotoPauseLegacy', new mongoose.Schema({
    _id: String, maintenance: { type: mongoose.Schema.Types.Mixed, default: null },
    coreWriters: { type: [mongoose.Schema.Types.Mixed], default: [] }, workloads: [mongoose.Schema.Types.Mixed], inferences: [mongoose.Schema.Types.Mixed]
  }, { collection: 'runtime_coordination', strict: true, strictQuery: true }));
  const service = control.createPhotoProcessingControl({ runtime: legacy, ensureDocument: async () => {
    await legacy.updateOne({ _id: 'runtime' }, { $setOnInsert: { coreWriters: [], workloads: [], inferences: [] } }, { upsert: true });
  } });
  const input = request(0);
  expect(await service.pause(input, 'operator')).toMatchObject({ paused: true, revision: 1 });
  expect(await service.pause(input, 'operator')).toMatchObject({ paused: true, revision: 1, idempotent: true });
  await expect(service.pause(request(0), 'operator')).rejects.toMatchObject({ code: 'PHOTO_CONTROL_CONFLICT' });
  expect(await control.status()).toMatchObject({ paused: true, revision: 1, requestId: input.requestId });
});

test('the owner HTTP lifecycle returns the canonical receipt while public availability stays unchanged', async () => {
  const express = require('express'), requestHttp = require('supertest');
  const { createPhotoProcessingService } = require('../../src/services/photos/photoProcessingService');
  const { registerPhotoProcessing } = require('../../surfaces/diskx/photo-processing');
  const app = express(), service = createPhotoProcessingService({ config: () => null,
    bridge: { call: jest.fn() }, client: { json: jest.fn() }, immich: {} });
  registerPhotoProcessing({ app, express, service });
  const input = request(0);
  const paused = await requestHttp(app).post('/api/phone-media/processing').set('x-service-caller', 'synthetic-owner')
    .send({ op: 'pause', ...input }).expect(200);
  expect(paused.body.data).toMatchObject({ paused: true, revision: 1, requestId: input.requestId });
  const publicRead = await requestHttp(app).get('/api/phone-media/processing').expect(200);
  expect(publicRead.body.data).toEqual({ configured: false, frameEnabled: false, batchLimit: 24 });
  const state = await requestHttp(app).post('/api/phone-media/processing').send({ op: 'control' }).expect(200);
  expect(state.body.data).toMatchObject({ paused: true, revision: 1 });
  await requestHttp(app).post('/api/phone-media/processing').send({ op: 'resume', requestId: uuid(), expectedRevision: 1 }).expect(400);
  await requestHttp(app).post('/api/phone-media/processing').send({ op: 'pause', ...input, resumeAt: '2099-01-01' }).expect(400);
  expect(await control.status()).toMatchObject({ paused: true, revision: 1 });
});
