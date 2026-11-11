'use strict';
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createConversationWorks } = require('../../src/services/conversationWorks/service');
const { registerConversationWorkRoutes } = require('../../src/services/conversationWorks/routes');
const { createWorkDelivery } = require('../../src/services/conversationWorks/delivery');
const Model = require('../../models/ConversationWorkState');
const { EXCHANGE_SCOPE } = require('../../src/services/conversationWorks/contract');
const conversations = forSurface('household');
const env = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'worker',
  PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-question-callback-credential' };
let works, session, row, native, runtime, effects, app, loseAck, effectGate, effectStarted, clock;
const answer = { answers: { date: ['Tuesday'] } };
const humanUrl = () => `/private/sessions/${session.sessionId}/work/${row._id}/questions`;
const lookupUrl = id => `/private/sessions/${session.sessionId}/work/${row._id}/question-intents/${id}`;
const fixtureQuestion = () => ({ id: 'ask_synthetic_day', incarnation: 'opaque-incarnation-original',
  agentId: row.attempt.agentId, sessionKey: row.attempt.sessionKey, runId: row.attempt.runId,
  status: 'pending', createdAtMs: clock, expiresAtMs: clock + 60000,
  questions: [{ questionId: 'date', header: 'Date', question: 'Which synthetic day?',
    options: [{ label: 'Monday' }, { label: 'Tuesday' }], isOther: false, isSecret: false }] });
async function observe() {
  await works.questions.refresh(session.sessionId);
  const saved = await works.repo.get(row._id);
  return (await works.questions.projection(saved)).questions[0];
}
const decision = (question, id = randomUUID()) => ({ requestId: id, basis: question.basis, answers: answer });
beforeAll(async () => { await Model.createCollection(); await Model.createIndexes(); });
beforeEach(async () => {
  await Model.collection.deleteMany({});
  await mongoose.connection.collection('conversation_exchange_receipts').deleteMany({ scope: EXCHANGE_SCOPE });
  clock = Date.now(); effects = 0; loseAck = false; effectGate = null; effectStarted = null;
  runtime = { observe: jest.fn(async () => ({ contract: 1, questions: [native] })),
    effect: jest.fn(async input => {
      const packet = await works.questions.claim(input);
      if (packet.question.incarnation !== native.incarnation) return { contract: 1, status: 'mismatch' };
      if (packet.action === 'resolve') {
        effects++; effectStarted?.();
        if (effectGate) await effectGate;
        native = { ...native, status: 'answered', answers: answer, resolutionId: packet.resolutionId };
        if (loseAck) throw Error('Synthetic lost native response');
      }
      return { contract: 1, incarnation: native.incarnation, status: native.status,
        ...(native.status === 'answered' && { answers: native.answers, resolutionId: native.resolutionId }) };
    }) };
  works = createConversationWorks({ conversations, tasks: {}, env, nativePrimary: true, questionRuntime: runtime, now: () => new Date(clock) });
  session = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal',
    modeId: 'standard', status: 'active', agentId: 'main', backend: 'openclaw', turnCount: 0 });
  const accepted = await works.intake({ session, turnId: randomUUID(), text: 'Help choose a day.', channel: 'voice' });
  await works.prepare(accepted.row._id, 'Synthetic selected context');
  const attempt = { id: randomUUID(), sessionId: randomUUID(), agentId: 'main', runId: 'resp_' + randomUUID() };
  attempt.sessionKey = `agent:main:household:direct:${attempt.sessionId}`;
  row = await works.repo.mutate(accepted.row._id, () => ({ fields: { state: 'running', attempt }, event: 'fixture_native_started' }));
  native = fixtureQuestion();
  app = express(); app.use(express.json()); registerConversationWorkRoutes(app, { works, env });
});

