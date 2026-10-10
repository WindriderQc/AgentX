import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { continuityOperations, householdWorkspace } from '../continuity.js';
import { updateState } from '../store.js';

const runId = 'resp_22222222-2222-4222-8222-222222222222';
const sessionId = '11111111-1111-4111-8111-111111111111';

test('only isolated Main work sessions and the configured worker support dispatch discovery', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-native-work-'));
  t.after(() => rm(workspace, { recursive: true }));
  const sessionKey = `agent:main:household:work:${sessionId}`;
  const config = { agents: { entries: { main: { workspace }, 'nestor-worker': { workspace }, family: { workspace } } } };
  const run = { runId, sessionKey, status: 'completed' };
  await updateState(workspace, () => ({ schemaVersion: 1, runs: [run], receipts: [] }));
  const operate = continuityOperations({ workspace, config, workAgentId: 'nestor-worker', readHistory: async () => ({ sessionKey,
    messages: [{ role: 'assistant', __openclaw: { runId } },
      { role: 'assistant', __openclaw: { runId: 'announce:requester-settle:synthetic' } }] }) });
  assert.equal((await operate({ operation: 'agents' })).capabilities.isolatedWork, true);
  assert.equal(householdWorkspace({ agentId: 'main', sessionKey }, config), workspace);
  assert.equal(householdWorkspace({ agentId: 'family', sessionKey }, config), null);
  assert.deepEqual((await operate({ operation: 'work_attempt', sessionKey })).run, run);
  for (const denied of [`agent:main:household:direct:${sessionId}`, `agent:family:household:work:${sessionId}`]) {
    await assert.rejects(operate({ operation: 'work_attempt', sessionKey: denied }), /configured worker attempt/);
  }
  const worker = await operate({ operation: 'work_attempt', sessionKey: `agent:nestor-worker:household:direct:${sessionId}` });
  assert.equal(worker.runId, null); assert.equal(worker.status, 'unknown');
});

test('ambiguous isolated Main history remains unknown, while a known original run stays bound', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-native-work-ambiguous-'));
  t.after(() => rm(workspace, { recursive: true }));
  const sessionKey = `agent:main:household:work:${sessionId}`;
  const run = { runId, sessionKey, status: 'completed' };
  await updateState(workspace, () => ({ schemaVersion: 1, runs: [run], receipts: [] }));
  const operate = continuityOperations({ workspace, config: { agents: { entries: { main: { workspace } } } },
    readHistory: async () => ({ sessionKey, messages: [runId, 'resp_33333333-3333-4333-8333-333333333333']
      .map(runId => ({ role: 'assistant', __openclaw: { runId } })) }) });
  assert.equal((await operate({ operation: 'work_attempt', sessionKey })).runId, null);
  assert.deepEqual((await operate({ operation: 'work_attempt', sessionKey, runId })).run, run);
});
