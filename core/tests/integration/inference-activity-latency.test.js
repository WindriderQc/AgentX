'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const request = require('supertest');
const InferenceLog = require('../../models/InferenceLog');
const router = require('../../routes/nerve-center');

jest.mock('../../src/services/modelRouter', () => ({ resolveHostKey: () => 'primary' }));
jest.mock('node-fetch', () => jest.fn(() => { throw new Error('Unexpected network request during a log read'); }));

const uiSource = fs.readFileSync(path.join(__dirname, '../../public/js/nerve-center-inference.js'), 'utf8');

// Feed the actual HTTP payload to both existing activity render paths.
async function renderActivity(activity) {
  const body = { innerHTML: '' };
  let displayedLatency = 'stale previous reading';
  const latency = { get textContent() { return displayedLatency; }, set textContent(value) { displayedLatency = String(value); } };
  const tasks = new Map();
  const errors = { warn: jest.fn(), error: jest.fn() };
  const context = {
    console: errors,
    document: { getElementById: id => ({ sectionInferenceBody: body, 'nc-inf-latency': latency }[id] || null) },
    window: {
      PollingController: class {
        start() {} removeTask(name) { tasks.delete(name); } addTask(name, callback) { tasks.set(name, callback); }
      },
      NerveCenterShared: {
        fetchJson: async url => ({ data: url.includes('/inference/activity') ? activity : {} }),
        escapeHtml: value => String(value), shortModel: value => String(value), timeAgo: () => '1m ago',
        renderSectionLoading() {}, finishSectionLoad() {}, attachCollapsibleHandlers() {},
        renderSectionError: errors.error
      }
    }
  };
  vm.runInNewContext(uiSource, context);
  await context.window.NerveCenterInference.loadInference();
  await tasks.get('activity')();
  expect(errors.warn).not.toHaveBeenCalled();
  expect(errors.error).not.toHaveBeenCalled();
  return { initialHtml: body.innerHTML, refreshedLatency: latency.textContent };
}

