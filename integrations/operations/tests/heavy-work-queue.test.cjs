'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, runJob, main } = require('../heavy-work-queue.cjs');
const job = { id: '00000000-0000-4000-8000-000000000001', revision: 2, kind: 'benchmark', executor: { plan: 'synthetic' } };

test('requires an explicit instance and named actor; rejects unknown commands', () => {
  assert.throws(() => parse(['run', '--core', 'http://localhost:3180', '--id', job.id]), /actor/);
  assert.throws(() => parse(['shell', '--core', 'http://localhost:3180']), /Use/);
  assert.throws(() => parse(['list', '--core', 'http://localhost:3180', '--command', 'anything']), /Unsupported/);
});
test('operator jobs and Core-owned images refuse ordinary run before any dispatch', async () => {
  let calls = 0;
  for (const item of [{ ...job, kind: 'diagnostic', executor: { mode: 'operator' } }, { ...job, kind: 'image', executor: { mode: 'image-operation' } }]) {
    await assert.rejects(runJob(item, async () => { calls++; }, {}), /no dispatch was recorded/);
  }
  assert.equal(calls, 0);
});
test('custom operator completion hashes the exact local receipt and cannot finish another dispatch', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-receipt-'));
  const file = path.join(dir, 'synthetic.json'); const current = { ...job, kind: 'diagnostic', state: 'dispatching', dispatchId: 'synthetic-dispatch', executor: { mode: 'operator', receiptRef: 'synthetic.json' } };
  const receipt = { contract: 'agentx.operator-heavy-work/v1', queueRequestId: job.id, dispatchId: current.dispatchId,
    actor: 'fixture', state: 'completed', runtimeReleased: true, receiptRef: 'synthetic.json' };
  const writes = [];
  const deps = { fetchImpl: async (_url, options) => {
    if (options.body) writes.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, data: current }) };
  } };
  const args = ['finish-operator', '--core', 'http://127.0.0.1:3180', '--actor', 'fixture', '--id', job.id, '--revision', '2', '--file', file];
  try {
    const bytes = JSON.stringify(receipt); fs.writeFileSync(file, bytes);
    await main(args, deps);
    assert.equal(writes[0].receiptSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    fs.writeFileSync(file, JSON.stringify({ ...receipt, dispatchId: 'different' }));
    await assert.rejects(main(args, deps), /differs/); assert.equal(writes.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
