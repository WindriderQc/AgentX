'use strict';

// Real HTTP, canonical transcript/intake and production relay/transport logic.
// Native inference and Hermes are synthetic boundary fixtures; no model runs.
const express = require('express'), request = require('supertest');
const { randomUUID } = require('node:crypto');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createConversationExecutor } = require('../../surfaces/household/conversation-executor');
const { createPersonaTurnHandler } = require('../../surfaces/household/persona-turn');
const { createMemberWork } = require('../../surfaces/household/member-work');
const { createConversationContinuity } = require('../../src/services/routing/conversationContinuity');
const { inferenceConflict } = require('../../src/services/runtimeInferenceConflict');
const { relayContext } = require('../../src/services/conversations/relayContext');
const packs = require('../../surfaces/household/packs'), prompt = require('../../surfaces/household/persona-prompt');
const records = require('../../surfaces/household/persona-records');
const conversations = forSurface('household');
const PRIMARY = 'http://127.0.0.1:11434', GUARDIAN = 'http://127.0.0.2:11434';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(fn) { for (let i = 0; i < 400; i++) { if (await fn()) return; await tick(); } throw Error('Fixture did not reach its expected boundary'); }
let world, originalFetch;
async function fixture(backend = 'hermes', enabled = true, { richFamilyPresentation = false } = {}) {
  const pack = packs.packById(backend === 'hermes' ? 'personal_operator' : 'kidx_nestor');
  const session = await conversations.createSession({ sessionId: randomUUID(), packId: pack.id, scopeId: pack.defaultScopeId,
    modeId: pack.defaultMode, backend, status: 'active', agentId: pack.childSafe ? 'family' : 'main', turnCount: 0,
    persona: { id: 'nestor', version: 1, name: 'Nestor', identity: 'Synthetic personality.', voice: {} }, voice: { language: 'fr' } });
  const env = { HOUSEHOLD_HERMES_URL: 'http://hermes.fixture', HOUSEHOLD_HERMES_TOKEN: 'synthetic-private-relay-token',
    ...(richFamilyPresentation && { HOUSEHOLD_FAMILY_TOOLS: 'iss_passes,web_search,network_devices' }),
    ...(enabled && { HOUSEHOLD_CONVERSATION_RELAY_ENABLED: 'true' }) };
  const state = { busy: true, failure: null, backup: true, held: true, runs: [], inference: [], releases: [], completed: new Set(), active: new Map() };
  global.fetch = jest.fn(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/v1/runs') {
      const body = JSON.parse(options.body), run = { id: 'run_' + randomUUID(), key: options.headers['Idempotency-Key'], body, done: false };
      state.runs.push(run); state.active.set(run.id, run);
      return Response.json({ run_id: run.id });
    }
    const id = path.split('/')[3], run = state.active.get(id);
    if (!run) throw Error('Unknown native identity');
    if (path.endsWith('/stop')) { run.cancelled = true; state.releases.forEach(resolve => resolve()); return Response.json({}); }
    if (path.endsWith('/events')) return { ok: true, body: (async function* () {
      yield Buffer.from('data: ' + JSON.stringify({ event: 'tool.started', run_id: id, tool: 'synthetic_native_work' }) + '\n\n');
      if (state.held && state.runs.length === 1) await new Promise(resolve => {
        state.releases.push(resolve); options.signal?.addEventListener('abort', resolve, { once: true });
      });
      options.signal?.throwIfAborted();
      run.done = true;
      yield Buffer.from('data: ' + JSON.stringify({ event: run.cancelled ? 'run.cancelled' : 'run.completed', run_id: id }) + '\n\n');
    })() };
    if (state.holdStatus) await new Promise(resolve => { state.releaseStatus = resolve; });
    if (state.nativeUnavailable) return { ok: false, status: 503 };
    return Response.json({ run_id: state.foreignRun ? 'run_foreign' : id, status: run.cancelled ? 'cancelled' : run.done ? 'completed' : 'running',
      completed: run.done, partial: state.partial === true, output: state.nativeOutput || 'Résultat natif original vérifié.', runtime: { provider: 'synthetic', model: 'synthetic-main' } });
  });
  const local = jest.fn(async input => {
    state.inference.push(input);
    if (input.model === 'synthetic-main' && state.busy) {
      const now = new Date();
      const failure = state.failure || inferenceConflict({ inferences: [{ state: 'ACTIVE', host: PRIMARY,
        mode: 'shared', model: 'synthetic-main', acquiredAt: now, expiresAt: new Date(+now + 60000) }] },
      { host: PRIMARY, mode: input.exclusiveHost ? 'exclusive' : 'shared', resourceIds: [] }, now);
      throw Object.assign(Error('Refused before dispatch'), { code: 'RUNTIME_INFERENCE_ADMISSION_DENIED', failure });
    }
    if (state.backupStream && input.model === 'synthetic-guardian') return { ok: true,
      stream: (async function* () {
        yield Buffer.from(JSON.stringify({ message: { content: 'Je peux continuer la discussion.' }, done: true }) + '\n');
      })(), completion: state.streamCompletion || Promise.resolve({ completed: true, terminalComplete: true }),
      metadata: { model: input.model } };
    return { ok: true, body: { message: { content: input.model === 'synthetic-main' ? 'Réponse du principal.' : 'Je peux continuer la discussion.' } },
      metadata: { model: input.model } };
  });
  const continuity = createConversationContinuity({ execute: local, readPolicy: () => JSON.stringify({ hosts: ['guardian'] }),
    readSnapshot: async () => ({ hosts: { primary: PRIMARY, guardian: GUARDIAN }, tasks: Object.fromEntries(
      ['daily_operator', 'voice_persona_chat', 'nestor_answer_light'].filter(name => !state.familyOnly || name !== 'daily_operator').map(name => [name,
        { model: 'synthetic-main', hostUrl: PRIMARY, pinAligned: true, contextSize: 32768 }])) }),
    deps: { hostPreferenceService: { getByHost: async () => ({ pinnedModels: state.backup ? [{ model: 'synthetic-guardian', contextSize: 8192 }] : [] }) },
      assertHostAvailableForConsumer: async () => {}, modelsMatch: (a, b) => a === b,
      fetch: async () => ({ ok: true, json: async () => ({ models: [{ name: 'synthetic-guardian', context_length: 8192 }] }) }) },
    readWork: async () => { throw Error('A queue label must not establish occupation'); }, log: { warn() {} } });
  const execute = createConversationExecutor({ conversations, env, inference: { execute: local, conversation: continuity },
    recordRuntimeUsage: async () => {}, agentClient: () => { throw Error('No native OpenClaw or owner bus in these paths'); } });
  const activePersonaTurns = new Map(), memberWork = createMemberWork({ conversations });
  const envelope = (res, data, code = 200) => res.status(code).json({ data });
  const fail = (res, code, message, error) => res.status(code).json({ message, code: error });
  const handler = createPersonaTurnHandler({ logger: null, runtimeServices: { attachments: { ids: () => [] } }, conversations,
    conversationEnv: env, executeConversation: execute, requireNativeAgent: async () => { throw Error('No OpenClaw runtime'); },
    familyTasks: { listProfileDetails: async () => ({ profiles: [] }), listProfiles: async () => ({ profiles: [] }), room: async () => ({ room: { available: [] } }) },
    ownerMemory: {}, familyMemory: {}, notesFor: () => ({ search: async () => ({ notes: [] }) }),
    personalAttachments: () => ({ prepare: async messages => messages }), knowledgeState: { config: null, status: { status: 'disabled' } },
    openHold: {}, openingPayload: () => ({}), sounds: { select: () => null, get: () => null }, visuals: { sources: () => richFamilyPresentation ? ['web', 'photos'] : [] },
    brain: { cancel() {}, schedule() { state.reviews = (state.reviews || 0) + 1; }, contextFor: () => '' }, memberWork, activePersonaTurns,
    ...(richFamilyPresentation && { ambient: { weather: async () => ({ condition: 'Nuageux', temperatureC: 4.5, fetchedAt: new Date().toISOString() }) }, screenPages: require('../../surfaces/household/screen-services').createScreenServices({ env }),
      conversationImages: require('../../surfaces/household/conversation-images').createConversationImages({ conversations,
        service: { status: () => ({ configured: true, conversationProfile: 'synthetic' }) } }) }),
    validClientTurnId: id => /^[a-zA-Z0-9-]{16,80}$/.test(id), envelope, fail, cleanText: value => String(value || '').trim(),
    assessSafety: prompt.assessSafety, childBoundaryReply: prompt.childBoundaryReply, escalationReply: prompt.escalationReply,
    detectMemoryRequest: prompt.detectMemoryRequest, packById: packs.packById, packSummary: packs.packSummary, modeSummary: packs.modeSummary,
    publicSession: records.publicSession, systemPromptFor: prompt.systemPromptFor, spokenReplyLanguage: prompt.spokenReplyLanguage,
    sessionHistoryMessages: records.sessionHistoryMessages, loadSessionAuditRows: records.loadSessionAuditRows,
    MEMORY_RECALL_LIMIT: prompt.MEMORY_RECALL_LIMIT, PERSONAL_OPERATOR_SURFACE_CONTRACT: packs.PERSONAL_OPERATOR_SURFACE_CONTRACT, VOIX_FAMILY_PACK_ID: 'kidx_nestor' });
  const app = express(); app.use(express.json());
  app.post('/sessions/:sessionId/turns/text', (req, res) => handler(req, res, pack.childSafe ? 'child' : 'private',
    pack.childSafe ? { browser: true, packId: pack.id, modeId: pack.defaultMode, scopeId: pack.defaultScopeId } : null));
  require('../../surfaces/household/browser-session-controls').createBrowserSessionControls({ personas: app, conversations,
    activePersonaTurns, envelope, fail, cleanText: value => String(value || ''), validClientTurnId: () => true, memberWork,
    reconcileConversation: execute.reconcile })('', pack.id, pack.defaultScopeId);
  const send = (text, id = randomUUID(), channel = 'voice', stream = true) => request(app).post(`/sessions/${session.sessionId}/turns/text`).send({ text, turnId: id, channel, stream });
  return { ...state, state, session, app, send, execute, env, activePersonaTurns, memberWork, release: () => { state.held = false; state.releases.forEach(resolve => resolve()); } };
}
const events = response => response.text.trim().split('\n').map(line => JSON.parse(line));
const done = response => events(response).find(event => event.type === 'done')?.data;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(async () => { world?.release(); await until(() => !world || world.activePersonaTurns.size === 0
  && world.memberWork.active(world.session.sessionId).length === 0); global.fetch = originalFetch; });

