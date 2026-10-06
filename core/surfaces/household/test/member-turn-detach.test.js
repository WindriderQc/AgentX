'use strict';

// A team member's turn survives the person speaking again: the turn detaches,
// the conversation's agent takes the next turn and knows the member is still
// working, and the member's reply is recorded and kept for the page.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPersonaTurnHandler } = require('../persona-turn');
const { createMemberWork } = require('../member-work');
const packs = require('../packs');
const prompt = require('../persona-prompt');
const records = require('../persona-records');

const sessionId = 'synthetic-session';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function harness() {
  const pack = packs.packById('personal_operator');
  const session = { sessionId, status: 'active', packId: pack.id, modeId: pack.defaultMode, scopeId: pack.defaultScopeId,
    backend: 'openclaw', agentId: 'main', turnCount: 0,
    persona: { id: 'nestor', version: 1, name: 'Nestor', identity: 'Synthetic personality overlay.', voice: {} }, voice: { language: 'auto' } };
  const turns = [], requests = [];
  const conversations = {
    getSession: async () => ({ ...session }),
    updateSession: async (_query, update) => {
      Object.assign(session, update.$set || {});
      for (const key of Object.keys(update.$unset || {})) delete session[key];
      return { ...session };
    },
    listTurns: async () => turns, getTurn: async () => null,
    recordTurn: async turn => { const row = { ...turn, _id: `turn-${turns.length}`, createdAt: new Date() }; turns.unshift(row); session.turnCount += 1; return row; }
  };
  const memberWork = createMemberWork({ conversations });
  const activePersonaTurns = new Map();
  // Each agent run stays open until the test settles it.
  const executeConversation = request => {
    const run = { request, agentId: request.session.agentId };
    run.done = new Promise((resolve, reject) => { run.answer = text => resolve({ text, sessionKey: `agent:${run.agentId}:synthetic`, runId: 'run-1',
      metadata: { model: 'synthetic-native' }, tools: { status: 'observed', receipts: [] } }); run.fail = reject; });
    request.signal.addEventListener('abort', () => run.fail(new Error('cancelled')), { once: true });
    requests.push(run);
    return Promise.resolve(request.onStarted(`agent:${run.agentId}:synthetic`, 'run-1')).then(() => run.done);
  };
  const handle = createPersonaTurnHandler({
    logger: null, runtimeServices: { attachments: { ids: () => [] } }, conversations, executeConversation,
    conversationEnv: { HOUSEHOLD_TEAM_MEMBERS: JSON.stringify({ secretary: ['secrétaire'] }) },
    requireNativeAgent: async () => {},
    familyTasks: { listProfileDetails: async () => ({ profiles: [] }), listProfiles: async () => ({ profiles: [] }), room: async () => ({ room: { available: [] } }) },
    ownerMemory: {}, familyMemory: {},
    notesFor: () => ({ search: async () => ({ notes: [] }), record: async () => ({}) }),
    personalAttachments: () => ({ references: async () => [], prepare: async messages => messages }),
    knowledgeState: { config: null, status: { status: 'disabled', corpusFingerprint: null } },
    openHold: {}, openingPayload: () => ({}),
    sounds: { select: () => null, get: () => null }, visuals: { sources: () => ['web'], present: async block => block },
    brain: { cancel() {}, schedule() {}, contextFor: () => '' }, memberWork,
    activePersonaTurns, validClientTurnId: value => typeof value === 'string' && value.length > 3,
    envelope: (res, data) => { res.payload = data; }, fail: (res, status, message, code) => { res.failure = { status, message, code }; },
    cleanText: (value, max = 4000) => String(value || '').trim().slice(0, max),
    assessSafety: prompt.assessSafety, childBoundaryReply: prompt.childBoundaryReply, escalationReply: prompt.escalationReply,
    detectMemoryRequest: prompt.detectMemoryRequest,
    packById: packs.packById, packSummary: packs.packSummary, modeSummary: packs.modeSummary, publicSession: records.publicSession,
    systemPromptFor: prompt.systemPromptFor, spokenReplyLanguage: prompt.spokenReplyLanguage,
    sessionHistoryMessages: records.sessionHistoryMessages, loadSessionAuditRows: records.loadSessionAuditRows,
    MEMORY_RECALL_LIMIT: prompt.MEMORY_RECALL_LIMIT, PERSONAL_OPERATOR_SURFACE_CONTRACT: packs.PERSONAL_OPERATOR_SURFACE_CONTRACT,
    VOIX_FAMILY_PACK_ID: 'kidx_nestor'
  });
  // A streamed spoken turn; `finished` settles when the handler returns.
  const speak = (text, turnId) => {
    const listeners = {};
    const res = { events: [], writableEnded: false, headersSent: false,
      on(name, fn) { listeners[name] = fn; }, removeListener() {},
      status() { res.headersSent = true; return res; }, set() { return res; },
      write(line) { res.events.push(JSON.parse(line)); }, end() { res.writableEnded = true; } };
    res.finished = handle({ params: { sessionId }, body: { text, turnId, channel: 'voice', stream: true } }, res, 'private');
    res.close = () => listeners.close?.();
    return res;
  };
  return { session, turns, requests, memberWork, activePersonaTurns, speak };
}

