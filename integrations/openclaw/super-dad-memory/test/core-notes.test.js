import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCoreNotesClient, configuredJobContext } from '../core-notes.js';
import { privateOwnerContext, readState } from '../store.js';
import { contextFor, recordRun, recordTool } from '../harness.js';
import { continuityOperations, nativeTurnAnswer } from '../continuity.js';

test('native personal_memory forwards only note inputs and validates the Core receipt without retry', async () => {
  let captured, calls = 0;
  const id = 'a'.repeat(24);
  const client = createCoreNotesClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (url, options) => {
    calls++; captured = { url: String(url), options };
    return { ok: true, json: async () => ({ status: 'success', data: {
      ok: true, authority: 'agentx.core', operation: 'remember', id, text: 'Synthetic note', created: true
    } }) };
  } });
  assert.equal((await client({ action: 'remember', text: ' Synthetic note ', scope: 'household', path: '/ignored' })).id, id);
  assert.equal(captured.url, 'http://127.0.0.1:3180/api/consumers/nestor/v1/memory/notes');
  assert.deepEqual(JSON.parse(captured.options.body), { action: 'remember', text: ' Synthetic note ' });
  assert.equal(captured.options.redirect, 'error');
  assert.equal(calls, 1);
  for (const data of [{ ok: true, authority: 'openclaw.nestor', operation: 'list', notes: [] },
    { ok: true, authority: 'agentx.core', operation: 'list' }]) {
    const broken = createCoreNotesClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async () => ({ ok: true,
      json: async () => ({ status: 'success', data }) }) });
    await assert.rejects(broken({ action: 'list' }), /receipt is invalid/);
  }
  assert.throws(() => createCoreNotesClient(), /Configure/);
});

test('only the existing owner contexts or explicitly configured native jobs receive owner tools', () => {
  const config = { channels: { telegram: { allowFrom: ['12345'] } } };
  assert.equal(privateOwnerContext({ agentId: 'main', sessionKey: 'agent:main:telegram:direct:12345' }, config), true);
  assert.equal(privateOwnerContext({ agentId: 'family', sessionKey: 'agent:main:telegram:direct:12345' }, config), false);
  assert.equal(privateOwnerContext({ agentId: 'main', sandboxed: true, sessionKey: 'agent:main:telegram:direct:12345' }, config), false);
  assert.equal(configuredJobContext({ agentId: 'main', sessionKey: 'agent:main:cron:synthetic:run' }), false);
  assert.equal(configuredJobContext({ agentId: 'main', sessionKey: 'agent:main:cron:synthetic:run' }, ['agent:main:cron:synthetic']), true);
});

test('the harness keeps native receipts and transient context, while Core owns every selected note', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-native-receipts-'));
  t.after(() => rm(workspace, { recursive: true }));
  const sessionKey = 'agent:main:household:direct:11111111-1111-4111-8111-111111111111';
  const runId = 'resp_22222222-2222-4222-8222-222222222222';
  await recordTool(workspace, { toolName: 'personal_memory', result: { details: { ok: true, id: 'a'.repeat(24) } } },
    { runId, sessionKey, toolCallId: 'synthetic-call' });
  await recordRun(workspace, { success: true, runId }, { sessionKey, modelId: 'synthetic' });
  const context = await contextFor(workspace, 'synthetic', { includeMemory: true, readNotes: async request => {
    assert.deepEqual(request, { action: 'context', query: 'synthetic', limit: 4 });
    return { notes: [{ id: 'a'.repeat(24), text: 'Synthetic Core note' }] };
  } });
  assert.equal(context.notes[0].sourceRef, 'agentx-note:' + 'a'.repeat(24));
  assert.deepEqual(await readdir(path.join(workspace, '.nestor')), ['context.json']);
  const history = { sessionKey, messages: [{ role: 'assistant', stopReason: 'stop',
    __openclaw: { runId, id: 'synthetic-message' }, content: [{ type: 'text', text: 'Synthetic final answer' }] }] };
  const operate = continuityOperations({ workspace, readHistory: async () => history });
  const evidence = await operate({ operation: 'turn', sessionKey, runId });
  assert.equal(evidence.answer.text, 'Synthetic final answer');
  assert.equal(evidence.run.status, 'completed');
  assert.equal(evidence.receipts[0].status, 'verified');
  assert.equal((await readState(workspace)).receipts.length, 1);
  await assert.rejects(operate({ operation: 'remember', text: 'No local note store' }), /notes belong to AgentX Core/);
  assert.equal(nativeTurnAnswer({ ...history, messages: [{ ...history.messages[0], phase: 'commentary' }] }, sessionKey, runId).status, 'unavailable');
});