test.each(['voice', 'text'])('Family %s relays on a real admission conflict, retains child safety and returns to its unchanged primary route', async channel => {
  world = await fixture('agentx');
  const id = randomUUID(), reply = await world.send('Explique les nuages.', id, channel).expect(200);
  expect(done(reply).reply.text).toContain('assure temporairement le relais');
  expect(world.state.inference.map(input => input.model)).toEqual(['synthetic-main', 'synthetic-guardian']);
  expect(world.state.inference[0].exclusiveHost).toBe(true);
  const backup = world.state.inference[1];
  expect(backup.tools).toBeUndefined(); expect(JSON.stringify(backup)).not.toContain('/api/consumers/nestor');
  expect(backup.messages[0].content).toContain('adaptée aux enfants');
  expect(backup.messages.at(-1).content).toBe('Explique les nuages.');
  expect(done(reply).tools.conversationRelay).toMatchObject({ role: 'relay', completed: true, model: 'synthetic-guardian' });
  const count = world.state.inference.length;
  await world.send('Explique les nuages.', id, channel).expect(202);
  expect(world.state.inference).toHaveLength(count);
  world.state.busy = false;
  const returned = await world.send('Continuons.', randomUUID(), channel).expect(200);
  expect(done(returned).reply.text).toBe('Réponse du principal.');
  const resumed = world.state.inference.at(-1);
  expect(JSON.stringify(resumed.messages)).toContain('Core temporary relay dialogue');
  expect(JSON.stringify(resumed.messages)).toContain('Explique les nuages.');
  expect(resumed.messages[0].content).toContain('explicitly identify any necessary correction');
  expect(world.state.runs).toHaveLength(0);
});

