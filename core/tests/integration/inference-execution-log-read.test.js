'use strict';

const express = require('express');
const request = require('supertest');
const InferenceLog = require('../../models/InferenceLog');
const { recordInference } = require('../../src/services/routing/inferenceTelemetry');
const router = require('../../routes/analytics-inference');
const nerveCenter = require('../../routes/nerve-center');

jest.mock('../../src/services/modelRouter', () => ({ resolveHostKey: () => 'primary' }));
jest.mock('../../src/services/alertService', () => ({ evaluateEvent: jest.fn(async () => {}) }));
jest.mock('node-fetch', () => jest.fn(() => { throw new Error('Unexpected network call in a log read'); }));

// Real writer/storage/reader against suite-owned MongoDB. No native execution.
describe('execution evidence in canonical inference log reads', () => {
  const app = express();
  app.use('/api/analytics/inference', router);
  app.use('/api/nerve-center', nerveCenter);
  const base = { model: 'fixture/model', host: 'http://native.example.test:11434',
    caller: 'proxy', runtime: 'agentx', durationMs: 1200 };
  beforeEach(() => InferenceLog.deleteMany({}));
  afterEach(() => expect(require('node-fetch')).not.toHaveBeenCalled());

  async function readLogViews() {
    const analytics = await request(app).get('/api/analytics/inference/logs').expect(200);
    const routing = await request(app).get('/api/nerve-center/routing/log').expect(200);
    const activity = await request(app).get('/api/nerve-center/inference/activity').expect(200);
    return [analytics.body.data.items, routing.body.data, activity.body.data.logs];
  }

  async function write(entry) {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development'; // The production writer is a no-op in test mode.
    try { await recordInference(entry); }
    finally { process.env.NODE_ENV = originalEnv; }
  }

  test('preserves native source, mode and receipt hash for successes and errors without changing rows', async () => {
    const expected = [];
    for (const [mode, status, char] of [['model', 'success', 'a'], ['agent', 'success', 'b'], ['agent', 'error', 'c']]) {
      const evidence = { executionSource: 'openclaw', executionMode: mode,
        executionReceiptFingerprint: char.repeat(64), status };
      await write({ ...base, ...evidence, tokensIn: null, tokensOut: null, fallbackUsed: null });
      expected.push(evidence);
    }
    const before = await InferenceLog.find().sort({ _id: 1 }).lean();
    expect(before).toHaveLength(3);
    for (const items of await readLogViews()) {
      expect(items).toHaveLength(3);
      for (const evidence of expected) {
        expect(items).toEqual(expect.arrayContaining([expect.objectContaining({
          ...evidence, runtime: 'agentx', tokensIn: null, tokensOut: null, fallbackUsed: null
        })]));
      }
    }
    const after = await InferenceLog.find().sort({ _id: 1 }).lean();
    expect(after).toEqual(before);
  });

  test('does not reclassify legacy unknown execution as local or leak malformed native metadata', async () => {
    const secret = 'PRIVATE_NATIVE_RUN_AND_RECEIPT';
    // Bypass schema defaults to model immutable rows written before these fields existed.
    await InferenceLog.collection.insertMany([
      { ...base, model: 'fixture/legacy', timestamp: new Date() },
      { ...base, model: 'fixture/unknown', timestamp: new Date(), executionSource: null,
        executionMode: null, executionReceiptFingerprint: null },
      { ...base, model: 'fixture/hostile', timestamp: new Date(), executionSource: secret,
        executionMode: { messages: [secret] }, executionReceiptFingerprint: `https://user:${secret}@example.test/receipt`,
        executionReceipt: { transcript: secret, runId: secret }, payload: secret }
    ]);
    const before = await InferenceLog.find().sort({ _id: 1 }).lean();
    for (const items of await readLogViews()) {
      expect(items).toHaveLength(3);
      const legacy = items.find(row => row.model === 'fixture/legacy');
      for (const field of ['executionSource', 'executionMode', 'executionReceiptFingerprint']) {
        expect(legacy).not.toHaveProperty(field);
        for (const model of ['fixture/unknown', 'fixture/hostile']) {
          expect(items.find(row => row.model === model)[field]).toBeNull();
        }
      }
      expect(JSON.stringify(items)).not.toContain(secret);
    }
    expect(await InferenceLog.find().sort({ _id: 1 }).lean()).toEqual(before);
  });
});
