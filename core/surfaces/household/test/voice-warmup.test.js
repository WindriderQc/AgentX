'use strict';

// The opening warm-up: one small turn in the conversation's own native session
// while the greeting is spoken, with the instructions of an ordinary spoken
// turn, so the first real turn only appends to a cached prompt.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createVoiceWarmup, openingEvent, OPENING_DIRECTIVE } = require('../voice-warmup');
const { createPersonaTurnHandler } = require('../persona-turn');
const { createMemberWork } = require('../member-work');
const packs = require('../packs');
const prompt = require('../persona-prompt');
const records = require('../persona-records');

const sessionId = 'synthetic-session';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function harness({ backend = 'openclaw', sessionFields = {}, conversationImages, env = {} } = {}) {
  const pack = packs.packById('personal_operator');
  const session = { sessionId, status: 'active', packId: pack.id, modeId: pack.defaultMode, scopeId: pack.defaultScopeId,
    backend, agentId: 'main', turnCount: 0,
    persona: { id: 'nestor', version: 1, name: 'Nestor', identity: 'Synthetic personality overlay.', voice: {} }, voice: { language: 'auto' }, ...sessionFields };
  const turns = [], requests = [];
  const conversations = {
    getSession: async () => ({ ...session }),
    updateSession: async (_query, update) => { Object.assign(session, update.$set || {}); return { ...session }; },
    listTurns: async () => turns, getTurn: async () => null,
    recordTurn: async turn => { const row = { ...turn, _id: `turn-${turns.length}`, createdAt: new Date() }; turns.unshift(row); session.turnCount += 1; return row; }
  };
  const executeConversation = request => {
    const run = { request };
    run.done = new Promise((resolve, reject) => { run.answer = text => resolve({ text, sessionKey: 'agent:main:synthetic', runId: 'run-1',
      metadata: { model: 'synthetic-native' }, tools: { status: 'observed', receipts: [] } }); run.fail = reject; });
    request.signal?.addEventListener('abort', () => run.fail(request.signal.reason || new Error('cancelled')), { once: true });
    requests.push(run);
    return Promise.resolve(request.onStarted?.('agent:main:synthetic', 'run-1')).then(() => run.done);
  };
  const conversationEnv = { HOUSEHOLD_TEAM_MEMBERS: JSON.stringify({ secretary: ['secrétaire'] }), HOUSEHOLD_VOICE_WARMUP: 'true', ...env };
  const { conversationBackend } = require('../conversation-executor');
  const { agentIdFor } = require('../conversation-agent');
  const warnings = [];
  let handle;
  const warmup = createVoiceWarmup({ conversations, executeConversation, conversationBackend, conversationEnv, packById: packs.packById, agentIdFor,
    logger: { warn: (message, detail) => warnings.push({ message, ...detail }) }, deadlineMs: 200,
    instructions: (...args) => handle.openingInstructions(...args) });
  handle = createPersonaTurnHandler({
    logger: null, runtimeServices: { attachments: { ids: () => [] } }, conversations, executeConversation, conversationEnv, conversationImages,
    requireNativeAgent: async () => {},
    familyTasks: { listProfileDetails: async () => ({ profiles: [] }), listProfiles: async () => ({ profiles: [] }), room: async () => ({ room: { available: [] } }) },
    ownerMemory: {}, familyMemory: {},
    notesFor: () => ({ search: async () => ({ notes: [] }), record: async () => ({}) }),
    personalAttachments: () => ({ references: async () => [], prepare: async messages => messages }),
    knowledgeState: { config: null, status: { status: 'disabled', corpusFingerprint: null } },
    openHold: {}, openingPayload: () => ({}),
    sounds: { select: () => null, get: () => null }, visuals: { sources: () => ['web'], present: async block => block },
    brain: { cancel() {}, schedule() {}, contextFor: () => '' }, memberWork: createMemberWork({ conversations }), warmup,
    activePersonaTurns: new Map(), validClientTurnId: value => typeof value === 'string' && value.length > 3,
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
  const speak = text => {
    const res = { events: [], writableEnded: false, headersSent: false, on() {}, removeListener() {},
      status() { res.headersSent = true; return res; }, set() { return res; },
      write(line) { res.events.push(JSON.parse(line)); }, end() { res.writableEnded = true; } };
    res.finished = handle({ params: { sessionId }, body: { text, turnId: 'turn-1', channel: 'voice', stream: true, soundPlayback: true } }, res, 'private');
    return res;
  };
  return { session, turns, requests, warmup, warnings, speak };
}

test('the warm-up sends the instructions of the first spoken turn, in the same native session, and records nothing', async () => {
  const h = harness({ conversationImages: {
    contract: (_session, backend) => `Image creation through ${backend}: create once, then end this turn.`,
    contextFor: async () => 'Current Core image receipt: ready=true.', complete: async () => {}
  } });
  assert.deepEqual(h.warmup.start({ ...h.session }, '  Bonjour Yanik,\nje t’écoute. '), { started: true });
  while (!h.requests.length) await tick();
  const warm = h.requests[0].request;
  assert.equal(warm.text, openingEvent('Bonjour Yanik, je t’écoute.'));
  assert.equal(warm.turnDirective, OPENING_DIRECTIVE);
  assert.equal(warm.channel, 'voice');
  assert.match(warm.instructions, /Image creation through openclaw: create once/);
  assert.ok(!warm.instructions.includes('ready=true'), 'Current image readiness is not part of the cached prompt prefix');
  assert.equal(warm.session.agentId, 'main');
  assert.equal(h.session.agentSessionKey, 'agent:main:synthetic', 'the conversation keeps the warmed native session');

  // The first real turn waits for the warm-up, then sends the same instructions: only the request is new.
  const first = h.speak('Quel temps fait-il ?');
  await tick(); await tick();
  assert.equal(h.requests.length, 1, 'no second run in the same native session while the warm-up runs');
  h.requests[0].answer('Prêt');
  while (h.requests.length < 2) await tick();
  assert.equal(h.requests[1].request.instructions, warm.instructions);
  assert.equal(h.requests[1].request.channel, 'voice');
  h.requests[1].answer('Il fait beau.');
  await first.finished;
  assert.equal(first.events.at(-1).type, 'done');
  assert.deepEqual(h.turns.map(turn => turn.inputText), ['Quel temps fait-il ?'], 'the warm-up is not a turn of the conversation');
  assert.deepEqual(h.warnings, []);
});

test('the warm-up never runs once someone has spoken, twice at once, or outside the native agent', async () => {
  const spoken = harness({ sessionFields: { turnCount: 2 } });
  assert.deepEqual(spoken.warmup.start({ ...spoken.session }, 'Bonjour.'), { started: false, reason: 'already_started' });
  const resumed = harness({ sessionFields: { agentSessionKey: 'agent:main:earlier' } });
  assert.deepEqual(resumed.warmup.start({ ...resumed.session }, 'Bonjour.'), { started: false, reason: 'already_started' });
  const core = harness({ backend: 'agentx' });
  assert.deepEqual(core.warmup.start({ ...core.session }, 'Bonjour.'), { started: false, reason: 'not_native' });
  const h = harness();
  assert.deepEqual(h.warmup.start({ ...h.session }, ''), { started: false, reason: 'unavailable' });
  assert.equal(h.warmup.start({ ...h.session }, 'Bonjour.').started, true);
  assert.deepEqual(h.warmup.start({ ...h.session }, 'Bonjour.'), { started: false, reason: 'running' });
  while (!h.requests.length) await tick();
  h.requests[0].answer('Prêt');
  await h.warmup.settled(sessionId);
  assert.equal(h.requests.length, 1);
});

test('a warm-up that fails or hangs is only a warning and never blocks the first turn', async () => {
  const failing = harness();
  failing.warmup.start({ ...failing.session }, 'Bonjour.');
  while (!failing.requests.length) await tick();
  failing.requests[0].fail(new Error('gateway unavailable'));
  await failing.warmup.settled(sessionId);
  assert.match(failing.warnings[0].error, /gateway unavailable/);

  const hanging = harness();
  hanging.warmup.start({ ...hanging.session }, 'Bonjour.');
  const first = hanging.speak('Quel temps fait-il ?');
  while (hanging.requests.length < 2) await tick(); // the deadline ends the warm-up, then the turn runs
  assert.match(hanging.warnings[0].error, /timed out/);
  hanging.requests[1].answer('Il fait beau.');
  await first.finished;
  assert.equal(first.events.at(-1).type, 'done');
});

test('the warm route answers only for an active personal conversation', async () => {
  const h = harness();
  const routes = {};
  h.warmup.register({ post(path, handler) { routes[path] = handler; } });
  const call = (body, fields = {}) => new Promise(resolve => {
    Object.assign(h.session, fields);
    routes['/private/sessions/:sessionId/warm']({ params: { sessionId }, body },
      { status(code) { return { json: data => resolve({ code, data }) }; } });
  });
  assert.deepEqual(await call({ greeting: 'Bonjour.' }, { packId: 'kidx_nestor', scopeId: 'family' }), { code: 404,
    data: { ok: false, status: 'error', code: 'VOICE_PERSONA_SESSION_NOT_FOUND', message: 'Voice persona session not found' } });
  const started = await call({ greeting: 'Bonjour.' }, { packId: 'personal_operator', scopeId: 'personal' });
  assert.deepEqual(started, { code: 202, data: { ok: true, status: 'success', data: { started: true } } });
  assert.equal((await call({ greeting: 'Bonjour.' })).code, 200);
  h.requests[0]?.answer('Prêt');
});

test('the warm-up stays off unless the instance turns it on', async () => {
  for (const value of [undefined, '', 'false', '1']) {
    const h = harness({ env: { HOUSEHOLD_VOICE_WARMUP: value } });
    assert.deepEqual(h.warmup.start({ ...h.session }, 'Bonjour.'), { started: false, reason: 'disabled' });
    assert.equal(h.requests.length, 0);
    await h.warmup.settled(sessionId);
  }
});