test.each(['inference_recovery_required', 'workload_recovery_required', 'admission_conflict_unclassified'])('Family never infers occupation from %s or repeats the request on another model', async cause => {
  world = await fixture('agentx'); world.state.failure = { cause, safeToRetry: true, holder: null };
  const response = await world.send('Explique les nuages.').expect(200);
  expect(done(response).model.model).toBe('agentx-status');
  expect(world.state.inference).toHaveLength(1);
  expect(done(response).tools.conversationRelay).toBeUndefined();
});

test('no resident guardian gives an honest status; normal primary and child deterministic safety stay independent', async () => {
  world = await fixture('agentx'); world.state.backup = false;
  const response = await world.send('Explique les nuages.').expect(200);
  expect(done(response).model.model).toBe('agentx-status');
  expect(world.state.inference).toHaveLength(1);
  world.state.busy = false;
  await world.send('Peux-tu expliquer la pluie ?').expect(200);
  expect(world.state.inference.at(-1).model).toBe('synthetic-main');
});

test('Hermes detaches its actual running native work, relays tool-free, preserves the original result and catches up on return/reconnect', async () => {
  world = await fixture(); const firstId = randomUUID();
  const first = world.send('Compare les deux options.', firstId).then(value => value);
  await until(() => world.state.releases.length > 0);
  const running = (await conversations.getSession({ sessionId: world.session.sessionId })).hermesRuntime;
  const interrupted = await request(world.app).post(`/sessions/${world.session.sessionId}/interrupt`).send({ turnId: firstId }).expect(200);
  expect(interrupted.body.data.detached).toBe(true); await first;
  expect(world.state.runs[0].cancelled).toBeUndefined();
  const relayId = randomUUID(), relay = await world.send('Peux-tu expliquer simplement les nuages ?', relayId).expect(200);
  expect(done(relay).reply.text).toContain('assure temporairement le relais');
  expect(world.state.runs).toHaveLength(1);
  expect(world.state.inference.every(input => input.model === 'synthetic-guardian')).toBe(true);
  expect(done(relay).tools.conversationRelay.relayFor).toMatchObject({ authority: 'hermes', runId: running.runId, turnId: firstId });
  expect(done(relay).continuity).toMatchObject({ status: 'limited', source: 'core.conversation-continuity' });
  expect(done(relay).knowledge).toMatchObject({ enabled: false, used: false });
  const state = (await conversations.getSession({ sessionId: world.session.sessionId })).hermesRuntime;
  expect(state.runId).toBe(running.runId); expect(state.key).toBe(running.key);
  world.release();
  await until(async () => (await conversations.getTurn({ sessionId: world.session.sessionId, traceId: firstId }))?.outcome === 'completed');
  const original = await conversations.getTurn({ sessionId: world.session.sessionId, traceId: firstId });
  expect(original.replyText).toBe('Résultat natif original vérifié.');
  expect(original.toolEvidence.runId).toBe(running.runId);
  expect(world.memberWork.publicJob(await world.memberWork.wait(world.session.sessionId, firstId)).reply.text).toBe(original.replyText);
  const returned = await world.send('Continue avec ces précisions.').expect(200);
  expect(done(returned).reply.text).toBe('Résultat natif original vérifié.');
  const posted = world.state.runs[1].body;
  expect(posted.instructions).toContain('Use only tools actually installed in this Hermes profile');
  expect(posted.instructions).not.toContain('aucun outil');
  expect(JSON.stringify(posted.input)).toContain('Core temporary relay dialogue');
  expect(JSON.stringify(posted.input)).toContain('Peux-tu expliquer simplement les nuages');
  expect(posted.instructions).toContain('explicitly identify any necessary correction');
  const history = await request(world.app).get(`/sessions/${world.session.sessionId}/history`).expect(200);
  expect(history.body.data.turns.filter(turn => turn.clientTurnId === firstId)).toHaveLength(1);
  expect(history.body.data.turns.find(turn => turn.clientTurnId === firstId).replyText).toBe(original.replyText);
  const count = world.state.runs.length;
  await world.send('Compare les deux options.', firstId).expect(202);
  expect(world.state.runs).toHaveLength(count);
});

