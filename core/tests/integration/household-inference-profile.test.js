'use strict';

// Real HTTP, preference ownership and durable work storage; no live inference.
const config = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'synthetic-worker',
  PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'synthetic-guardian', PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-private-work-binding-token',
  PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL: 'synthetic-cloud/deep-model', PERSONAL_CONVERSATION_CLOUD_GUARDIAN_MODEL: 'synthetic-cloud/fast-model',
  OPENCLAW_GATEWAY_URL: 'http://native.invalid', OPENCLAW_GATEWAY_TOKEN: 'synthetic-gateway-token' };
const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
Object.assign(process.env, config);
jest.mock('../../surfaces/household/personal-continuity', () => ({ createNestorClient: () => async () => ({
  agents: [{ id: 'main', personalNotes: true }, { id: 'synthetic-guardian', internal: true }],
  capabilities: { isolatedWork: true, nativeConversation: true, nativeReadBudget: true }
}) }));
jest.mock('../../surfaces/household/conversation-agent', () => {
  const actual = jest.requireActual('../../surfaces/household/conversation-agent');
  const agent = jest.fn(async request => {
    const { randomUUID } = require('node:crypto');
    const sessionKey = actual.sessionKeyFor(request.session), runId = 'resp_' + randomUUID();
    await request.onStarted(sessionKey, runId); request.onDelta('Bonjour !');
    await request.onSettled(sessionKey, runId);
    return { text: 'Bonjour !', sessionKey, runId, metadata: { model: 'synthetic-native', guardianDisposition: 'answered' },
      tools: { status: 'observed', receipts: [], run: { runId, sessionKey, model: 'synthetic-native' } } };
  });
  return { ...actual, createAgentClient: () => agent, agentForTest: agent };
});
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../src/app');
const Work = require('../../models/ConversationWorkState');
const Preferences = require('../../models/ConversationPreferences');
const { agentForTest } = require('../../surfaces/household/conversation-agent');
const endpoint = '/api/voice-personas/preferences', sessions = '/api/voice-personas/private/sessions';
const select = async inferenceProfile => {
  const current = (await request(app).get(endpoint).expect(200)).body.data;
  await request(app).put(endpoint).send({ revision: current.revision, values: { inferenceProfile,
    memoryContext: false, knowledgeContext: false, householdContext: false, backgroundReview: false } }).expect(200);
};
const create = async () => (await request(app).post(sessions).send({ packId: 'personal_operator', backend: 'openclaw' }).expect(201)).body.data.session;
beforeEach(async () => { await Preferences.deleteMany({}); agentForTest.mockClear(); process.env.PERSONAL_CONVERSATION_WORK_MODE = 'native'; });
afterAll(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

test('saved profiles reach the dedicated guardian while requests cannot choose models or alter the Main owner', async () => {
  await select('full_cloud');
  const session = await create(), firstTurn = randomUUID();
  await request(app).post(`${sessions}/${session.sessionId}/turns/text`).send({ text: 'Bonjour.', channel: 'voice', turnId: firstTurn,
    model: 'untrusted-provider/arbitrary-model', performanceProfile: 'local' }).expect(200);
  const first = await Work.findOne({ sessionId: session.sessionId, turnId: firstTurn }).lean();
  expect(first.performance).toMatchObject({ profile: 'full_cloud', boss: { model: 'synthetic-cloud/deep-model' } });
  const sent = agentForTest.mock.calls.at(-1)[0];
  expect(sent.session.agentId).toBe('synthetic-guardian'); expect(sent.model).toBe('synthetic-cloud/fast-model');
  expect(sent.instructions).toContain('You have no tools');
  expect(sent.canonicalSession.sessionId).toBe(session.sessionId);
  await select('local');
  const nextTurn = randomUUID();
  await request(app).post(`${sessions}/${session.sessionId}/turns/text`).send({ text: 'Bonjour.', channel: 'voice', turnId: nextTurn }).expect(200);
  const next = await Work.findOne({ sessionId: session.sessionId, turnId: nextTurn }).lean();
  expect(next.performance).toEqual({ profile: 'local', guardian: {}, boss: {} });
  expect(agentForTest.mock.calls.at(-1)[0].model).toBeUndefined();
  expect((await Work.findById(first._id).lean()).performance).toEqual(first.performance);
});

test('disabling native work refuses a saved cloud profile before an ordinary local run can replace it', async () => {
  await select('boss_cloud');
  const session = await create(), calls = agentForTest.mock.calls.length;
  process.env.PERSONAL_CONVERSATION_WORK_MODE = 'off';
  const refused = await request(app).post(`${sessions}/${session.sessionId}/turns/text`)
    .send({ text: 'Bonjour.', channel: 'voice', turnId: randomUUID() }).expect(409);
  expect(refused.body.code).toBe('CONVERSATION_INFERENCE_PROFILE_UNAVAILABLE');
  expect(agentForTest.mock.calls.length).toBe(calls);
  expect(await Work.countDocuments({ sessionId: session.sessionId })).toBe(0);
});
