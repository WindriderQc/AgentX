'use strict';

// A /routing caller that leaves must cancel the snapshot's pending host reads
// and must not let it start new ones (#189).
const http = require('node:http');
const express = require('express');

jest.mock('../../config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const createRoutes = require('../../routes/external-consumer-v1');
const { buildEffectiveRoutingSnapshot } = require('../../src/services/routing/effectiveRoutingSnapshot');
const { readLiveDigest } = require('../../src/services/artifactIdentityService');

const HOST = 'http://ollama.test:11434';

// Each host read hangs until its signal aborts, like a jammed host.
function hangingReads() {
  const reads = [];
  let notify = () => {};
  const read = (signal) => new Promise((resolve, reject) => {
    reads.push(signal);
    notify();
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const next = (count) => new Promise((resolve) => {
    notify = () => { if (reads.length >= count) resolve(); };
    notify();
  });
  return { reads, read, next };
}

function snapshotDeps(read) {
  return {
    buildRouterConfigPayload: jest.fn(async () => ({
      hosts: { primary: HOST },
      taskModels: {
        general_chat: { model: 'model-a', host: 'primary' },
        code_generation: { model: 'model-b', host: 'primary' },
        analysis: { model: 'model-c', host: 'primary' }
      }
    })),
    hostPreferenceService: { getAll: jest.fn(async () => []), getPinnedEntries: () => [] },
    getContextInfo: jest.fn((model, host, options) => read(options?.signal)),
    resolveInferenceContract: jest.fn((input, options) => read(options?.signal)),
    modelsMatch: (left, right) => left === right,
    ModelRegistry: { find: jest.fn() }
  };
}

test('a departing /routing caller aborts pending catalog reads and starts no new ones', async () => {
  const hang = hangingReads();
  const deps = snapshotDeps(hang.read);
  let settled;
  const snapshotDone = new Promise((resolve) => { settled = resolve; });
  const runtimeServices = {
    inference: { execute: jest.fn() },
    routing: {
      getEffectiveSnapshot: (options) => {
        const pending = buildEffectiveRoutingSnapshot(deps, options);
        pending.then(settled, settled);
        return pending;
      }
    }
  };
  const app = express();
  app.use('/api/consumers/v1', createRoutes({ runtimeServices, systemHealth: { status: 'ok' } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const client = http.get(`http://127.0.0.1:${server.address().port}/api/consumers/v1/routing`);
    client.on('error', () => {});
    await hang.next(2);
    expect(hang.reads).toHaveLength(2);
    expect(hang.reads.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);

    client.destroy();
    await snapshotDone;

    expect(hang.reads.every((signal) => signal.aborted)).toBe(true);
    expect(hang.reads).toHaveLength(2);
    expect(deps.getContextInfo).toHaveBeenCalledTimes(1);
    expect(deps.resolveInferenceContract).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an aborted snapshot starts no host read at all', async () => {
  const hang = hangingReads();
  const deps = snapshotDeps(hang.read);
  const controller = new AbortController();
  controller.abort(new Error('caller left'));
  await expect(buildEffectiveRoutingSnapshot(deps, { signal: controller.signal }))
    .rejects.toThrow('caller left');
  expect(deps.buildRouterConfigPayload).not.toHaveBeenCalled();
  expect(hang.reads).toHaveLength(0);
});

test('the live /api/tags read follows its caller signal', async () => {
  const controller = new AbortController();
  let seen;
  let started;
  const called = new Promise((resolve) => { started = resolve; });
  const fetchImpl = jest.fn((url, { signal }) => new Promise((resolve, reject) => {
    seen = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    started();
  }));
  const pending = readLiveDigest('model-a', HOST, { fetchImpl, signal: controller.signal });
  await called;
  expect(fetchImpl).toHaveBeenCalledWith(`${HOST}/api/tags`, { signal: expect.any(AbortSignal) });
  expect(seen.aborted).toBe(false);
  controller.abort(new Error('caller left'));
  await expect(pending).resolves.toBeNull();
  expect(seen.aborted).toBe(true);

  fetchImpl.mockClear();
  await expect(readLiveDigest('model-a', HOST, { fetchImpl, signal: controller.signal })).resolves.toBeNull();
  expect(fetchImpl).not.toHaveBeenCalled();
});