test('speaking again detaches the member, the conversation agent answers, and the member reply is kept', async () => {
  const h = harness();
  const first = h.speak('Secrétaire, quels courriels attendent une réponse ?', 'turn-member');
  while (!h.requests.length) await tick();
  assert.equal(h.requests[0].agentId, 'secretary');
  assert.deepEqual(first.events.filter(event => event.type === 'status').map(event => event.activity), [{ kind: 'member_addressed', agentId: 'secretary' }]);

  // The person speaks again: the page asks to interrupt, the turn detaches.
  const entry = h.activePersonaTurns.get(sessionId);
  assert.equal(entry.detach(), true);
  assert.equal(entry.detach(), false, 'a turn detaches once');
  assert.equal(first.events.at(-1).type, 'detached');
  assert.equal(first.writableEnded, true);
  assert.equal(h.activePersonaTurns.has(sessionId), false, 'the conversation is free for the next turn');
  first.close(); // the page then drops the request: the member is not cancelled
  assert.equal(h.requests[0].request.signal.aborted, false);

  // The next turn goes to the conversation's agent, which is told the member still works.
  const second = h.speak('Sa minute est longue.', 'turn-nestor');
  while (h.requests.length < 2) await tick();
  assert.equal(h.requests[1].agentId, 'main');
  assert.match(h.requests[1].request.turnContext, / is still working in the background .*«Secrétaire, quels courriels attendent une réponse \?»/);
  h.requests[1].answer('Elle y travaille encore.');
  await second.finished;
  assert.equal(second.events.at(-1).type, 'done');
  assert.equal(h.activePersonaTurns.has(sessionId), false);

  // Asking the same member again while it works stays with the conversation's agent.
  const third = h.speak('Secrétaire, tu avances ?', 'turn-again');
  while (h.requests.length < 3) await tick();
  assert.equal(h.requests[2].agentId, 'main');
  h.requests[2].answer('Elle n’a pas fini.');
  await third.finished;

  // The member finishes: its turn is recorded, and its reply waits for the page.
  h.requests[0].answer('Trois courriels attendent une réponse.');
  await first.finished;
  const work = h.memberWork.publicJob(await h.memberWork.wait(sessionId, 'turn-member'));
  assert.equal(work.status, 'answered');
  assert.equal(work.reply.text, 'Trois courriels attendent une réponse.');
  assert.equal(work.reply.speaker.agentId, 'secretary');
  const recorded = h.turns.find(turn => turn.clientTurnId === 'turn-member');
  assert.equal(recorded.replyText, 'Trois courriels attendent une réponse.');
  assert.equal(recorded.interrupted, false);
  assert.equal(h.session.teamExchange.agentId, 'secretary');
  assert.equal(h.memberWork.contextFor(sessionId), '');
  assert.equal(h.activePersonaTurns.has(sessionId), false);
});

test('a stop cancels a member working in the background and reports it', async () => {
  const h = harness();
  const first = h.speak('Secrétaire, quels courriels attendent une réponse ?', 'turn-member');
  while (!h.requests.length) await tick();
  h.activePersonaTurns.get(sessionId).detach();
  assert.equal(h.memberWork.cancel(sessionId), 1);
  await first.finished;
  assert.equal(h.requests[0].request.signal.aborted, true);
  assert.equal(h.memberWork.publicJob(await h.memberWork.wait(sessionId, 'turn-member')).status, 'failed');
  assert.deepEqual(h.memberWork.active(sessionId), []);
});

test('a member turn nobody interrupts still answers on its own request', async () => {
  const h = harness();
  const first = h.speak('Secrétaire, quels courriels attendent une réponse ?', 'turn-member');
  while (!h.requests.length) await tick();
  h.requests[0].answer('Trois courriels attendent une réponse.');
  await first.finished;
  assert.equal(first.events.at(-1).type, 'done');
  assert.equal(first.events.at(-1).data.reply.text, 'Trois courriels attendent une réponse.');
  assert.equal(await h.memberWork.wait(sessionId, 'turn-member'), null);
});