test('real Core HTTP persists the exact human intent before the transport consumes it; replay only reads its receipt', async () => {
  const shown = await observe(), input = decision(shown);
  const response = await request(app).post(humanUrl()).send(input);
  expect(response.status).toBe(200);
  expect(response.body.data.intent).toMatchObject({ requestId: input.requestId, resolutionId: input.requestId, state: 'answered' });
  expect(effects).toBe(1);
  expect((await request(app).post(humanUrl()).send(input)).status).toBe(200);
  expect(effects).toBe(1);
  expect((await request(app).get(lookupUrl(input.requestId))).body.data.intent.state).toBe('answered');
  expect((await request(app).post(humanUrl()).send({ ...input, answers: { answers: { date: ['Monday'] } } })).status).toBe(409);
  expect((await request(app).post(humanUrl()).send(decision(shown))).status).toBe(409);
  expect(effects).toBe(1);
});

test('concurrent identical HTTP deliveries share one admission; the other transport can only lookup', async () => {
  let release; effectGate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { effectStarted = resolve; });
  const input = decision(await observe());
  const completed = Promise.all([request(app).post(humanUrl()).send(input), request(app).post(humanUrl()).send(input)]);
  try { await Promise.race([started, completed]); expect(effects).toBe(1); }
  finally { release(); }
  const responses = await completed;
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  expect((await works.questions.lookup(session.sessionId, row._id, input.requestId)).intent.state).toBe('answered');
  expect(effects).toBe(1);
});

test('lost ACK, recreated service and concurrent lookups retain the original resolution ID with one effect', async () => {
  const input = decision(await observe()); loseAck = true;
  const initial = await request(app).post(humanUrl()).send(input);
  expect(initial.body.data.intent.state).toBe('unknown');
  expect(effects).toBe(1);
  works = createConversationWorks({ conversations, tasks: {}, env, nativePrimary: true, questionRuntime: runtime, now: () => new Date(clock) });
  await Promise.all([works.questions.lookup(session.sessionId, row._id, input.requestId), works.questions.refresh(session.sessionId)]);
  expect((await works.questions.lookup(session.sessionId, row._id, input.requestId)).intent)
    .toMatchObject({ resolutionId: input.requestId, state: 'answered' });
  expect(effects).toBe(1);
});

test('later canonical context retains the explicit answer separately from its unknown native outcome', async () => {
  const input = decision(await observe()); loseAck = true;
  await works.questions.submit(session.sessionId, row._id, input);
  const context = await works.conversationContext(session.sessionId);
  expect(context.turns.find(turn => turn.turnId === row.turnId).questionDecisions).toMatchObject([{
    source: 'explicit_surface_form', requestId: input.requestId, requestSha256: row.requestSha256,
    questionSha256: input.basis.questionSha256, questions: [{ questionId: 'date', question: 'Which synthetic day?' }],
    answers: answer, nativeOutcome: 'unknown' }]);
  expect(JSON.stringify(context)).not.toContain(native.incarnation);
  expect(JSON.stringify(context)).not.toContain(env.PERSONAL_CONVERSATION_WORK_TOKEN);
});

test('reused native ID and identical question text cannot apply a previously shown intent to its new incarnation', async () => {
  const shown = await observe();
  native = { ...native, incarnation: 'opaque-incarnation-successor' };
  const response = await request(app).post(humanUrl()).send(decision(shown));
  expect(response.body.data.intent.state).toBe('mismatch');
  expect(effects).toBe(0);
  expect(native.status).toBe('pending');
  expect((await observe()).basis.incarnation).toBe('opaque-incarnation-successor');
});

test('64 completed native works cannot hide the current question from the real Core snapshot', async () => {
  const history = Array.from({ length: 64 }, () => ({ ...row, _id: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    state: 'completed', sequence: 0, receivedAt: new Date(clock - 86400000),
    attempt: { ...row.attempt, id: randomUUID(), sessionKey: 'agent:main:household:direct:' + randomUUID() },
    result: { version: 1 } }));
  // Metadata-only historical fixtures; no invented native business results.
  await Model.collection.insertMany(history);
  const snapshot = await createWorkDelivery(works).snapshot(session.sessionId);
  expect(snapshot.items.find(item => item.id === row._id).nativeQuestions.questions[0].questions[0].question)
    .toBe('Which synthetic day?');
  expect(effects).toBe(0);
});

