'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./fixtures/persona-journey.cjs');
const registry = require('../family-tool-registry');
const { bindFamilyServices, familyToolset } = require('../family-tools');
const ideas = require('../../../src/services/ideaInboxService');
const env = { HOUSEHOLD_FAMILY_TOOLS: 'family_inbox_capture', HOUSEHOLD_CONVERSATION_RELAY_ENABLED: 'true' };
const turnId = 'explicit-parent-inbox-fixture';
const signal = new AbortController().signal;

test('only an equipped turn with a repeatable identity may offer the parent inbox', () => {
  const base = { eligible: true, env, session: { scopeId: 'family', sessionId: 'fixture' },
    features: {}, userText: 'J’ai une idée pour papa.', turnId, signal, safety: {} };
  for (const patch of [{ eligible: false }, { env: {} }, { turnId: '' }, { session: { scopeId: 'personal' } },
    { features: { memoryContext: false } }, { features: { householdContext: false } }, { safety: { flagIds: ['private_information'] } }]) {
    const services = bindFamilyServices({ ...base, ...patch });
    assert.equal(familyToolset(env, { toolDeps: services }), null);
  }
  const tools = familyToolset(env, { toolDeps: bindFamilyServices(base) });
  assert.deepEqual(tools.names, ['family_inbox_capture']);
  assert.deepEqual(Object.keys(tools.definitions[0].function.parameters.properties), ['kind']);
});

test('an incorrect or interrupted model call, a negation, and withdrawals are denied before storage', async t => {
  const writes = t.mock.method(ideas, 'captureFamilyTurn', () => assert.fail('write'));
  const binding = { sessionId: 'fixture', turnId, userText: 'Keep this idea for Dad.', signal };
  const call = (args, familyInbox) => registry.callTool({ name: 'family_inbox_capture', arguments: args }, { familyInbox });
  for (const args of [{ kind: 'idea', text: 'different' }, { kind: 'reminder', sessionId: 'other' }, { kind: 'family_chore' }]) {
    assert.equal((await call(args, binding)).isError, true);
  }
  for (const userText of ['Ne note pas mon idée.', 'Rappelle-moi de lire, euh non laisse faire.',
    'Je voulais te laisser une idée, mais gâche pas la surprise, dis-le pas à papa.',
    "J’ai une idée, mais garde-la juste pour toi.", 'Save my idea, but never mind.',
    'Remind me to call Dad. Do not save it.']) {
    assert.equal((await call({ kind: 'idea' }, { ...binding, userText })).isError, true, userText);
  }
  assert.equal((await call({ kind: 'idea' }, { ...binding, signal: AbortSignal.abort() })).isError, true);
  assert.equal((await call({ kind: 'idea' }, null)).isError, true);
  assert.equal(writes.mock.callCount(), 0);
});

test('a local Family turn writes only if the model calls its granted tool, and keeps the canonical input', async t => {
  const legacy = t.mock.method(ideas, 'captureIdea', () => assert.fail('Legacy capture ran on an equipped turn'));
  const capture = t.mock.method(ideas, 'captureFamilyTurn', async () =>
    ({ ideaId: 'verified-fixture', status: 'inbox', review: 'parent', kind: 'reminder' }));
  let shouldSave = false;
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx', validClientTurnId: id => id.startsWith(turnId),
    conversationEnv: env, continuityExecute: async body => {
      assert.ok(body.tools.some(tool => tool.function.name === 'family_inbox_capture'));
      return shouldSave ? { ok: true, body: { message: { tool_calls: [
        { function: { name: 'family_inbox_capture', arguments: { kind: 'reminder' } } }
      ] } } } : { ok: true, body: { response: 'On peut en jaser.' } };
    },
    response: body => {
      const tool = body.messages.at(-1);
      assert.equal(tool.role, 'tool'); assert.equal(JSON.parse(tool.content).status, 'inbox');
      return 'Je l’ai gardé pour que papa le regarde.';
    } });
  h.conversations.acceptTurn = async () => ({ duplicate: false });
  h.conversations.settleTurn = h.conversations.recordTurn;
  const ask = async (text, id) => {
    const res = { on() {}, removeListener() {}, writableEnded: false, headersSent: false };
    await h.handle({ params: { sessionId: h.session.sessionId }, body: { text, channel: 'text', turnId: id } },
      res, 'child', { packId: h.session.packId, modeId: h.session.modeId, scopeId: 'family', browser: true });
    assert.equal(res.failure, undefined);
  };
  await ask('Rappelle-moi de prendre mon sac.', turnId + '-1');
  assert.equal(capture.mock.callCount(), 0);
  shouldSave = true;
  const spoken = 'Rappelle-moi d’annuler mon rendez-vous.';
  await ask(spoken, turnId + '-2');
  assert.equal(capture.mock.callCount(), 1);
  const { userText, sessionId, turnId: boundId, kind } = capture.mock.calls[0].arguments[0];
  assert.deepEqual({ userText, sessionId, boundId, kind }, { userText: spoken, sessionId: h.session.sessionId, boundId: turnId + '-2', kind: 'reminder' });
  assert.deepEqual(h.turns[0].toolEvidence.receipts.map(row => [row.tool, row.status]), [['family_inbox_capture', 'completed']]);
  assert.equal(legacy.mock.callCount(), 0);
  assert.equal(h.state.recordedNotes.length, 0);
});