test('a run that yielded to a sub-agent answers with the announce run that settles its session', () => {
  const sessionKey = 'agent:main:household:direct:11111111-1111-4111-8111-111111111111';
  const runId = 'resp_22222222-2222-4222-8222-222222222222';
  const settle = `announce:requester-settle:main:${sessionKey}:child:yield-1`;
  const assistant = (run, stopReason, content, id = run) => ({ role: 'assistant', stopReason, __openclaw: { runId: run, id }, content });
  const yielding = [
    assistant('resp_33333333-3333-4333-8333-333333333333', 'stop', [{ type: 'text', text: 'Earlier turn' }]),
    { role: 'user', content: 'Combien coûte le karaté ?' },
    assistant(runId, 'toolUse', [{ type: 'toolCall', name: 'sessions_spawn' }], 'spawn'),
    assistant(runId, 'toolUse', [{ type: 'toolCall', name: 'sessions_yield' }], 'yield')];
  assert.deepEqual(nativeTurnAnswer({ sessionKey, messages: yielding }, sessionKey, runId),
    { status: 'yielded', source: 'openclaw/sessions.get', runId });
  const settled = [...yielding, { role: 'user', content: 'Sub-agent result' },
    assistant(settle, 'stop', [{ type: 'text', text: 'Le comptable a répondu.' }], 'announce-message')];
  assert.deepEqual(nativeTurnAnswer({ sessionKey, messages: settled }, sessionKey, runId), { status: 'ready',
    source: 'openclaw/sessions.get', runId, deliveredBy: settle, messageId: 'announce-message', text: 'Le comptable a répondu.' });
  // An announce for another session, or one still using tools, is not this answer.
  const other = settle.replace('11111111-1111', '44444444-4444');
  assert.equal(nativeTurnAnswer({ sessionKey, messages: [...yielding,
    assistant(other, 'stop', [{ type: 'text', text: 'Other' }])] }, sessionKey, runId).status, 'yielded');
  assert.equal(nativeTurnAnswer({ sessionKey, messages: [...yielding,
    assistant(settle, 'toolUse', [{ type: 'toolCall', name: 'tool_call' }])] }, sessionKey, runId).status, 'yielded');
});

test('a run that started a background image answers with that task\'s completion run', () => {
  const sessionKey = 'agent:main:household:direct:11111111-1111-4111-8111-111111111111';
  const runId = 'resp_22222222-2222-4222-8222-222222222222';
  const done = 'image_generate:55555555-5555-4555-8555-555555555555:ok:agent-loop';
  const assistant = (run, stopReason, content, id = run) => ({ role: 'assistant', stopReason, __openclaw: { runId: run, id }, content });
  const started = [
    { role: 'user', content: 'Crée une image de la pomme de Newton' },
    assistant(runId, 'toolUse', [{ type: 'toolCall', name: 'tool_call',
      arguments: { id: 'openclaw:core:image_generate', args: { prompt: 'Apple' } } }], 'call'),
    { role: 'toolResult', content: [{ type: 'text', text: 'Background task started' }] }];
  assert.deepEqual(nativeTurnAnswer({ sessionKey, messages: started }, sessionKey, runId),
    { status: 'yielded', source: 'openclaw/sessions.get', runId });
  const completed = [...started, { role: 'user', content: 'Internal task completion event' },
    assistant(done, 'stop', [{ type: 'text', text: 'Voilà la pomme.\n\nMEDIA:/media/apple.jpg' }], 'image-message'),
    { role: 'assistant', stopReason: 'stop', content: [] }];
  assert.deepEqual(nativeTurnAnswer({ sessionKey, messages: completed }, sessionKey, runId), { status: 'ready',
    source: 'openclaw/sessions.get', runId, deliveredBy: done, messageId: 'image-message', text: 'Voilà la pomme.\n\nMEDIA:/media/apple.jpg' });
  // A completion that arrives after the next Household turn is not this answer.
  const nextTurn = assistant('resp_33333333-3333-4333-8333-333333333333', 'stop', [{ type: 'text', text: 'Autre' }]);
  assert.equal(nativeTurnAnswer({ sessionKey, messages: [...started, nextTurn, ...completed.slice(started.length)] },
    sessionKey, runId).status, 'yielded');
});

test('turn progress exposes tool names and a target agent only', async () => {
  const { nativeTurnProgress } = await import('../continuity.js');
  const sessionKey = 'agent:main:household:direct:11111111-1111-4111-8111-111111111111';
  const runId = 'resp_22222222-2222-4222-8222-222222222222';
  const history = { sessionKey, messages: [
    { role: 'assistant', __openclaw: { runId: 'resp_other', id: 'm0' }, content: [{ type: 'toolCall', id: 'old', name: 'vault_note' }] },
    { role: 'assistant', __openclaw: { runId, id: 'm1' }, content: [{ type: 'text', text: 'Private preamble' },
      { type: 'toolCall', id: 'c1', name: 'tool_call', arguments: { id: 'openclaw:core:sessions_spawn', args: { agentId: 'comptable', task: 'Private question' } } }] },
    { role: 'assistant', __openclaw: { runId, id: 'm2' }, content: [{ type: 'toolCall', name: 'sessions_yield', arguments: { message: 'Private' } },
      { type: 'toolCall', id: 'c3', name: 'personal_memory', arguments: { agentId: '../bad' } }] }] };
  assert.deepEqual(nativeTurnProgress(history, sessionKey, runId), [
    { id: 'c1', tool: 'sessions_spawn', agentId: 'comptable' }, { id: 'm2:0', tool: 'sessions_yield' }, { id: 'c3', tool: 'personal_memory' }]);
  assert.deepEqual(nativeTurnProgress({ ...history, sessionKey: 'other' }, sessionKey, runId), []);
});