test('snapshot polling never steals the dispatch admission of an accepted decision', async () => {
  const originalEffect = runtime.effect;
  runtime.effect = jest.fn(async input => {
    if (!input.lookupOnly) await works.questions.refresh(session.sessionId);
    return originalEffect(input);
  });
  const response = await request(app).post(humanUrl()).send(decision(await observe()));
  expect(response.body.data.intent.state).toBe('answered');
  expect(effects).toBe(1);
});

test.each(['secret', 'store', 'foreign-run', 'foreign-session', 'resource'])('does not project or submit %s questions', async variant => {
  if (variant === 'secret') native.questions[0].isSecret = true;
  if (variant === 'store') native.questions[0].secretStore = { name: 'SYNTHETIC_SECRET', kind: 'secret' };
  if (variant === 'resource') native.questions[0].resource = { selection: 'explicit' };
  if (variant === 'foreign-run') native.runId = 'resp_' + randomUUID();
  if (variant === 'foreign-session') native.sessionKey = 'agent:main:household:direct:' + randomUUID();
  expect(await observe()).toBeUndefined();
  const shown = await works.questions.projection(await works.repo.get(row._id));
  if (['secret', 'store', 'resource'].includes(variant)) expect(shown.supported).toBe(false);
  expect(effects).toBe(0);
});

test.each(['attempt', 'request', 'expiry'])('a changed %s refuses before native effects', async variant => {
  const shown = await observe();
  await expect(works.questions.submit(randomUUID(), row._id, decision(shown))).rejects.toMatchObject({ statusCode: 404 });
  if (variant === 'attempt') await works.repo.mutate(row._id, current => ({ fields: { attempt: { ...current.attempt, id: randomUUID() } }, event: 'fixture_replaced' }));
  if (variant === 'request') await works.repo.mutate(row._id, () => ({ fields: { requestSha256: '0'.repeat(64) }, event: 'fixture_changed' }));
  if (variant === 'expiry') clock += 60001;
  expect((await request(app).post(humanUrl()).send(decision(shown))).status).toBe(variant === 'request' ? 404 : 503);
  expect(effects).toBe(0);
});

test('a retained never-admitted decision can resume explicitly after service interruption, using its original UUID once', async () => {
  const input = decision(await observe());
  const effect = runtime.effect;
  runtime.effect = jest.fn(async () => { throw Error('Interrupted before admission'); });
  expect((await request(app).post(humanUrl()).send(input)).body.data.intent.state).toBe('accepted');
  expect(effects).toBe(0);
  runtime.effect = effect;
  works = createConversationWorks({ conversations, tasks: {}, env, nativePrimary: true, questionRuntime: runtime, now: () => new Date(clock) });
  app = express(); app.use(express.json()); registerConversationWorkRoutes(app, { works, env });
  await works.questions.refresh(session.sessionId);
  expect(effects).toBe(0);
  const resumed = await request(app).post(lookupUrl(input.requestId) + '/resume').send({});
  expect(resumed.body.data.intent).toMatchObject({ state: 'answered', resolutionId: input.requestId });
  expect((await request(app).post(lookupUrl(input.requestId) + '/resume').send({})).status).toBe(409);
  expect(effects).toBe(1);
});

test('unsupported/absent native contract refuses; ordinary transcript text cannot authorize an answer', async () => {
  runtime.observe.mockResolvedValue({ contract: 0 });
  expect(await observe()).toBeUndefined();
  expect((await request(app).post(humanUrl()).send({ requestId: randomUUID(), answers: answer, text: 'yes' })).status).toBe(400);
  expect(runtime.effect).not.toHaveBeenCalled();
});

