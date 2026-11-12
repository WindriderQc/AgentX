import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordTool } from '../harness.js';
import { digest, readState } from '../store.js';

const context = { agentId: 'guardian', sessionKey: 'agent:guardian:household:direct:11111111-1111-4111-8111-111111111111',
  runId: 'resp_22222222-2222-4222-8222-222222222222', toolCallId: 'call|item-1' };
function result() {
  const content = JSON.stringify({ operation: 'add', result: 5 });
  return { authority: 'core.conversation-works', receipt: { ...context, callId: context.toolCallId,
    id: digest(JSON.stringify([context.agentId, context.sessionKey, context.runId, context.toolCallId])), tool: 'math', status: 'completed' },
  result: { message: { role: 'tool', tool_name: 'math', content }, receipt: { authority: 'core.guardian-reads',
    tool: 'math', status: 'completed', resultSha256: digest(content) } } };
}
async function fixture(t) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-guardian-receipt-')); t.after(() => rm(workspace, { recursive: true }));
  return async (data, extra = {}, native = context) => {
    await recordTool(workspace, { toolName: 'conversation_work', params: { operation: 'guardian_read', name: 'math', args: { operation: 'add', a: 2, b: 3 } },
      result: { details: data }, ...extra }, native, { pluginConfig: { conversationGuardianAgentId: 'guardian', conversationWorkAgentId: 'worker' } });
    return (await readState(workspace)).receipts.at(-1);
  };
}
test('only the completed Core guardian receipt with exact native identity and content hash is verified', async t => {
  const record = await fixture(t), data = result(); data.receipt.unrelated = 'synthetic-private-value';
  const receipt = await record(data);
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.guardianRead.callId, context.toolCallId);
  assert.equal(receipt.guardianRead.resultSha256, data.result.receipt.resultSha256);
  assert.equal(receipt.workRead, undefined); assert.equal(receipt.deliveryState, 'unknown');
  assert.equal(receipt.guardianRead.unrelated, undefined);
  assert.equal(JSON.stringify(receipt).includes('"result":5'), false, 'No result payload enters the native capsule');
});
test('forged identity, mismatched content, refusal and reference observations cannot claim a new verified read', async t => {
  const record = await fixture(t);
  for (const change of [data => { data.receipt.runId = 'foreign'; }, data => { data.receipt.sessionKey += '-foreign'; },
    data => { data.receipt.agentId = 'main'; }, data => { data.receipt.callId = 'foreign'; }, data => { data.receipt.id = '0'.repeat(64); },
    data => { data.receipt.tool = 'personal_memory'; }, data => { data.result.receipt.resultSha256 = '0'.repeat(64); },
    data => { data.result.message.content += ' '; }, data => { data.result.receipt.authority = 'untrusted'; },
    data => { data.receipt.status = 'failed'; }, data => { data.receipt.status = 'refused'; }, data => { data.receipt.status = 'uncertain'; },
    data => { data.result.receipt.status = 'failed'; }, data => { data.reused = true; data.requestedCallId = 'other'; }]) {
    const data = result(); change(data);
    const receipt = await record(data);
    assert.notEqual(receipt.status, 'verified'); assert.equal(receipt.guardianRead, undefined);
  }
  assert.notEqual((await record(result(), { runId: 'foreign' })).status, 'verified');
  assert.notEqual((await record(result(), { toolCallId: 'foreign' })).status, 'verified');
});
test('absent or partial native identities cannot verify an undefined-equality receipt', async t => {
  const record = await fixture(t);
  for (const missing of [['agentId', 'sessionKey', 'runId', 'toolCallId'], ['agentId'], ['sessionKey'], ['runId'], ['toolCallId']]) {
    const native = { ...context }, data = result();
    for (const key of missing) { delete native[key]; delete data.receipt[key === 'toolCallId' ? 'callId' : key]; }
    data.receipt.id = digest(JSON.stringify([native.agentId, native.sessionKey, native.runId, native.toolCallId]));
    const receipt = await record(data, {}, native);
    assert.equal(receipt.status, 'unknown'); assert.equal(receipt.guardianRead, undefined);
  }
});
test('malformed identities and an event error never retain a verified guardian read capsule', async t => {
  const record = await fixture(t);
  for (const [key, value] of [['agentId', 'main'], ['agentId', 'worker'], ['sessionKey', 'agent:guardian:household:direct:bad'],
    ['sessionKey', 'agent:guardian:household:direct:extra:11111111-1111-4111-8111-111111111111'], ['runId', 'invalid'], ['toolCallId', 'invalid call']]) {
    const native = { ...context, [key]: value }, data = result();
    data.receipt[key === 'toolCallId' ? 'callId' : key] = value;
    data.receipt.id = digest(JSON.stringify([native.agentId, native.sessionKey, native.runId, native.toolCallId]));
    assert.equal((await record(data, {}, native)).guardianRead, undefined);
  }
  assert.equal((await record(result(), { error: 'native failure' })).guardianRead, undefined);
  assert.equal((await record(result(), { result: { details: result(), isError: true } })).guardianRead, undefined);
});
