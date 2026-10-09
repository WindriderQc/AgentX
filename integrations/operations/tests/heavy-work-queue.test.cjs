'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, runJob } = require('../heavy-work-queue.cjs');
const job = { id: '00000000-0000-4000-8000-000000000001', revision: 2, kind: 'benchmark', executor: { plan: 'synthetic' } };

test('requires an explicit instance and named actor; rejects unknown commands', () => {
  assert.throws(() => parse(['run', '--core', 'http://localhost:3180', '--id', job.id]), /actor/);
  assert.throws(() => parse(['shell', '--core', 'http://localhost:3180']), /Use/);
  assert.throws(() => parse(['list', '--core', 'http://localhost:3180', '--command', 'anything']), /Unsupported/);
});
test('marks dispatch before the native launch and saves its exact operation', async () => {
  const events = [];
  const client = async (endpoint, body) => {
    events.push([endpoint, body]);
    if (endpoint.endsWith('/begin')) return { ...job, dispatchId: 'synthetic-dispatch' };
    return body;
  };
  const result = await runJob(job, client, { actor: 'test', benchmarkExecutor: async (_job, { assertDispatch }) => {
    assert.equal(events[0][0], `/${job.id}/begin`);
    await assertDispatch(); events.push(['effect']);
    return { batchId: 'synthetic-batch' };
  } });
  assert.equal(result.operationId, 'synthetic-batch');
  assert.deepEqual(events.map(item => item[0]), [`/${job.id}/begin`, `/${job.id}/assert-dispatch`, 'effect', `/${job.id}/record`]);
});
test('never calls the executor when the dispatch fence refuses', async () => {
  let calls = 0;
  await assert.rejects(runJob(job, async () => { throw new Error('Stale request'); }, {
    benchmarkExecutor: async () => { calls++; }
  }), /Stale/);
  assert.equal(calls, 0);
});
test('retains uncertainty on lost launch and lost final writes without a retry', async () => {
  let launches = 0;
  const recorded = [];
  const client = async (endpoint, body) => {
    if (endpoint.endsWith('/begin')) return { ...job, dispatchId: 'synthetic-dispatch' };
    recorded.push(body); throw new Error('Synthetic DB response lost');
  };
  await assert.rejects(runJob(job, client, { benchmarkExecutor: async () => {
    launches++; throw new Error('Synthetic executor response lost');
  } }), error => error.outcome === 'uncertain' && error.queueId === job.id);
  assert.equal(launches, 1);
  assert.equal(recorded[0].state, 'uncertain');
});
