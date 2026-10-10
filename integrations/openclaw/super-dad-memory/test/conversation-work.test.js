import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerConversationWork } from '../conversation-work.js';
import { recordTool, recordRun } from '../harness.js';
import { continuityOperations } from '../continuity.js';
const runId = 'resp_22222222-2222-4222-8222-222222222222';
const native = agentId => ({ agentId, sessionKey: `agent:${agentId}:household:direct:11111111-1111-4111-8111-111111111111`, runId });
function setup(fetchImpl) {
  const hooks = {}, posted = []; let factory;
  registerConversationWork({ pluginConfig: { agentxUrl: 'http://core.test', conversationWorkAgentId: 'worker',
    conversationWorkToken: 'synthetic-secret-value' }, on(name, hook) { hooks[name] = hook; }, registerTool(value) { factory = value; } },
  { fetchImpl: async (url, options) => {
    posted.push({ url, options, body: JSON.parse(options.body) });
    return fetchImpl ? fetchImpl(posted.at(-1)) : { ok: true, json: async () => ({ ok: true,
      data: { authority: 'core.conversation-works', accepted: true, id: 'a'.repeat(64), state: 'queued', execution: 'pending' } }) };
  } });
  return { hooks, factory: context => factory(context), posted };
}
test('the host-bound tool is optional, packaged, and keeps its private token outside the model schema', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url)));
  const pack = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.ok(manifest.contracts.tools.includes('conversation_work')); assert.ok(pack.files.includes('conversation-work.js'));
  const h = setup();
  assert.equal(h.factory(native('family')), null); assert.equal(h.factory(native('secretary')), null);
  const main = h.factory(native('main')), worker = h.factory(native('worker'));
  assert.deepEqual(main.parameters.properties.operation.enum, ['request']);
  assert.deepEqual(worker.parameters.properties.operation.enum, ['context', 'tasks', 'publish']);
  assert.equal(JSON.stringify(main).includes('synthetic-secret-value'), false);
  assert.equal(main.parameters.properties.workId, undefined);
});
test('execute binds the real call id and run from the hook, and never trusts factory/model run parameters', async () => {
  const h = setup(), context = native('main'), tool = h.factory({ ...context, runId: 'invented-factory-run' });
  await assert.rejects(tool.execute('call', { operation: 'request' }), /binding is unavailable/);
  assert.equal(h.posted.length, 0);
  await h.hooks.before_tool_call({ toolName: 'conversation_work', toolCallId: 'call', runId }, context);
  const response = await tool.execute('call', { operation: 'request', runId: 'model-forgery' });
  assert.equal(response.details.accepted, true);
  assert.deepEqual(h.posted[0].body.context, context);
  assert.equal(h.posted[0].body.callId, 'call');
  assert.equal(h.posted[0].options.headers.Authorization, 'Bearer synthetic-secret-value');
  await h.hooks.after_tool_call({ toolCallId: 'call' }, context);
  await assert.rejects(tool.execute('call', { operation: 'request' }), /binding is unavailable/);
});
test('the guardian legacy read is blocked only when Core owns that current turn', async () => {
  const h = setup(), context = native('main');
  const blocked = await h.hooks.before_tool_call({ toolName: 'list_personal_tasks', toolCallId: 'read', runId }, context);
  assert.equal(blocked.block, true); assert.match(blocked.blockReason, /not a completed task lookup/);
  assert.equal(await h.hooks.before_tool_call({ toolName: 'list_personal_tasks' }, native('family')), undefined);
  const legacy = setup(async () => ({ ok: false, status: 404, json: async () => ({ message: 'No migrated turn' }) }));
  assert.equal(await legacy.hooks.before_tool_call({ toolName: 'list_personal_tasks', runId }, context), undefined);
});
test('deferred tool calls preserve actual native identity and enforce the selected role', async () => {
  const h = setup(), context = native('worker'), tool = h.factory(context);
  await h.hooks.before_tool_call({ toolName: 'tool_call', params: { id: 'plugin:super-dad-memory:conversation_work' }, toolCallId: 'wrapped', runId }, context);
  await assert.rejects(tool.execute('wrapped', { operation: 'request' }), /role cannot/);
  await tool.execute('wrapped', { operation: 'tasks', limit: 5, actor: 'family' });
  assert.deepEqual(h.posted[0].body.input, { limit: 5 });
  assert.equal(h.posted[0].body.context.agentId, 'worker');
});
test('acceptance, verified read and publication have different native receipts without claiming playback', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-work-proof-')); t.after(() => rm(workspace, { recursive: true }));
  const context = { ...native('main'), toolCallId: 'accept' };
  await recordTool(workspace, { toolName: 'conversation_work', result: { details: {
    authority: 'core.conversation-works', accepted: true, id: 'a'.repeat(64), execution: 'pending', state: 'queued' } } }, context);
  await recordRun(workspace, { success: true }, context);
  const evidence = await continuityOperations({ workspace })({ operation: 'turn', sessionKey: context.sessionKey, runId });
  assert.equal(evidence.receipts[0].status, 'verified'); assert.equal(evidence.receipts[0].acceptedWork.id, 'a'.repeat(64));
  assert.equal(evidence.receipts[0].deliveryState, 'unknown'); assert.equal(evidence.receipts[0].workRead, undefined);
  await recordTool(workspace, { toolName: 'conversation_work', result: { details: { authority: 'core.conversation-works',
    receipt: { id: 'b'.repeat(64), tool: 'tasks.personal.list', status: 'verified', runId }, data: { tasks: [] } } } },
    { ...context, toolCallId: 'read' });
  const read = await continuityOperations({ workspace })({ operation: 'turn', sessionKey: context.sessionKey, runId });
  assert.equal(read.receipts.at(-1).workRead.tool, 'tasks.personal.list');
  assert.equal(read.receipts.at(-1).acceptedWork, undefined);
});
test('the feature is absent until the instance supplies the native worker and private binding', () => {
  registerConversationWork({ pluginConfig: { agentxUrl: 'http://core.test' }, on() { assert.fail('Inactive hook'); }, registerTool() { assert.fail('Inactive tool'); } });
});
