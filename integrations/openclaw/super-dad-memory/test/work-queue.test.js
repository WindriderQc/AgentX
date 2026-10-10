import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWorkQueue } from '../work-queue.js';
import { recordTool } from '../harness.js';
import { readState } from '../store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const context = { agentId: 'main', runId: 'synthetic-run', sessionKey: 'agent:main:household:direct:11111111-1111-4111-8111-111111111111' };
function setup() {
  let factory; const hooks = {}, calls = [];
  const api = { config: {}, pluginConfig: { agentxUrl: 'http://127.0.0.1:3180', briefingSessionKeys: ['agent:main:cron:synthetic'] },
    registerTool(value) { factory = value; }, on(name, handler) { hooks[name] = handler; } };
  registerWorkQueue(api, { fetchImpl: async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ status: 'success', data: { id: 'synthetic-request', state: 'requested' } }) };
  } });
  return { factory: ctx => factory(ctx), hooks, calls };
}
test('only the owner and configured read-only morning context receive the tool', async () => {
  const { factory } = setup();
  for (const ctx of [{ ...context, agentId: 'family' }, { ...context, sandboxed: true }, { ...context, sessionKey: 'agent:main:telegram:group:12' }]) assert.equal(factory(ctx), null);
  const morning = factory({ agentId: 'main', sessionKey: 'agent:main:cron:synthetic:run' });
  assert.deepEqual(morning.parameters.properties.action.enum, ['list', 'show', 'notifications']);
  await assert.rejects(morning.execute('call', { action: 'acknowledge', id: 'synthetic' }), /read-only/);
});
test('native identity binds request replay and source; no execution fields are relayed', async () => {
  const { factory, calls } = setup();
  const params = { action: 'request', title: 'Synthetic profiler', kind: 'profiler', hosts: ['http://127.0.0.1:11434'], estimatedMinutes: 30,
    taskId: 'fixture-task', notBefore: '2030-01-01T00:00:00Z' };
  await factory(context).execute('call', params); await factory(context).execute('call', params);
  assert.equal(calls[0].body.request.key, calls[1].body.request.key);
  assert.equal(calls[0].body.request.source.ref, context.sessionKey);
  assert.equal(calls[0].body.request.executor, undefined);
  assert.equal(calls[0].body.request.source.taskId, params.taskId);
  await factory({ ...context, runId: 'different-run' }).execute('call', params);
  assert.notEqual(calls[0].body.request.key, calls[2].body.request.key);
});
test('missing native identity refuses before sending a planning write', async () => {
  const { factory, hooks, calls } = setup(); const native = { ...context }; delete native.runId;
  const tool = factory(native);
  await assert.rejects(tool.execute('call', { action: 'request' }), /identity/);
  assert.equal(calls.length, 0);
  hooks.before_tool_call({ toolName: 'work_queue', toolCallId: 'call', runId: 'sdk-run' }, native);
  await tool.execute('call', { action: 'request', title: 'Fixture', kind: 'other', hosts: ['http://127.0.0.1:11434'], estimatedMinutes: 1 });
  assert.equal(calls.length, 1);
});
test('continuity keeps the verified queue observation and its uncertain execution state separately', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'nestor-queue-observation-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const id = '11111111-1111-4111-8111-111111111111';
  for (const state of ['requested', 'uncertain', 'completed']) {
    await recordTool(workspace, { toolName: 'work_queue', toolCallId: state,
      result: { details: { authority: 'core.heavy-work-queue', id, state } } }, context);
    const receipt = (await readState(workspace)).receipts.at(-1);
    assert.equal(receipt.status, 'verified'); assert.deepEqual(receipt.queueRequest, { id, state });
    assert.equal(receipt.resultRef, 'heavy-work:' + id); assert.equal(receipt.deliveryState, 'unknown');
  }
  await recordTool(workspace, { toolName: 'work_queue', toolCallId: 'unproved', result: { details: { id, state: 'completed' } } }, context);
  assert.equal((await readState(workspace)).receipts.at(-1).status, 'unknown');
});