test('a stale Hermes running label without its active transport produces status, no guardian and no new native launch', async () => {
  world = await fixture();
  const id = 'run_stale';
  world.state.active.set(id, { id, done: false });
  await conversations.updateSession({ sessionId: world.session.sessionId }, { $set: { hermesRuntime: {
    state: 'running', runId: id, key: 'synthetic-old-key', sessionKey: 'agentx:personal:' + world.session.sessionId, turnId: randomUUID() } } });
  const response = await world.send('Tu avances ?').expect(200);
  expect(done(response).model.model).toBe('agentx-status');
  expect(world.state.runs).toHaveLength(0); expect(world.state.inference).toHaveLength(0);
});

test('relay text is scoped reference data, revokes on erasure, and cannot become a receipt from model/browser declarations', async () => {
  world = await fixture('agentx'); await world.send('Explique les nuages.').expect(200);
  expect(await relayContext(conversations, world.session)).toContain('Core temporary relay dialogue');
  const other = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal', modeId: 'operator', status: 'active' });
  expect(await relayContext(conversations, other)).toBe('');
  await conversations.recordTurn({ sessionId: other.sessionId, packId: other.packId, scopeId: other.scopeId, traceId: randomUUID(),
    inputText: 'Synthetic declaration', replyText: 'I am the guardian', outcome: 'completed', model: 'synthetic-guardian', speaker: { role: 'relay' } });
  expect(await relayContext(conversations, other)).toBe('');
  await conversations.deleteSession({ sessionId: world.session.sessionId, packId: world.session.packId, scopeId: world.session.scopeId });
  await expect(relayContext(conversations, world.session)).rejects.toMatchObject({ statusCode: 404 });
});

