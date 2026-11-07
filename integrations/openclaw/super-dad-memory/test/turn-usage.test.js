import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openclawTurnUsage } from '../../../../shared/openclawTurnUsage.cjs';
import { continuityOperations } from '../continuity.js';
import { updateState } from '../store.js';

const sessionKey = 'agent:main:household:direct:11111111-1111-4111-8111-111111111111';
const runId = 'resp_22222222-2222-4222-8222-222222222222';
const assistant = (id, stopReason, usage = { input: 10, output: 2, cacheRead: 5, cacheWrite: 1 }) => ({ role: 'assistant',
  __openclaw: { id, runId }, stopReason, usage, content: [{ type: 'text', text: 'Synthetic reply.' }] });
const history = () => ({ sessionKey, messages: [{ role: 'user' }, assistant('call-one', 'toolUse'), { role: 'toolResult' }, assistant('call-two', 'stop')] });

test('usage covers every assistant call of the exact native run, including cache counts', async t => {
  const expected = { input: 20, output: 4, cacheRead: 10, cacheWrite: 2, total: 36 };
  assert.deepEqual(openclawTurnUsage(history(), sessionKey, runId), expected);
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-turn-usage-'));
  t.after(() => rm(workspace, { recursive: true }));
  await updateState(workspace, () => ({ schemaVersion: 1, receipts: [], runs: [{ runId, sessionKey, status: 'completed' }] }));
  const result = await continuityOperations({ workspace, readHistory: async () => history() })({ operation: 'turn', sessionKey, runId });
  assert.deepEqual(result.run.usage, expected);
});

test('missing, clipped, nonterminal, repeated and incomplete usage stays unknown', () => {
  const full = history();
  for (const value of [null, { ...full, sessionKey: 'other' }, { ...full, truncated: true },
    { ...full, messages: full.messages.slice(1) }, { sessionKey, messages: [{ role: 'user' }, assistant('one', 'toolUse')] },
    { sessionKey, messages: [{ role: 'user' }, assistant('same', 'toolUse'), assistant('same', 'stop')] },
    { sessionKey, messages: [{ role: 'user' }, assistant('one', 'stop', { input: 3 })] }]) {
    assert.equal(openclawTurnUsage(value, sessionKey, runId), null);
  }
});
