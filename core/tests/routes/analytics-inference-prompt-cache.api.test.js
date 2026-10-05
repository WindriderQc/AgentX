'use strict';

const express = require('express');
const request = require('supertest');

const InferenceLog = require('../../models/InferenceLog');
const router = require('../../routes/analytics-inference');
const { promptCacheVerdict } = require('../../src/services/routing/promptCacheAttribution');

// Rows as recordInference writes them after synthetic interleaved turns (#364).
const GPU_A = 'http://gpu-a:11434';
const GPU_B = 'http://gpu-b:11434';
const coder = { consumerContract: 'openclaw-pipeline-runtime-v1', caller: 'proxy', runtime: 'agentx', taskType: 'coding' };
const nestor = { consumerContract: 'nestor-v1', caller: 'proxy', runtime: 'agentx', taskType: null };
const classifierBetween = { kind: 'classifier' };
const nestorBetween = { kind: 'trusted-runtime', consumerContract: 'nestor-v1' };

function row({ host = GPU_A, model = 'qwen35:27b', who = coder, observation, loadMs = 30, promptEvalMs, minutesAgo = 5 }) {
  return {
    host,
    hostKey: host === GPU_A ? 'gpu-a' : 'gpu-b',
    model,
    ...who,
    loadMs,
    ...(promptEvalMs != null && { promptEvalMs }),
    promptCache: promptCacheVerdict(observation, { loadMs, promptEvalMs }),
    status: 'success',
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
  };
}

const tracked = (chars, sharedChars, reusableChars, interleavedBy = []) => ({
  tracked: true, chars, sharedChars, reusableChars, sincePreviousMs: 2_000, interleaved: interleavedBy.length, interleavedBy,
});

describe('GET /api/analytics/inference/prompt-cache', () => {
  let server;
  beforeAll((done) => {
    const app = express();
    app.use('/api/analytics/inference', router);
    server = app.listen(0, '127.0.0.1', done);
  });
  afterAll((done) => { server.close(done); });

  beforeEach(async () => {
    await InferenceLog.deleteMany({});
    await InferenceLog.create([
      // The coding agent loses 9,000 of 10,000 characters twice, once to Nestor
      // and the classifier, once to Nestor alone; its prefill is 2,000 ms each.
      row({ observation: tracked(10_000, 0, 9_000, [nestorBetween, classifierBetween]), promptEvalMs: 2_000 }),
      row({ observation: tracked(10_000, 0, 9_000, [nestorBetween]), promptEvalMs: 2_000 }),
      row({ observation: tracked(11_000, 10_000, 10_000), promptEvalMs: 200 }),
      // Nestor after a reload of the same model, then cold on the same host.
      row({ who: nestor, observation: tracked(4_000, 0, 3_000), loadMs: 6_000, promptEvalMs: 800 }),
      row({ who: nestor, observation: tracked(4_000, 0, 0), promptEvalMs: 800 }),
      // Another host, untracked after a restart, and a row from before #364.
      row({ host: GPU_B, model: 'qwen3:8b', observation: { tracked: false, chars: 500 }, promptEvalMs: 50 }),
      { host: GPU_A, hostKey: 'gpu-a', model: 'qwen35:27b', status: 'success', timestamp: new Date() },
      // Outside the default window.
      row({ observation: tracked(10_000, 0, 9_000, [nestorBetween]), promptEvalMs: 2_000, minutesAgo: 60 * 24 * 8 }),
    ]);
  });
  afterEach(async () => { await InferenceLog.deleteMany({}); });

  test('per host and model: verdicts, prefill lost and who came in between', async () => {
    const res = await request(server).get('/api/analytics/inference/prompt-cache');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.window.key).toBe('7d');
    expect(data.groupBy).toEqual(['hostKey', 'model']);
    expect(data.totals).toMatchObject({
      calls: 6,
      verdicts: { warm: 1, interleaved: 2, reload: 1, cold: 1, untracked: 1 },
      lostChars: 9_000 + 9_000 + 3_000,
      // 2,000 x 9,000/10,000 twice, and the reload's 800 x 3,000/4,000.
      lostPrefillMs: 1_800 + 1_800 + 600,
      // The untracked row's prefill does not count against a loss it cannot measure.
      promptEvalMs: 2_000 + 2_000 + 200 + 800 + 800,
    });
    expect(data.totals.lostPrefillShare).toBeCloseTo(4_200 / 5_800, 3);

    const [gpuA, gpuB] = data.groups;
    expect(gpuA).toMatchObject({ key: { hostKey: 'gpu-a', model: 'qwen35:27b' }, calls: 5, lostPrefillMs: 4_200 });
    expect(gpuA.interleavedBy).toEqual([
      { kind: 'trusted-runtime', consumerContract: 'nestor-v1', taskType: null, calls: 2 },
      { kind: 'classifier', consumerContract: null, taskType: null, calls: 1 },
    ]);
    expect(gpuB).toMatchObject({ key: { hostKey: 'gpu-b', model: 'qwen3:8b' }, calls: 1, lostPrefillMs: 0,
      verdicts: { untracked: 1 }, interleavedBy: [] });
  });

  test('per agent, filtered to one host', async () => {
    const res = await request(server).get('/api/analytics/inference/prompt-cache')
      .query({ groupBy: 'consumerContract', host: GPU_A });
    expect(res.status).toBe(200);
    const byContract = Object.fromEntries(res.body.data.groups.map(group => [group.key.consumerContract, group]));
    expect(byContract['openclaw-pipeline-runtime-v1']).toMatchObject({
      calls: 3, verdicts: { interleaved: 2, warm: 1 }, lostPrefillMs: 3_600,
    });
    expect(byContract['nestor-v1']).toMatchObject({
      calls: 2, verdicts: { reload: 1, cold: 1 }, lostPrefillMs: 600, interleavedBy: [],
    });
  });

  test('rejects an unknown group field', async () => {
    const res = await request(server).get('/api/analytics/inference/prompt-cache').query({ groupBy: 'callerDetail' });
    expect(res.status).toBe(400);
  });
});