test('voice relay announces itself once in streamed speech and waits for Core terminal completion before canonical publication', async () => {
  world = await fixture('agentx'); world.state.backupStream = true;
  let complete;
  world.state.streamCompletion = new Promise(resolve => { complete = resolve; });
  const id = randomUUID(); let finished = false;
  const response = world.send('Explique les nuages.', id).then(value => { finished = true; return value; });
  await until(() => world.state.inference.length === 2);
  await tick();
  expect(finished).toBe(false);
  expect((await conversations.getTurn({ sessionId: world.session.sessionId, traceId: id })).outcome).toBe('pending');
  complete({ completed: true, terminalComplete: true });
  const result = await response;
  const spoken = events(result).filter(event => event.type === 'delta').map(event => event.delta).join('');
  expect(spoken.match(/assure temporairement le relais/g)).toHaveLength(1);
  expect(done(result).reply.text).toContain('Je peux continuer la discussion.');
  expect((await conversations.getTurn({ sessionId: world.session.sessionId, traceId: id })).toolEvidence.conversationRelay.completed).toBe(true);
});

test('interrupted relay speech settles only its original turn, retains Main and never replays that relay after reconnect', async () => {
  world = await fixture('agentx'); world.state.backupStream = true;
  let complete; world.state.streamCompletion = new Promise(resolve => { complete = resolve; });
  const id = randomUUID(), response = world.send('Explique les nuages.', id).then(value => value);
  await until(() => world.state.inference.length === 2);
  const stopped = request(world.app).post(`/sessions/${world.session.sessionId}/interrupt`).send({ turnId: id, stop: true }).then(value => value);
  await until(() => world.activePersonaTurns.get(world.session.sessionId)?.abort.signal.aborted);
  complete({ completed: true, terminalComplete: true });
  await response; expect((await stopped).status).toBe(200);
  const row = await conversations.getTurn({ sessionId: world.session.sessionId, traceId: id });
  expect(row.outcome).toBe('cancelled'); expect(row.toolEvidence?.conversationRelay).toMatchObject({ completed: false, fragment: { playback: 'unverified' } });
  const count = world.state.inference.length;
  await world.send('Explique les nuages.', id).expect(202);
  expect(world.state.inference).toHaveLength(count);
  world.state.busy = false;
  await world.send('Continuons.').expect(200);
  expect(world.state.inference.at(-1).model).toBe('synthetic-main');
});

test('uncertain streamed completion retains fragments without a complete receipt or inference retry', async () => {
  world = await fixture('agentx'); world.state.backupStream = true;
  world.state.streamCompletion = Promise.reject(Object.assign(Error('Unconfirmed native release'), { code: 'RUNTIME_INFERENCE_COMPLETION_FAILED' }));
  void world.state.streamCompletion.catch(() => {});
  const id = randomUUID(), response = await world.send('Explique les nuages.', id);
  expect(events(response).some(event => event.type === 'error')).toBe(true);
  await until(() => world.activePersonaTurns.size === 0);
  const row = await conversations.getTurn({ sessionId: world.session.sessionId, traceId: id });
  expect(row.outcome).toBe('failed'); expect(row.toolEvidence?.conversationRelay).toMatchObject({ completed: false, fragment: { playback: 'unverified' } });
  await world.send('Explique les nuages.', id).expect(202);
  expect(world.state.inference).toHaveLength(2);
});

