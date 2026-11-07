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
    actor: 'fixture', state: 'completed', runtimeReleased: true, receiptRef: 'synthetic.json',
    loadTest: { name: 'Synthetic load', scenario: 'synthetic', timestamp: '2026-01-02T03:04:05Z',
      raw_report: { aggregate: { counters: {}, summaries: {} } } } };
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
    assert.deepEqual(writes[0].loadTest, receipt.loadTest);
    current.state = 'completed'; current.revision++;
    current.releaseReceipt = { loadTestHash: 'b'.repeat(64) };
    // A lost finish response leaves the caller with the original command and
    // revision. Core can reconcile this terminal receipt without a mutation.
    await main(args, deps);
    assert.equal(writes[1].receiptSha256, writes[0].receiptSha256);
    assert.deepEqual(writes[1].loadTest, writes[0].loadTest);
    assert.equal(writes[1].expectedRevision, 2);
    fs.writeFileSync(file, JSON.stringify({ ...receipt, dispatchId: 'different' }));
    await assert.rejects(main(args, deps), /differs/); assert.equal(writes.length, 2);
    const { loadTest, ...withoutReport } = receipt;
    fs.writeFileSync(file, JSON.stringify(withoutReport));
    await assert.rejects(main(args, deps), /Request changed/); assert.equal(writes.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('stale revisions still refuse active writes, unrelated terminal receipts and begin before any effect', async () => {
  const cases = [
    { action: 'finish-operator', state: 'dispatching', releaseReceipt: { loadTestHash: 'b'.repeat(64) } },
    { action: 'finish-operator', state: 'completed' },
    { action: 'begin-operator', state: 'completed', releaseReceipt: { loadTestHash: 'b'.repeat(64) } }
  ];
  for (const item of cases) {
    let reads = 0;
    const deps = { fetchImpl: async (_url, options) => {
      assert.equal(options.body, undefined); reads++;
      return { ok: true, json: async () => ({ ok: true, data: { ...job, ...item } }) };
    } };
    await assert.rejects(main([item.action, '--core', 'http://127.0.0.1:3180', '--actor', 'fixture',
      '--id', job.id, '--revision', '1'], deps), /Request changed/);
    assert.equal(reads, 1);
  }
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
    if (body) recorded.push(body); throw new Error('Synthetic DB response lost');
  };
  await assert.rejects(runJob(job, client, { benchmarkExecutor: async () => {
    launches++; throw new Error('Synthetic executor response lost');
  } }), error => error.outcome === 'uncertain' && error.queueId === job.id);
  assert.equal(launches, 1);
  assert.equal(recorded[0].state, 'uncertain');
});

for (const lostReply of [false, true]) test(`records an explicit preparation refusal without uncertainty (lost reply: ${lostReply})`, async () => {
  const preparation = { ...job, executor: { prepare: true } };
  const events = [];
  let launches = 0;
  const terminal = { ...preparation, state: 'failed', preparationRefusal: { dispatchId: 'synthetic-dispatch' },
    releaseReceipt: { authority: 'operator-preparation-refusal' } };
  const client = async (endpoint, body) => {
    events.push([endpoint, body]);
    if (endpoint.endsWith('/begin')) return { ...preparation, dispatchId: 'synthetic-dispatch' };
    if (endpoint.endsWith('/prepared')) {
      assert.deepEqual(body, { dispatchId: 'synthetic-dispatch', refusal: { code: 'PREFLIGHT_NOT_READY', reason: 'Synthetic preflight refusal' } });
      if (lostReply) throw new Error('Synthetic reply lost after commit');
    }
    return terminal;
  };
  await assert.rejects(runJob(preparation, client, { benchmarkExecutor: async () => {
    launches++;
    throw Object.assign(new Error('Synthetic preflight refusal'), { outcome: 'refused', preparationNotStarted: true, details: { code: 'PREFLIGHT_NOT_READY' } });
  } }), error => error.outcome === 'refused' && error.queueId === job.id);
  assert.equal(launches, 1);
  assert.deepEqual(events.map(([endpoint]) => endpoint), [`/${job.id}/begin`, `/${job.id}/prepared`, ...(lostReply ? [`/${job.id}`] : [])]);
});

for (const kind of ['untyped-refusal', 'lost-preflight', 'batch-start', 'receipt-unavailable', 'runtime-held']) {
  test(`keeps the fence for ${kind} and never repeats preparation`, async () => {
    const preparation = { ...job, executor: { prepare: kind !== 'batch-start' } };
    const events = [];
    let launches = 0;
    const client = async (endpoint, body) => {
      events.push([endpoint, body]);
      if (endpoint.endsWith('/begin')) return { ...preparation, dispatchId: 'synthetic-dispatch' };
      if (kind === 'receipt-unavailable' && !endpoint.endsWith('/record')) throw new Error('Synthetic Core unavailable');
      return { ...preparation, state: 'uncertain' };
    };
    await assert.rejects(runJob(preparation, client, { benchmarkExecutor: async () => {
      launches++;
      throw Object.assign(new Error('Synthetic refusal or lost response'), {
        outcome: kind === 'lost-preflight' ? 'unknown' : 'refused',
        preparationNotStarted: kind !== 'untyped-refusal' && kind !== 'lost-preflight', details: { code: 'PREFLIGHT_NOT_READY' }
      });
    } }), error => error.outcome === 'uncertain');
    assert.equal(launches, 1);
    assert.equal(events.at(-1)[1].state, 'uncertain');
    assert.equal(events.some(([endpoint]) => endpoint.endsWith('/prepared')), ['receipt-unavailable', 'runtime-held'].includes(kind));
  });
}

