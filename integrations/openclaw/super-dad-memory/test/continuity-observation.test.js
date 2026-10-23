import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { continuityOperations, continuityHttpHandler, nativeTurnProgress } from '../continuity.js';
import { updateState } from '../store.js';

const sessionKey = 'agent:main:household:direct:11111111-1111-4111-8111-111111111111';
const runId = 'resp_22222222-2222-4222-8222-222222222222';

test('progress retains the complete composite native identity while tool names stay strict', () => {
  const id = 'call_synthetic_shared|fc_synthetic_item';
  const messages = [{ role: 'assistant', __openclaw: { runId, id: 'native-message' }, content: [
    { type: 'toolCall', id, name: 'tool_call', arguments: { id: 'example:web_fetch', args: { url: 'private-example' } } },
    { type: 'toolCall', id: 'other-call', name: 'web_fetch|forged', arguments: {} }
  ] }];
  assert.deepEqual(nativeTurnProgress({ sessionKey, messages }, sessionKey, runId), [{ id, tool: 'web_fetch' }]);
});

test('a failed transcript read is explicit while the HTTP capsule stays fresh and private', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-continuity-observation-'));
  t.after(() => rm(workspace, { recursive: true }));
  let reads = 0;
  const operate = continuityOperations({ workspace, readHistory: async () => {
    if (++reads > 1) throw new Error('Private transcript diagnostic');
    return { sessionKey, messages: [{ role: 'assistant', stopReason: 'stop',
      __openclaw: { runId }, content: [{ type: 'text', text: 'Verified answer.' }] }] };
  } });
  const handler = continuityHttpHandler(operate);
  const read = async () => {
    const req = [Buffer.from(JSON.stringify({ operation: 'turn', runId, sessionKey }))];
    req.method = 'POST';
    const res = { setHeader() {}, end(raw) { this.body = JSON.parse(raw); } };
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    return res.body;
  };
  await updateState(workspace, () => ({ schemaVersion: 1, runs: [{ runId, sessionKey, model: 'first-hook' }], receipts: [] }));
  const first = await read();
  assert.equal(first.answer.text, 'Verified answer.');
  assert.equal(first.answerObservation, undefined);
  const fresh = { runId, sessionKey, tool: 'personal_memory', status: 'verified' };
  await updateState(workspace, () => ({ schemaVersion: 1, runs: [{ runId, sessionKey, model: 'later-hook' }], receipts: [fresh] }));
  const partial = await read();
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.answer, { status: 'unavailable', source: 'openclaw/sessions.get', runId });
  assert.deepEqual(partial.answerObservation, { status: 'unavailable', reason: 'read_failed',
    source: 'openclaw/sessions.get', runId, sessionKey });
  assert.equal(partial.run.model, 'later-hook');
  assert.deepEqual(partial.receipts, [fresh]);
  assert.equal(JSON.stringify(partial).includes('Private transcript diagnostic'), false);
});

test('missing, malformed, unrelated and non-final histories never claim a read failure', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-continuity-observation-'));
  t.after(() => rm(workspace, { recursive: true }));
  const nonFinal = { role: 'assistant', stopReason: 'stop', phase: 'commentary',
    __openclaw: { runId }, content: [{ type: 'text', text: 'Still working.' }] };
  for (const history of [undefined, null, {}, { sessionKey, messages: null },
    { sessionKey: 'another-session', messages: [] }, { sessionKey, messages: [] },
    { sessionKey, messages: [nonFinal] }]) {
    const operate = continuityOperations({ workspace, readHistory: async () => history });
    const projection = await operate({ operation: 'turn', runId, sessionKey });
    assert.equal(projection.answer.status, 'unavailable');
    assert.equal(projection.answerObservation, undefined);
  }
  for (const readHistory of [undefined, null, false, {}]) {
    const projection = await continuityOperations({ workspace, readHistory })({ operation: 'turn', runId, sessionKey });
    assert.equal(projection.answer.status, 'unavailable');
    assert.equal(projection.answerObservation, undefined);
  }
});

test('a native failed-before-reply marker settles the exact run even without an agent_end capsule', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-native-terminal-'));
  t.after(() => rm(workspace, { recursive: true }));
  const marker = { role: 'custom', customType: 'run-failed-before-reply',
    details: { runId, error: 'Private provider authentication diagnostic' }, timestamp: 1700000000000,
    __openclaw: { id: 'native-terminal-message', recordTimestampMs: 1700000000000 } };
  let history = { sessionKey, messages: [marker] };
  const operate = continuityOperations({ workspace, readHistory: async () => history });
  const result = await operate({ operation: 'turn', sessionKey, runId });
  assert.equal(result.run?.status, 'failed');
  assert.equal(result.run.runId, runId);
  assert.equal(result.run.sessionKey, sessionKey);
  assert.equal(result.run.source, 'openclaw/sessions.get');
  assert.equal(result.run.messageId, marker.__openclaw.id);
  assert.equal(result.run.model, null, 'do not invent the effective model from current configuration');
  assert.equal(result.answer.status, 'unavailable');
  assert.equal(JSON.stringify(result).includes('Private provider'), false);
  for (const change of [
    { sessionKey: 'foreign-session', messages: [marker] },
    { sessionKey, messages: [{ ...marker, role: 'user' }] },
    { sessionKey, messages: [{ ...marker, customType: 'other' }] },
    { sessionKey, messages: [{ ...marker, details: { runId: 'resp_33333333-3333-4333-8333-333333333333' } }] },
    { sessionKey, messages: [{ ...marker, __openclaw: undefined }] }
  ]) {
    history = change;
    assert.equal((await operate({ operation: 'turn', sessionKey, runId })).run, null);
  }
  history = { sessionKey, messages: [marker] };
  await updateState(workspace, () => ({ schemaVersion: 1, receipts: [], runs: [{ runId, sessionKey, status: 'failed', source: 'agent_end' }] }));
  assert.equal((await operate({ operation: 'turn', sessionKey, runId })).run.source, 'agent_end', 'retain the native hook when it exists');
});