test('the opt-in flag leaves reviewer scheduling and the existing ordinary transport independent', async () => {
  world = await fixture('agentx', false); world.state.busy = false;
  const result = await world.send('Explique les nuages.').expect(200);
  expect(done(result).tools.conversationRelay).toBeUndefined();
  expect(world.state.reviews).toBe(1);
  expect(world.state.inference).toHaveLength(1);
  expect(world.state.inference[0].model).toBeUndefined();
});

test('the relay preserves reviewer scheduling and respects disabled Core history on the main return', async () => {
  world = await fixture('agentx'); await world.send('Explique les nuages.').expect(200);
  expect(world.state.reviews).toBe(1);
  world.state.busy = false;
  await world.execute({ backend: 'agentx', session: world.session, pack: packs.packById('kidx_nestor'), text: 'Continuons.',
    channel: 'voice', turnId: randomUUID(), history: [], agentxInstructions: 'Synthetic family guard.',
    conversationFeatures: { historyContext: false }, streaming: false });
  expect(JSON.stringify(world.state.inference.at(-1).messages)).not.toContain('Core temporary relay dialogue');
});

test.each(['nativeUnavailable', 'foreignRun'])('Hermes %s observation cannot establish occupation despite a live transport', async condition => {
  world = await fixture(); const id = randomUUID();
  const first = world.send('Compare les deux options.', id).then(value => value);
  await until(() => world.state.releases.length > 0);
  await request(world.app).post(`/sessions/${world.session.sessionId}/interrupt`).send({ turnId: id }).expect(200); await first;
  world.state[condition] = true;
  const response = await world.send('Tu avances ?').expect(200);
  expect(done(response).model.model).toBe('agentx-status');
  expect(world.state.runs).toHaveLength(1); expect(world.state.inference).toHaveLength(0);
  world.state[condition] = false; world.release();
});

test('explicit Stop reaches the same detached Hermes run and never substitutes another native action', async () => {
  world = await fixture(); const id = randomUUID();
  const first = world.send('Compare les deux options.', id).then(value => value);
  await until(() => world.state.releases.length > 0);
  await request(world.app).post(`/sessions/${world.session.sessionId}/interrupt`).send({ turnId: id }).expect(200); await first;
  const run = world.state.runs[0];
  await request(world.app).post(`/sessions/${world.session.sessionId}/interrupt`).send({ turnId: id, stop: true }).expect(200);
  await until(() => run.cancelled === true);
  await until(async () => (await conversations.getSession({ sessionId: world.session.sessionId })).hermesRuntime.state === 'cancelled');
  expect(world.state.runs).toHaveLength(1); expect(world.state.inference).toHaveLength(0);
});

test('Family deterministic danger protection still precedes primary and guardian inference', async () => {
  world = await fixture('agentx');
  const response = await world.send('Y a-t-il une urgence ?').expect(200);
  expect(done(response).safety.deterministicEscalation).toBe(true);
  expect(world.state.inference).toHaveLength(0);
  expect(world.state.runs).toHaveLength(0);
});

