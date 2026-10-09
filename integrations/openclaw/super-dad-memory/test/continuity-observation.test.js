import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { continuityOperations, continuityHttpHandler } from '../continuity.js';
import { updateState } from '../store.js';

const sessionKey = 'agent:main:household:direct:11111111-1111-4111-8111-111111111111';
const runId = 'resp_22222222-2222-4222-8222-222222222222';

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
