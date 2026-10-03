'use strict';

process.env.AGENTX_PARENTAL_CODE = 'synthetic-persona-access';

jest.mock('../../src/extensions/trustedRuntimeServices', () => {
  const actual = jest.requireActual('../../src/extensions/trustedRuntimeServices');
  const execute = jest.fn(async () => ({ ok: true, body: { response: 'Bonjour, réponse synthétique.' }, metadata: { model: 'synthetic' } }));
  return { ...actual, executeForTest: execute,
    createTrustedRuntimeServices: (...args) => ({ ...actual.createTrustedRuntimeServices(...args), inference: { execute } }) };
});

const request = require('supertest');
const { app } = require('../../src/app');
const Conversation = require('../../models/Conversation');
const PromptConfig = require('../../models/PromptConfig');
const { executeForTest } = require('../../src/extensions/trustedRuntimeServices');
const privateBase = '/api/voice-personas/private/sessions';
const familyBase = '/api/voice-personas/family/sessions';
const createPersonal = async (body = {}) => (await request(app).post(privateBase)
  .send({ packId: 'personal_operator', backend: 'agentx', ...body }).expect(201)).body.data.session;
const turn = async (id, body = {}) => (await request(app).post(`${privateBase}/${id}/turns/text`)
  .send({ text: 'Bonjour.', ...body }).expect(200));