test('history reconnect recovers the original completed Hermes receipt after restart without launching or replaying anything', async () => {
  world = await fixture(); const id = randomUUID(), nativeId = 'run_retained';
  await conversations.acceptTurn({ sessionId: world.session.sessionId, packId: world.session.packId, scopeId: world.session.scopeId,
    modeId: world.session.modeId, traceId: id, clientTurnId: id, inputText: 'Demande originale.', channel: 'voice' });
  world.state.active.set(nativeId, { id: nativeId, done: true });
  await conversations.updateSession({ sessionId: world.session.sessionId }, { $set: { hermesRuntime: {
    state: 'running', runId: nativeId, key: 'original-stable-key', sessionKey: 'agentx:personal:' + world.session.sessionId,
    turnId: id, requestText: 'Demande originale.', channel: 'voice' } } });
  const history = await request(world.app).get(`/sessions/${world.session.sessionId}/history`).expect(200);
  expect(history.body.data.policy.nativeRecovery).toEqual({ state: 'completed' });
  expect(history.body.data.turns).toHaveLength(1);
  expect(history.body.data.turns[0]).toMatchObject({ traceId: id, inputText: 'Demande originale.', replyText: 'Résultat natif original vérifié.', outcome: 'completed',
    toolEvidence: { runId: nativeId } });
  await request(world.app).get(`/sessions/${world.session.sessionId}/history`).expect(200);
  expect((await conversations.readTurns({ sessionId: world.session.sessionId, packId: world.session.packId, scopeId: world.session.scopeId }))).toHaveLength(1);
  expect(world.state.runs).toHaveLength(0); expect(world.state.inference).toHaveLength(0);
  expect((await conversations.getSession({ sessionId: world.session.sessionId })).hermesRuntime.key).toBe('original-stable-key');
});

test('a stale history reconciliation cannot overwrite a newer Hermes journal or fabricate a result', async () => {
  world = await fixture(); const id = randomUUID(), nativeId = 'run_old_completed';
  await conversations.acceptTurn({ sessionId: world.session.sessionId, packId: world.session.packId, scopeId: world.session.scopeId,
    modeId: world.session.modeId, traceId: id, clientTurnId: id, inputText: 'Demande originale.', channel: 'voice' });
  world.state.active.set(nativeId, { id: nativeId, done: true });
  await conversations.updateSession({ sessionId: world.session.sessionId }, { $set: { hermesRuntime: {
    state: 'running', runId: nativeId, key: 'old-key', sessionKey: 'agentx:personal:' + world.session.sessionId,
    turnId: id, requestText: 'Demande originale.' } } });
  world.state.holdStatus = true;
  const pending = request(world.app).get(`/sessions/${world.session.sessionId}/history`).then(value => value);
  await until(() => world.state.releaseStatus);
  await conversations.updateSession({ sessionId: world.session.sessionId }, { $set: { hermesRuntime: {
    state: 'running', runId: 'run_newer', key: 'new-key', sessionKey: 'agentx:personal:' + world.session.sessionId } } });
  world.state.holdStatus = false; world.state.releaseStatus();
  const history = await pending;
  expect(history.status).toBe(200);
  expect(history.body.data.policy.nativeRecovery).toEqual({ state: 'unknown' });
  expect((await conversations.getSession({ sessionId: world.session.sessionId })).hermesRuntime).toMatchObject({ key: 'new-key', runId: 'run_newer' });
  expect(history.body.data.turns[0].outcome).toBe('pending');
  expect(world.state.runs).toHaveLength(0); expect(world.state.inference).toHaveLength(0);
});

test('a partial Hermes terminal receipt remains unconfirmed and never admits a replacement action', async () => {
  world = await fixture(); const id = randomUUID(), nativeId = 'run_partial';
  await conversations.acceptTurn({ sessionId: world.session.sessionId, packId: world.session.packId, scopeId: world.session.scopeId,
    modeId: world.session.modeId, traceId: id, clientTurnId: id, inputText: 'Demande originale.', channel: 'voice' });
  world.state.active.set(nativeId, { id: nativeId, done: true }); world.state.partial = true;
  await conversations.updateSession({ sessionId: world.session.sessionId }, { $set: { hermesRuntime: {
    state: 'running', runId: nativeId, key: 'partial-original-key', sessionKey: 'agentx:personal:' + world.session.sessionId,
    turnId: id, requestText: 'Demande originale.' } } });
  const history = await request(world.app).get(`/sessions/${world.session.sessionId}/history`).expect(200);
  expect(history.body.data.policy.nativeRecovery).toEqual({ state: 'unconfirmed' });
  expect(history.body.data.turns[0].outcome).toBe('pending');
  await world.send('Nouvelle question.').expect(502);
  expect(world.state.runs).toHaveLength(0); expect(world.state.inference).toHaveLength(0);
});

