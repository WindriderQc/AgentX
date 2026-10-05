'use strict';

const express = require('express');
const request = require('supertest');

const InferenceContentionCounter = require('../../models/InferenceContentionCounter');
const {
  countContention, countRouteRefusal, readContention, _internal: { hourOf }
} = require('../../src/services/routing/inferenceContentionCounters');

const AT = Date.parse('2026-10-05T10:20:00.000Z');
const model = InferenceContentionCounter;

describe('persistent contention counters', () => {
  beforeEach(async () => { await InferenceContentionCounter.deleteMany({}); });

  test('concurrent events increment one hourly bucket per event, task and code', async () => {
    await Promise.all(Array.from({ length: 5 }, () => countContention('ladder_served',
      { taskType: 'quick_chat', code: 'primary_busy' }, { model, now: () => AT })));
    await countContention('ladder_served', { taskType: 'quick_chat', code: 'primary_busy' },
      { model, now: () => AT + 3_600_000 });
    await countContention('ladder_exhausted', { taskType: 'quick_chat', code: 'free text reason!' },
      { model, now: () => AT });
    await countContention('not_an_event', { taskType: 'quick_chat' }, { model, now: () => AT });
    const rows = await InferenceContentionCounter.find({}).sort({ hour: 1, event: 1 }).lean();
    expect(rows.map(({ hour, event, taskType, code, count }) => ({ hour, event, taskType, code, count }))).toEqual([
      { hour: hourOf(AT), event: 'ladder_exhausted', taskType: 'quick_chat', code: 'other', count: 1 },
      { hour: hourOf(AT), event: 'ladder_served', taskType: 'quick_chat', code: 'primary_busy', count: 5 },
      { hour: hourOf(AT + 3_600_000), event: 'ladder_served', taskType: 'quick_chat', code: 'primary_busy', count: 1 },
    ]);
    expect(rows[1].lastAt.toISOString()).toBe(new Date(AT).toISOString());
  });

  test('without an explicit store, unit tests never write', async () => {
    await countContention('ladder_served', { taskType: 'quick_chat', code: 'primary_busy' });
    expect(await InferenceContentionCounter.countDocuments({})).toBe(0);
  });

  test('a storage failure is logged, never thrown', async () => {
    const failing = { updateOne: jest.fn(async () => { throw new Error('mongo down'); }) };
    await expect(countContention('ladder_served', {}, { model: failing })).resolves.toBeUndefined();
  });

  test('only selection and admission refusals count, by their refusal code', () => {
    const store = { updateOne: jest.fn(async () => ({})) };
    const decision = (stage, code, reasonCode = null) => ({ intent: { taskType: 'deep_reasoning' }, outcome: { stage, code, reasonCode } });
    countRouteRefusal(decision('admission', 'pre_dispatch_error', 'runtime_inference_admission_denied'), { model: store });
    countRouteRefusal(decision('selection', 'benchmark_claimed'), { model: store });
    countRouteRefusal(decision('validation', 'request_target_required'), { model: store });
    countRouteRefusal(decision('execution', 'execution_succeeded'), { model: store });
    countRouteRefusal(null, { model: store });
    expect(store.updateOne.mock.calls.map(([key]) => [key.event, key.taskType, key.code])).toEqual([
      ['route_refused', 'deep_reasoning', 'runtime_inference_admission_denied'],
      ['route_refused', 'deep_reasoning', 'benchmark_claimed'],
    ]);
  });

  test('reads buckets in a window and totals them', async () => {
    for (const [event, code, now] of [
      ['route_refused', 'benchmark_claimed', AT - 2 * 86_400_000],
      ['route_refused', 'benchmark_claimed', AT],
      ['route_refused', 'benchmark_claimed', AT + 60_000],
      ['ladder_served', 'primary_busy', AT],
    ]) await countContention(event, { taskType: 'quick_chat', code }, { model, now: () => now });
    const read = await readContention({ from: new Date(AT - 3_600_000), to: new Date(AT + 3_600_000) });
    expect(read.buckets).toHaveLength(2);
    expect(read.totals).toEqual([
      expect.objectContaining({ event: 'route_refused', taskType: 'quick_chat', code: 'benchmark_claimed', count: 2 }),
      expect.objectContaining({ event: 'ladder_served', code: 'primary_busy', count: 1 }),
    ]);
  });

  test('a bucket created twice before its unique index existed reads as one', async () => {
    const bucket = { hour: hourOf(AT), event: 'route_refused', taskType: null, code: 'benchmark_claimed', lastAt: new Date(AT) };
    await InferenceContentionCounter.collection.insertMany([{ ...bucket, count: 2 }, { ...bucket, count: 3 }]);
    const read = await readContention({ from: new Date(AT - 60_000), to: new Date(AT + 60_000) });
    expect(read.buckets).toEqual([{ hour: hourOf(AT), event: 'route_refused', taskType: null, code: 'benchmark_claimed', count: 5 }]);
    expect(read.totals).toEqual([{ event: 'route_refused', taskType: null, code: 'benchmark_claimed', count: 5, lastAt: new Date(AT) }]);
  });

  test('GET /api/analytics/inference/contention returns the window, events and counts', async () => {
    await countContention('ladder_exhausted', { taskType: 'quick_chat', code: 'primary_busy' }, { model });
    const app = express();
    app.use('/api/analytics/inference', require('../../routes/analytics-inference'));
    const response = await request(app).get('/api/analytics/inference/contention?window=24h').expect(200);
    expect(response.body.data).toMatchObject({
      source: 'inferencecontentioncounters',
      window: { key: '24h' },
      events: expect.objectContaining({ ladder_exhausted: expect.any(String) }),
      totals: [expect.objectContaining({ event: 'ladder_exhausted', taskType: 'quick_chat', code: 'primary_busy', count: 1 })],
    });
    expect(response.body.data.buckets).toHaveLength(1);
  });
});
