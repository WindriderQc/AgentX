import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerLocalImages, imageActionKey } from '../local-images.js';
import { recordTool, recordRun } from '../harness.js';
import { continuityOperations } from '../continuity.js';

test('an accepted create retains its exact Core action identity through a failed or fallback native run', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-image-receipt-'));
  t.after(() => rm(workspace, { recursive: true }));
  const context = { agentId: 'main', sessionId: 'native-session', toolCallId: 'call-image',
    sessionKey: 'agent:main:household:direct:11111111-1111-4111-8111-111111111111',
    runId: 'resp_22222222-2222-4222-8222-222222222222' };
  const id = '33333333-3333-4333-8333-333333333333';
  let factory, calls = 0;
  registerLocalImages({ config: {}, pluginConfig: { agentxUrl: 'http://core.test' }, registerTool(value) { factory = value; } },
    { fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).actionKey, imageActionKey(context, context.toolCallId));
      return { ok: true, json: async () => ({ ok: true, operation: { id, state: 'accepted', studioPath: `/images?operation=${id}` } }) };
    } });
  const result = await factory(context).execute(context.toolCallId, { action: 'create', prompt: 'Synthetic landscape' });
  await recordTool(workspace, { toolName: 'local_image', params: { action: 'create' }, result }, context);
  await recordRun(workspace, { success: false }, { ...context, modelId: 'light-fallback', modelProviderId: 'ollama' });
  const operate = continuityOperations({ workspace });
  const evidence = await operate({ operation: 'turn', sessionKey: context.sessionKey, runId: context.runId });
  assert.equal(calls, 1);
  assert.equal(evidence.run.status, 'failed');
  assert.deepEqual(evidence.receipts[0].imageOperation, { id, actionKey: imageActionKey(context, context.toolCallId) });
  assert.equal(evidence.receipts[0].provenance.origin, 'owner_turn');
  assert.equal(evidence.receipts[0].status, 'unknown', 'Accepted is separate from verified image completion');
  assert.equal(evidence.receipts[0].observed, true);
  assert.equal(JSON.stringify(evidence).includes('Synthetic landscape'), false, 'Keep image prompts out of transient receipts');
  assert.equal(evidence.answer.status, 'unavailable');
  await recordTool(workspace, { toolName: 'local_image', params: { action: 'cancel' }, result },
    { ...context, toolCallId: 'call-cancel' });
  const after = await operate({ operation: 'turn', sessionKey: context.sessionKey, runId: context.runId });
  assert.equal(after.receipts.at(-1).imageOperation, undefined, 'Status/cancel must not masquerade as accepted creates');
});
