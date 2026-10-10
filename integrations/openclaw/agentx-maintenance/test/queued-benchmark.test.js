import test from 'node:test';
import assert from 'node:assert/strict';
import { queueBenchmark } from '../queued-benchmark.js';
const params = { action: 'benchmark-batch-prepare', host: 'http://127.0.0.1:11434', model: 'fixture:1b',
  judgeHost: 'http://127.0.0.1:11435', judgeModel: 'fixture:judge', categories: ['coding'] };
const context = { agentId: 'leadx', sessionKey: 'agent:leadx:subagent:synthetic', runId: 'run', toolCallId: 'call' };
const config = { agentxUrl: 'http://127.0.0.1:3180', queueCommand: '/synthetic/queue' };
test('preparation crosses the durable queue before the native executor and carries both hosts', async () => {
  const calls = []; let launches = 0;
  const result = await queueBenchmark(params, context, config, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url: String(url), body });
      return { ok: true, json: async () => ({ ok: true, data: { id: 'queue-id', revision: calls.length,
        state: calls.length === 1 ? 'requested' : 'reserved' } }) };
    }, run: async (_command, args) => {
      launches++; assert.equal(calls.length, 2); assert.ok(args.includes('queue-id'));
      return { id: 'queue-id', state: 'completed', releaseReceipt: { preparedPlan: 'synthetic-plan' } };
    }
  });
  assert.equal(launches, 1); assert.equal(result.result.start.plan, 'synthetic-plan');
  assert.deepEqual(calls[0].body.hosts, [params.host, params.judgeHost]);
  assert.equal(calls[0].body.executor.prepare, true);
});
test('a refused reservation returns its durable identity and never runs the command', async () => {
  let launches = 0;
  const result = await queueBenchmark(params, context, config, {
    fetchImpl: async url => ({ ok: !String(url).endsWith('/reserve'), json: async () => String(url).endsWith('/reserve')
      ? { ok: false, message: 'Synthetic conflict' } : { ok: true, data: { id: 'queue-id', revision: 1, state: 'requested' } } }),
    run: async () => { launches++; }
  });
  assert.equal(result.outcome, 'refused'); assert.equal(result.result.queueRequestId, 'queue-id'); assert.equal(launches, 0);
});
test('missing queue configuration and missing explicit judge refuse before I/O', async () => {
  let calls = 0; const deps = { fetchImpl: async () => { calls++; } };
  await assert.rejects(queueBenchmark(params, context, {}, deps), /nothing launched/);
  await assert.rejects(queueBenchmark({ ...params, judgeHost: undefined, judgeModel: undefined }, context, config, deps), /judge/);
  assert.equal(calls, 0);
});