// Review regressions: exact Family route and interrupted fragment provenance.
test('Family remains usable with a valid family-only route and no personal daily_operator', async () => {
  world = await fixture('agentx'); world.state.familyOnly = true; world.state.busy = false;
  const primary = await world.send('Explique les nuages.').expect(200);
  expect(done(primary).reply.text).toBe('Réponse du principal.');
  world.state.busy = true;
  const backup = await world.send('Et la pluie ?').expect(200);
  expect(done(backup).tools.conversationRelay).toMatchObject({ role: 'relay', completed: true });
  expect(world.state.inference.map(input => input.model)).toEqual(['synthetic-main', 'synthetic-main', 'synthetic-guardian']);
});

test('Family relay fits the unchanged budget with real view, image and tool presentation contracts', async () => {
  world = await fixture('agentx', true, { richFamilyPresentation: true });
  const text = 'Dans cet exercice fictif, décris une luciole en une phrase.';
  const response = await world.send(text).expect(200);
  expect(done(response).tools.conversationRelay).toMatchObject({ role: 'relay', completed: true });
  const backup = world.state.inference.at(-1);
  expect(backup.model).toBe('synthetic-guardian');
  expect(backup.messages[0].content).toContain(packs.packById('kidx_nestor').systemPrompt);
  expect(backup.messages[0].content).toContain('"temperatureC":4.5');
  expect(backup.messages[0].content).toContain('Environnement Canada');
  expect(backup.messages[0].content).not.toContain('iss_passes');
  expect(backup.messages[0].content).not.toContain('source="draw"');
  expect(backup.messages[0].content).not.toContain('destination-id');
  expect(backup.messages.at(-1)).toEqual({ role: 'user', content: text });
  expect(backup.messages.reduce((size, row) => size + row.content.length, 0)).toBeLessThanOrEqual(12000);
  expect(backup.options.num_ctx).toBe(8192);
  expect(backup.options.num_predict).toBe(384);
  expect(backup.tools).toBeUndefined();
});

test('interrupted guardian fragments keep provenance and unknown playback without claiming a complete reply', async () => {
  world = await fixture('agentx'); world.state.backupStream = true;
  let complete; world.state.streamCompletion = new Promise(resolve => { complete = resolve; });
  const id = randomUUID(), pending = world.send('Explique les nuages.', id).then(value => value);
  await until(() => world.state.inference.length === 2);
  await tick();
  const stopped = request(world.app).post(`/sessions/${world.session.sessionId}/interrupt`).send({ turnId: id, stop: true }).then(value => value);
  await until(() => world.activePersonaTurns.get(world.session.sessionId)?.abort.signal.aborted);
  complete({ completed: true, terminalComplete: true });
  const response = await pending; expect((await stopped).status).toBe(200);
  expect(events(response).filter(event => event.type === 'delta').map(event => event.delta).join('')).toContain('Je peux continuer la');
  const row = await conversations.getTurn({ sessionId: world.session.sessionId, traceId: id });
  expect(row.outcome).toBe('cancelled');
  expect(row.toolEvidence?.conversationRelay).toMatchObject({ role: 'relay', completed: false,
    fragment: { observation: 'reply_parser_input', playback: 'unverified' } });
  const context = await relayContext(conversations, world.session);
  expect(context).toContain('Je peux continuer la');
  expect(context).toContain('reply_parser_input');
  expect(context).toContain('unverified');
  world.state.busy = false;
  await world.send('Continuons.').expect(200);
  const returned = JSON.stringify(world.state.inference.at(-1).messages);
  expect(returned).toContain('Temporary relay fragment');
  expect(returned).toContain('reply completion and hearing unverified');
  expect(returned).toContain('reply_parser_input');
  expect(returned).toContain('Je peux continuer la');
});

test.each([16001, 50000])('Hermes opt-in retains its existing %i-character reply contract in the original canonical slot', async size => {
  world = await fixture(); world.state.held = false; world.state.nativeOutput = 'x'.repeat(size);
  const id = randomUUID(), response = await world.send('Développe cette explication.', id, 'text', false).expect(200);
  expect(response.body.data.reply.text).toHaveLength(size);
  const row = await conversations.getTurn({ sessionId: world.session.sessionId, traceId: id });
  expect(row.outcome).toBe('completed'); expect(row.replyText).toBe(world.state.nativeOutput);
  expect(row.toolEvidence.runId).toBe(world.state.runs[0].id);
  expect(world.state.runs).toHaveLength(1);
});