test('service credential cannot nominate arbitrary answers, and a browser cannot claim a native effect', async () => {
  const shown = await observe();
  expect((await request(app).post('/native/work').send({ operation: 'question_effect', input: { workId: row._id, intentId: randomUUID(), lookupOnly: false } })).status).toBe(404);
  expect((await request(app).post('/native/work').set('Authorization', `Bearer ${env.PERSONAL_CONVERSATION_WORK_TOKEN}`)
    .send({ operation: 'question_effect', input: { workId: row._id, intentId: randomUUID(), lookupOnly: false, answers: answer } })).status).toBe(400);
  expect((await works.questions.projection(await works.repo.get(row._id))).questions[0].basis).toEqual(shown.basis);
  expect(effects).toBe(0);
});

test('an inaccessible native endpoint and retained intents cannot hold the entire work feed', async () => {
  const input = decision(await observe());
  runtime.effect = jest.fn(async () => { throw Error('Interrupted before admission'); });
  await works.questions.submit(session.sessionId, row._id, input);
  await works.repo.mutate(row._id, current => ({ fields: { nativeQuestions: { ...current.nativeQuestions,
    intents: [...current.nativeQuestions.intents, ...Array.from({ length: 3 }, () => ({ ...current.nativeQuestions.intents[0], id: randomUUID() }))] } }, event: 'fixture_retained_intents' }));
  runtime.observe = jest.fn((_row, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  runtime.effect.mockClear();
  const response = await request(app).get(`/private/sessions/${session.sessionId}/work`).timeout({ deadline: 3500 });
  expect(response.status).toBe(200);
  expect(response.body.data.items.find(item => item.id === row._id).nativeQuestions.supported).toBe(false);
  expect(runtime.effect).not.toHaveBeenCalled();
  expect(effects).toBe(0);
});

test('disabling the Core bridge refuses a retained unsent decision at the real native callback admission', async () => {
  const input = decision(await observe());
  runtime.effect = jest.fn(async () => { throw Error('Interrupted before admission'); });
  await works.questions.submit(session.sessionId, row._id, input);
  works = createConversationWorks({ conversations, tasks: {}, env, nativePrimary: true });
  app = express(); app.use(express.json()); registerConversationWorkRoutes(app, { works, env });
  const reply = await request(app).post('/native/work').set('Authorization', `Bearer ${env.PERSONAL_CONVERSATION_WORK_TOKEN}`)
    .send({ operation: 'question_effect', input: { workId: row._id, intentId: input.requestId, lookupOnly: false } });
  expect(reply.status).toBe(503);
  const saved = await works.repo.get(row._id);
  expect(saved.nativeQuestions.intents[0].state).toBe('accepted');
  const projection = await works.questions.projection(saved);
  expect(projection.supported).toBe(false); expect(projection.questions[0].answerable).toBe(false);
  expect(effects).toBe(0);
});

test('disabling the bridge retains only lookup authority for an already admitted uncertain effect', async () => {
  const input = decision(await observe()); loseAck = true;
  await works.questions.submit(session.sessionId, row._id, input);
  works = createConversationWorks({ conversations, tasks: {}, env, nativePrimary: true });
  const packet = await works.questions.claim({ workId: row._id, intentId: input.requestId, lookupOnly: false });
  expect(packet.action).toBe('lookup'); expect(packet.resolutionId).toBe(input.requestId);
  expect(packet.answers).toBeUndefined(); expect(effects).toBe(1);
});

test('canonical erasure removes questions/intents and late native completion cannot restore content or enable another send', async () => {
  let release; effectGate = new Promise(resolve => { release = resolve; });
  const input = decision(await observe());
  const pending = works.questions.submit(session.sessionId, row._id, input);
  while (effects === 0) await new Promise(resolve => setImmediate(resolve));
  await conversations.deleteSession({ sessionId: session.sessionId, packId: 'personal_operator', scopeId: 'personal' });
  release();
  await expect(pending).rejects.toMatchObject({ statusCode: 404 });
  const erased = await Model.collection.findOne({ _id: row._id });
  expect(erased.erased).toBe(true);
  expect(erased.nativeQuestions).toBeUndefined();
  await expect(works.questions.claim({ workId: row._id, intentId: input.requestId, lookupOnly: false })).rejects.toMatchObject({ statusCode: 404 });
  expect(effects).toBe(1); // admitted before erasure; erasure is not a cancellation receipt
});
