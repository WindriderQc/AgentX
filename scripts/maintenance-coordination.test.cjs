'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readCoordination } = require('./maintenance-coordination.cjs');
const snapshot = data => ({ ok: true, json: { status: 'success', data } });
const idle = { maintenance: null, workloads: [], inferences: [] };

test('a dropped GET is read once more within its original budget and retains active blockers', async () => {
  let time = 0;
  const timeouts = [], urls = [];
  const busy = { ...idle, inferences: [{ active: true, host: 'synthetic-host' }] };
  const actual = await readCoordination({ coreUrl: 'http://127.0.0.1:3180',
    now: () => time, pause: async ms => { time += ms; },
    read: async (url, options) => {
      urls.push(url); timeouts.push(options.timeoutMs);
      if (urls.length === 1) { time += 300; throw new TypeError('fetch failed'); }
      return snapshot(busy);
    } });
  assert.deepEqual(actual, busy);
  assert.deepEqual(timeouts, [10000, 9500]);
  assert.deepEqual(urls, [
    'http://127.0.0.1:3180/api/nerve-center/runtime-coordination/active',
    'http://127.0.0.1:3180/api/nerve-center/runtime-coordination/active'
  ]);
});

test('two failed reads stop without treating the instance as idle', async () => {
  let calls = 0;
  const error = new TypeError('fetch failed');
  await assert.rejects(readCoordination({ coreUrl: 'http://synthetic', pause: async () => {},
    read: async () => { calls++; throw error; } }), error);
  assert.equal(calls, 2);
});

test('an exhausted probe budget never starts a second request', async () => {
  let time = 0, calls = 0;
  const error = new TypeError('fetch failed');
  await assert.rejects(readCoordination({ coreUrl: 'http://synthetic', now: () => time,
    read: async () => { calls++; time = 10000; throw error; } }), error);
  assert.equal(calls, 1);
});

test('programming errors and explicit HTTP refusals are not transport retries', async () => {
  for (const error of [new Error('fetch failed'), new TypeError('invalid URL')]) {
    let calls = 0;
    await assert.rejects(readCoordination({ read: async () => { calls++; throw error; } }), error);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(readCoordination({ read: async () => {
    calls++; return { ok: false, status: 503, json: null };
  } }), /snapshot is unavailable/);
  assert.equal(calls, 1);
});

test('only a complete authoritative snapshot establishes idle; malformed or missing fields refuse', async () => {
  assert.deepEqual(await readCoordination({ read: async () => snapshot(idle) }), idle);
  for (const response of [
    { ok: true, json: null }, { ok: true, json: {} }, { ok: true, json: { data: idle } },
    snapshot({}), snapshot({ ...idle, maintenance: undefined }),
    snapshot({ ...idle, maintenance: [] }), snapshot({ ...idle, workloads: {} }),
    snapshot({ ...idle, inferences: null }),
    { ok: true, json: { status: 'error', data: idle } }
  ]) {
    await assert.rejects(readCoordination({ read: async () => response }), /snapshot is unavailable/);
  }
});

test('maintenance and UNKNOWN workloads remain blockers in a valid snapshot', async () => {
  const busy = { maintenance: { quarantined: true }, workloads: [{ recoveryRequired: true }], inferences: [] };
  assert.deepEqual(await readCoordination({ read: async () => snapshot(busy) }), busy);
});

test('an incomplete coordination read prevents the actual recreate driver from invoking its launcher', async () => {
  const { recreateWhenIdle } = require('./maintenance-actions.cjs');
  let launched = false;
  await assert.rejects(recreateWhenIdle({ services: ['core', 'benchmark'], deadline: Date.now() + 1000,
    waitIdle: () => readCoordination({ read: async () => ({ ok: true, json: {} }) }),
    recreate: () => { launched = true; return { status: 0 }; }
  }), /snapshot is unavailable/);
  assert.equal(launched, false);
});