for (const lostReply of [false, true]) test(`batch no-start persists a refusal and reconciles a lost receipt reply (${lostReply})`, async () => {
  const events = [];
  let launches = 0;
  let current;
  const client = async (endpoint, body) => {
    events.push([endpoint, body]);
    if (endpoint.endsWith('/begin')) return { ...job, dispatchId: 'synthetic-dispatch' };
    if (endpoint.endsWith('/refused')) {
      current = { ...job, state: 'failed', launchRefusal: body, releaseReceipt: { authority: 'operator-launch-refusal' } };
      if (lostReply) throw new Error('Lost after receipt committed');
    }
    return current;
  };
  await assert.rejects(runJob(job, client, { benchmarkExecutor: async () => {
    launches++;
    throw Object.assign(new Error('Synthetic plan stale before POST'), { notStarted: true, outcome: 'refused', details: { code: 'PLAN_STALE' } });
  } }), error => error.outcome === 'refused' && error.queueId === job.id);
  assert.equal(launches, 1);
  assert.equal(current.launchRefusal.code, 'PLAN_STALE');
  assert.deepEqual(events.map(([endpoint]) => endpoint), [`/${job.id}/begin`, `/${job.id}/refused`, ...(lostReply ? [`/${job.id}`] : [])]);
});

for (const typed of [true, false]) test(`Profiler HTTP refusal preserves its native verdict (typed: ${typed})`, async () => {
  const profile = { ...job, kind: 'profiler', executor: { hostId: 'fixture' } };
  const events = [];
  const client = async (endpoint, body) => {
    events.push([endpoint, body]);
    if (endpoint.endsWith('/begin')) return { ...profile, dispatchId: 'synthetic-dispatch' };
    if (endpoint.endsWith('/refused')) return { ...profile, state: 'failed', launchRefusal: body, releaseReceipt: { authority: 'operator-launch-refusal' } };
    return body;
  };
  let posts = 0;
  const launchReceipt = require('../../../shared/queueLaunchReceipt.cjs').refusal(profile.id, profile.kind, { notStarted: true, code: 'HOST_OFFLINE', message: 'Before claim' });
  await assert.rejects(runJob(profile, client, { benchmark: 'http://localhost:3081', fetchImpl: async () => {
    posts++;
    return { ok: false, status: 503, json: async () => ({ error: 'Host offline', ...(typed && { launchReceipt }) }) };
  } }), error => error.outcome === (typed ? 'refused' : 'uncertain'));
  assert.equal(posts, 1);
  assert.equal(events.some(([endpoint]) => endpoint.endsWith('/refused')), typed);
});

test('a lost native HTTP failure reads the producer refusal instead of replacing it with uncertainty', async () => {
  const profile = { ...job, kind: 'profiler', executor: { hostId: 'fixture' } };
  const events = [];
  const dispatchId = 'synthetic-dispatch';
  const client = async (endpoint, body) => {
    events.push([endpoint, body]);
    if (endpoint.endsWith('/begin')) return { ...profile, dispatchId };
    return { ...profile, dispatchId, state: 'failed', launchRefusal: { dispatchId, code: 'HOST_OFFLINE', reason: 'Synthetic producer refusal' } };
  };
  let posts = 0;
  await assert.rejects(runJob(profile, client, { benchmark: 'http://localhost:3081', fetchImpl: async () => {
    posts++; throw new Error('Synthetic native refusal response lost');
  } }), error => error.outcome === 'refused');
  assert.equal(posts, 1);
  assert.equal(events.some(([endpoint]) => endpoint.endsWith('/record')), false);
});

test('refusal protocol binds the intent and never treats an untyped status as proof', async () => {
  const { refusal, readRefusal, publishRefusal } = require('../../../shared/queueLaunchReceipt.cjs');
  assert.equal(refusal(job.id, 'benchmark', { statusCode: 409 }), null);
  const launchReceipt = refusal(job.id, 'benchmark', { notStarted: true, code: 'NOT_READY', message: 'Synthetic refusal' });
  assert.deepEqual(readRefusal({ launchReceipt }, job), launchReceipt);
  for (const change of [{ kind: 'image' }, { requestId: 'foreign' }, { outcome: 'unknown' }, { reason: '' }]) {
    assert.equal(readRefusal({ launchReceipt: { ...launchReceipt, ...change } }, job), null);
  }
  let writes = 0;
  const post = async () => { writes++; };
  await publishRefusal(null, job.id, post);
  await publishRefusal(launchReceipt, 'bad-dispatch', post);
  assert.equal(writes, 0);
  await publishRefusal(launchReceipt, job.id, post);
  assert.equal(writes, 1);
});

test('a retained preparation plan does not report success while native release remains held', async () => {
  const preparation = { ...job, executor: { prepare: true } };
  const events = [];
  let launches = 0;
  const client = async (endpoint, body) => {
    events.push([endpoint, body]);
    if (endpoint.endsWith('/begin')) return { ...preparation, dispatchId: 'synthetic-dispatch' };
    return { ...preparation, state: 'running', operation: { id: 'synthetic-plan' }, preparationReceipt: { preparedPlan: 'synthetic-plan' } };
  };
  await assert.rejects(runJob(preparation, client, { benchmarkExecutor: async () => { launches++; return { plan: 'synthetic-plan' }; } }),
    error => error.outcome === 'uncertain' && /release still needs reconciliation/.test(error.message));
  assert.equal(launches, 1);
  assert.equal(events.filter(([endpoint]) => endpoint.endsWith('/prepared')).length, 1);
});