describe('Household live personality through authenticated space routes', () => {
  test('switches the snapshot between turns and preserves earlier audit attribution and execution scope', async () => {
    const session = await createPersonal(), id = session.sessionId;
    const first = (await turn(id)).body.data;
    const before = (await Conversation.findOne({ 'surfaceSession.sessionId': id }).lean()).surfaceSession;
    const switched = await request(app).post(`${privateBase}/${id}/persona`).send({ personaId: 'jarvis', agentId: 'secretary', scopeId: 'family' }).expect(200);
    expect(switched.body.data.session).toMatchObject({ agentId: 'main', scopeId: 'personal', persona: { id: 'jarvis' } });
    const after = (await Conversation.findOne({ 'surfaceSession.sessionId': id }).lean()).surfaceSession;
    expect({ ...after, persona: before.persona, updatedAt: before.updatedAt }).toEqual(before);
    const second = (await turn(id)).body.data;
    expect(executeForTest.mock.calls.at(-1)[0].messages.map(row => row.content).join(' ')).toContain('Act as Jarvis');
    const history = (await request(app).get(`${privateBase}/${id}/history`).expect(200)).body.data;
    expect(history.turns.map(row => row.speaker)).toEqual([first.speaker, second.speaker]);
    expect(first.speaker.personaId).toBe('nestor');
    expect(second.speaker.personaId).toBe('jarvis');
    expect(second.speaker.personaVersion).toBe(switched.body.data.session.persona.version);
    expect(second.reply.speaker).toEqual(second.speaker);
    expect(history.turns[1].voice).toEqual({ provider: second.reply.speech.provider, voice: second.reply.speech.voice });
  });

  test('an active turn refuses the switch with 409 and releases the session afterwards', async () => {
    const { sessionId: id } = await createPersonal();
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    const completion = new Promise(resolve => { release = resolve; });
    executeForTest.mockImplementationOnce(async () => { started(); return completion; });
    const pending = turn(id);
    await entered;
    try {
      expect((await request(app).post(`${privateBase}/${id}/persona`).send({ personaId: 'jarvis' }).expect(409)).body.code).toBe('VOICE_TURN_IN_PROGRESS');
    } finally { release({ ok: true, body: { response: 'Bonjour.' }, metadata: {} }); await pending; }
    await request(app).post(`${privateBase}/${id}/persona`).send({ personaId: 'jarvis' }).expect(200);
  });

  test('refuses inactive exact versions, resolves the latest active and accepts an active exact version', async () => {
    const { sessionId: id } = await createPersonal();
    const definition = { name: 'synthetic_live_personality', systemPrompt: 'Synthetic presentation.', uiConfig: { type: 'chat', route: '/index.html' } };
    await PromptConfig.create([{ ...definition, version: 1, isActive: false }, { ...definition, version: 2, isActive: true }]);
    const change = body => request(app).post(`${privateBase}/${id}/persona`).send(body);
    expect((await change({ personaId: definition.name, personaVersion: 1 }).expect(400)).body.code).toBe('VOICE_PERSONA_INACTIVE');
    expect((await change({ personaId: definition.name }).expect(200)).body.data.session.persona.version).toBe(2);
    expect((await change({ personaId: definition.name, personaVersion: 2 }).expect(200)).body.data.session.persona.version).toBe(2);
    await change({ personaId: definition.name, personaVersion: 'bad' }).expect(400);
    await change({ personaId: 'synthetic_missing_personality' }).expect(404);
  });

  test('keeps the native agent boundary for a tone overlay and refuses a personality bound to another agent', async () => {
    const { sessionId: id } = await createPersonal({ personaId: 'secretary' });
    const change = personaId => request(app).post(`${privateBase}/${id}/persona`).send({ personaId });
    expect((await change('nestor').expect(400)).body.code).toBe('VOICE_PERSONA_AGENT_MISMATCH');
    expect((await change('jarvis').expect(200)).body.data.session.agentId).toBe('secretary');
    expect((await turn(id)).body.data.speaker).toMatchObject({ agentId: 'secretary', personaId: 'jarvis' });
    expect((await change(null).expect(200)).body.data.session.persona).toBeNull();
    expect((await turn(id)).body.data.speaker).toEqual({ agentId: 'secretary', personaId: null, personaVersion: null, name: 'secretary' });
  });

  test('Family allows Nestor or no personality while cross-space and closed sessions are refused', async () => {
    const id = (await request(app).post(familyBase).send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    const change = personaId => request(app).post(`${familyBase}/${id}/persona`).send({ personaId });
    for (const personaId of ['secretary', 'jarvis']) expect((await change(personaId).expect(400)).body.code).toBe('VOICE_PERSONA_FAMILY_PERSONA_REQUIRED');
    expect((await change('nestor').expect(200)).body.data.session).toMatchObject({ agentId: 'family', scopeId: 'family', persona: { id: 'nestor' } });
    const reply = await request(app).post(`${familyBase}/${id}/turns/text`).send({ text: 'Compte jusqu’à 3', stream: true }).expect(200);
    const done = reply.text.trim().split('\n').map(JSON.parse).find(row => row.type === 'done').data;
    expect(done.speaker).toMatchObject({ agentId: 'family', personaId: 'nestor' });
    expect((await change(null).expect(200)).body.data.session).toMatchObject({ agentId: 'family', persona: null });
    await request(app).post(`${privateBase}/${id}/persona`).send({ personaId: 'jarvis' }).expect(404);
    const personal = await createPersonal();
    await request(app).post(`${familyBase}/${personal.sessionId}/persona`).send({ personaId: 'nestor' }).expect(404);
    await Conversation.updateOne({ 'surfaceSession.sessionId': id }, { $set: { 'surfaceSession.status': 'closed' } });
    await change('nestor').expect(404);
    await request(app).post(`${privateBase}/synthetic-missing/persona`).send({ personaId: 'jarvis' }).expect(404);
  });

  test('instance voices apply at turn time, after a live switch, and explicit choices still win', async () => {
    const previous = process.env.HOUSEHOLD_PERSONA_VOICES;
    try {
      process.env.HOUSEHOLD_PERSONA_VOICES = '{"*":"voxcpm|synthetic-old"}';
      const { sessionId: id } = await createPersonal();
      const saved = (await Conversation.findOne({ 'surfaceSession.sessionId': id }).lean()).surfaceSession.persona;
      expect(saved.voice.voices.fr).toBe('synthetic-old');
      process.env.HOUSEHOLD_PERSONA_VOICES = '{"nestor":"windows_sapi|synthetic-new"}';
      const first = (await turn(id)).body.data;
      expect(first.reply.speech).toMatchObject({ provider: 'windows_sapi', voice: 'synthetic-new' });
      process.env.HOUSEHOLD_PERSONA_VOICES = '{"jarvis":"voxcpm|synthetic-switch"}';
      const switched = (await request(app).post(`${privateBase}/${id}/persona`).send({ personaId: 'jarvis' }).expect(200)).body.data.session;
      expect(switched.persona.voice.voices.fr).toBe('synthetic-switch');
      process.env.HOUSEHOLD_PERSONA_VOICES = '{"jarvis":"voxcpm|synthetic-live"}';
      const live = (await turn(id)).body.data;
      expect(live.reply.speech).toMatchObject({ provider: 'voxcpm', voice: 'synthetic-live' });
      delete process.env.HOUSEHOLD_PERSONA_VOICES;
      const restored = (await turn(id)).body.data;
      expect(restored.reply.speech).toMatchObject({ provider: 'kokoro', voice: 'bm_lewis:0.50+ff_siwis:0.50' });
      const history = (await request(app).get(`${privateBase}/${id}/history`).expect(200)).body.data.turns;
      expect(history.map(row => row.voice)).toEqual([first, live, restored].map(result => ({ provider: result.reply.speech.provider, voice: result.reply.speech.voice })));
      process.env.HOUSEHOLD_PERSONA_VOICES = '{"*":"voxcpm|synthetic-live"}';
      const selected = await createPersonal({ voice: { selections: { fr: 'kokoro|ff_siwis' } } });
      expect((await turn(selected.sessionId)).body.data.reply.speech).toMatchObject({ provider: 'kokoro', voice: 'ff_siwis' });
    } finally {
      if (previous === undefined) delete process.env.HOUSEHOLD_PERSONA_VOICES;
      else process.env.HOUSEHOLD_PERSONA_VOICES = previous;
    }
  });

  test('both personality write routes use the existing adult gateway authentication', async () => {
    const session = await createPersonal();
    const family = (await request(app).post(familyBase).send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx' }).expect(201)).body.data.session;
    for (const [base, id] of [[privateBase, session.sessionId], [familyBase, family.sessionId]]) {
      expect((await request(app).post(`${base}/${id}/persona`).set('X-AgentX-Entry', 'household')
        .send({ personaId: 'nestor' }).expect(401)).body.code).toBe('ADULT_LOCKED');
    }
    const unlocked = await request(app).post('/api/access/unlock').set('X-AgentX-Entry', 'household')
      .send({ code: 'synthetic-persona-access' }).expect(200);
    const cookie = unlocked.headers['set-cookie'][0].split(';')[0];
    for (const [base, id] of [[privateBase, session.sessionId], [familyBase, family.sessionId]]) {
      await request(app).post(`${base}/${id}/persona`).set('X-AgentX-Entry', 'household').set('Cookie', cookie)
        .send({ personaId: 'nestor' }).expect(200);
    }
  });
});