describe('Nerve Center hourly measured latency', () => {
  const app = express();
  app.use('/api/nerve-center', router);
  const row = overrides => ({ host: 'http://primary.example.test:11434', model: 'fixture/model',
    caller: 'proxy', status: 'success', timestamp: new Date(), ...overrides });
  const read = query => request(app).get('/api/nerve-center/inference/activity').query(query || {}).expect(200);
  beforeEach(() => InferenceLog.deleteMany({}));
  afterEach(() => expect(require('node-fetch')).not.toHaveBeenCalled());

  // Raw inserts preserve legacy missing/malformed values instead of Mongoose casting them.
  test.each([
    ['missing', {}], ['null', { durationMs: null }], ['default zero', { durationMs: 0 }],
    ['negative', { durationMs: -5 }], ['NaN', { durationMs: NaN }],
    ['positive infinity', { durationMs: Infinity }], ['negative infinity', { durationMs: -Infinity }],
    ['string', { durationMs: '120000' }], ['boolean', { durationMs: true }],
    ['object', { durationMs: { secret: 'PRIVATE_DURATION_CONTENT' } }]
  ])('%s is unknown rather than a zero or invalid latency sample', async (_label, duration) => {
    await InferenceLog.collection.insertOne(row(duration));
    const before = await InferenceLog.find().lean();
    const { body: { data } } = await read();
    expect(data.stats.lastHour).toMatchObject({ totalCalls: 1, avgLatencyMs: null,
      nonSuccessCount: 0, nonSuccessRate: 0, errorRate: 0 });
    expect(data.logs).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain('PRIVATE_DURATION_CONTENT');
    const rendered = await renderActivity(data);
    expect(rendered.initialHtml).toContain('id="nc-inf-latency">--</strong>');
    expect(rendered.refreshedLatency).toBe('--');
    expect(await InferenceLog.find().lean()).toEqual(before);

    // An invalid value must not poison the valid cohort or enter its denominator.
    await InferenceLog.create(row({ durationMs: 90000 }));
    const { body: { data: mixed } } = await read();
    expect(mixed.stats.lastHour).toMatchObject({ totalCalls: 2, avgLatencyMs: 90000, nonSuccessCount: 0 });
  });

  test('counts an existing schema-default zero as an unmeasured call', async () => {
    await InferenceLog.create(row());
    expect((await InferenceLog.findOne().lean()).durationMs).toBe(0);
    const { body: { data } } = await read();
    expect(data.stats.lastHour).toMatchObject({ totalCalls: 1, avgLatencyMs: null });
  });

  test('keeps long calls and measured non-successes in the mean, independently of list limit and filters', async () => {
    await InferenceLog.insertMany([
      row({ durationMs: 90000 }), row({ durationMs: 120000, status: 'error' }),
      row({ durationMs: 0, status: 'timeout' }),
      row({ durationMs: 10, host: 'http://secondary.example.test:11434', model: 'fixture/other', caller: 'chat' }),
      row({ durationMs: 1000, timestamp: new Date(Date.now() - 2 * 3600000) })
    ]);
    const before = await InferenceLog.find().sort({ _id: 1 }).lean();
    const query = { host: 'http://primary.example.test:11434', model: 'fixture/model', caller: 'proxy', limit: 1 };
    const { body: { data } } = await read(query);
    expect(data.logs).toHaveLength(1);
    expect(data.stats.lastHour).toMatchObject({ totalCalls: 3, avgLatencyMs: 105000,
      nonSuccessCount: 2, nonSuccessRate: 66.7, errorRate: 66.7 });
    const rendered = await renderActivity(data);
    expect(rendered.initialHtml).toContain('id="nc-inf-latency">105000</strong>');
    expect(rendered.refreshedLatency).toBe('105000');

    for (const [status, avgLatencyMs, nonSuccessCount] of [
      ['success', 90000, 0], ['error', 120000, 1], ['timeout', null, 1]
    ]) {
      const { body: { data: filtered } } = await read({ ...query, status });
      expect(filtered.stats.lastHour).toMatchObject({ totalCalls: 1, avgLatencyMs, nonSuccessCount });
    }
    expect(await InferenceLog.find().sort({ _id: 1 }).lean()).toEqual(before);
  });

  test('preserves valid measured timeout latency and rounded sub-millisecond observations', async () => {
    await InferenceLog.insertMany([row({ durationMs: 120000, status: 'timeout' }), row({ durationMs: 0.4 })]);
    const { body: { data: timedOut } } = await read({ status: 'timeout' });
    expect(timedOut.stats.lastHour).toMatchObject({ totalCalls: 1, avgLatencyMs: 120000, nonSuccessCount: 1 });
    const { body: { data: rounded } } = await read({ status: 'success' });
    expect(rounded.stats.lastHour).toMatchObject({ totalCalls: 1, avgLatencyMs: 0 });
  });

  test('preserves a finite BSON numeric average without admitting stored objects or numeric strings', async () => {
    const { Decimal128, Long } = require('mongodb');
    await InferenceLog.collection.insertMany([
      row({ durationMs: Decimal128.fromString('90000') }), row({ durationMs: Long.fromNumber(120000) }),
      row({ durationMs: '5000' }), row({ durationMs: { value: 5000 } })
    ]);
    const before = await InferenceLog.find().sort({ _id: 1 }).lean();
    const { body: { data } } = await read();
    expect(data.stats.lastHour).toMatchObject({ totalCalls: 4, avgLatencyMs: 105000 });
    expect(await InferenceLog.find().sort({ _id: 1 }).lean()).toEqual(before);
  });

  test('empty hourly activity stays unknown even when old log rows are listed', async () => {
    for (const withOldRow of [false, true]) {
      if (withOldRow) await InferenceLog.create(row({ durationMs: 5000, timestamp: new Date(Date.now() - 2 * 3600000) }));
      const { body: { data } } = await read();
      expect(data.stats.lastHour).toMatchObject({ totalCalls: 0, avgLatencyMs: null,
        nonSuccessCount: 0, nonSuccessRate: null, errorRate: null });
      expect(data.logs).toHaveLength(withOldRow ? 1 : 0);
    }
  });
});
