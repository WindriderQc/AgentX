'use strict';

// Only inference is synthetic. HTTP mounts, persona resolution and Mongo
// persistence use the real app and the suite-owned disposable database.
jest.mock('../../src/extensions/trustedRuntimeServices', () => {
  const actual = jest.requireActual('../../src/extensions/trustedRuntimeServices');
  const execute = jest.fn(async () => ({ ok: true, body: { response: 'Synthetic response' }, metadata: { model: 'synthetic' } }));
  return { ...actual, executeForTest: execute,
    createTrustedRuntimeServices: (...args) => ({ ...actual.createTrustedRuntimeServices(...args), inference: { execute } }) };
});

jest.mock('../../surfaces/household/conversation-agent', () => {
  const actual = jest.requireActual('../../surfaces/household/conversation-agent');
  const agent = jest.fn(async request => {
    const sessionKey = actual.sessionKeyFor(request.session), runId = 'resp_22222222-2222-4222-8222-222222222222';
    await request.onStarted(sessionKey, runId); request.onDelta('Synthetic native reply.'); await request.onSettled();
    return { text: 'Synthetic native reply.', sessionKey, runId, metadata: { model: 'synthetic-native' },
      tools: { status: 'observed', receipts: [], run: { runId, sessionKey, model: 'synthetic-native' } } };
  });
  return { ...actual, createAgentClient: () => agent, agentForTest: agent };
});

const request = require('supertest');
const { app } = require('../../src/app');
const PipelineTask = require('../../models/PipelineTask');
const Conversation = require('../../models/Conversation');
const PlanningItem = require('../../models/PlanningItem');
const { executeForTest } = require('../../src/extensions/trustedRuntimeServices');
const { agentForTest } = require('../../surfaces/household/conversation-agent');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { listenLoopback } = require('../../../shared/testing/listenLoopback');
const { ageInYears, instanceToday } = require('../../src/domains/household/familyBirthDate');
// Super Dad says what the records hold and what they do not (#119 follow-up).
const KNOWN_UNKNOWN = 'dis simplement ce que tu ne sais pas; ne devine jamais un âge exact';

describe('built-in Household surface on Core', () => {
  test('Household refuses excess input before inference or audit and keeps a complete boundary-sized request', async () => {
    const base = '/api/voice-personas/private/sessions';
    const id = (await request(app).post(base).send({ packId: 'personal_operator', scopeId: 'personal', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    const calls = executeForTest.mock.calls.length;
    const rejected = await request(app).post(`${base}/${id}/turns/text`).send({ text: 'é'.repeat(3999) + '🦉' }).expect(413);
    expect(rejected.body.code).toBe('VOICE_PERSONA_TEXT_TOO_LARGE');
    const scene = await request(app).post(`/api/consumers/nestor/v1/llmx/sessions/${id}/turns/text`)
      .send({ text: 'é'.repeat(3999) + '🦉', turnId: '11111111-1111-4111-8111-111111111111' }).expect(413);
    expect(scene.body.code).toBe('VOICE_PERSONA_TEXT_TOO_LARGE');
    expect(executeForTest.mock.calls.length).toBe(calls);
    const untouched = await Conversation.findOne({ 'surfaceSession.sessionId': id }).lean();
    expect(untouched.messages).toEqual([]);
    expect(untouched.surfaceSession.turnCount).toBe(0);
    const text = 'é'.repeat(3998) + '🦉';
    await request(app).post(`${base}/${id}/turns/text`).send({ text }).expect(200);
    const saved = await Conversation.findById(untouched._id).lean();
    expect(saved.messages[0].content).toBe(text);
    expect(executeForTest.mock.calls.at(-1)[0].messages.at(-1).content).toContain(text);
    expect(saved.surfaceSession.turnCount).toBe(1);
  });
  test('the server selects a bound personality’s agent and refuses conflicting choices without creating a session', async () => {
    const base = '/api/voice-personas/private/sessions';
    const create = body => request(app).post(base).send({ packId: 'personal_operator', backend: 'agentx', ...body });
    const secretary = (await create({ personaId: 'secretary' }).expect(201)).body.data.session;
    expect(secretary).toMatchObject({ agentId: 'secretary', persona: { id: 'secretary' }, scopeId: 'personal' });
    const overlay = (await create({ personaId: 'jarvis', agentId: 'secretary' }).expect(201)).body.data.session;
    expect(overlay).toMatchObject({ agentId: 'secretary', persona: { id: 'jarvis' } });
    expect((await Conversation.findOne({ 'surfaceSession.sessionId': secretary.sessionId }).lean()).surfaceSession.persona.agentId).toBe('secretary');
    const before = await Conversation.countDocuments({});
    expect((await create({ personaId: 'secretary', agentId: 'main' }).expect(400)).body.code).toBe('VOICE_PERSONA_AGENT_MISMATCH');
    expect(await Conversation.countDocuments({})).toBe(before);
    await request(app).post(`${base}/${secretary.sessionId}/turns/text`).send({ text: 'Bonjour.' }).expect(200);
    expect(executeForTest.mock.calls.at(-1)[0].messages.map(message => message.content).join(' ')).toContain('No native agent tools');
    await request(app).post(`/api/voice-personas/family/sessions/${secretary.sessionId}/turns/text`).send({ text: 'Bonjour.' }).expect(403);
  });

  test('Family creation keeps its family isolation boundary even when Nestor declares main', async () => {
    const base = '/api/voice-personas/family/sessions';
    const create = body => request(app).post(base).send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx', agentId: 'secretary', ...body });
    expect((await create({ personaId: 'nestor' }).expect(201)).body.data.session).toMatchObject({ agentId: 'family', persona: { id: 'nestor' } });
    expect((await create({}).expect(201)).body.data.session).toMatchObject({ agentId: 'family', persona: null });
    for (const personaId of ['secretary', 'jarvis']) {
      expect((await create({ personaId }).expect(400)).body.code).toBe('VOICE_PERSONA_FAMILY_PERSONA_REQUIRED');
    }
  });
  test('the panel stays ready when optional OpenClaw evidence is absent', async () => {
    const previousEvidence = app.locals.aioOpsRuntimeEvidence;
    const previousVoixUrl = process.env.VOIX_BASE_URL;
    const originalFetch = global.fetch;
    delete app.locals.aioOpsRuntimeEvidence;
    process.env.VOIX_BASE_URL = 'http://voix.example.test';
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/nerve-center/ecosystem') {
        return new Response(JSON.stringify({ data: { health: { status: 'ok', configuredHosts: 1, onlineHosts: 1 },
          cluster: [{ hostKey: 'primary', status: 'online' }], operationalAttention: { issues: [] } } }),
        { headers: { 'Content-Type': 'application/json' } });
      }
      if (pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url);
    });
    try {
      const response = await request(app).get('/api/panel/status').expect(200);
      expect(response.body.data.crew.find(member => member.id === 'openclaw')).toMatchObject({
        status: 'unknown', detail: 'agent status unavailable'
      });
      expect(response.body.data.status).toBe('ok');
    } finally {
      fetchMock.mockRestore();
      app.locals.aioOpsRuntimeEvidence = previousEvidence;
      if (previousVoixUrl === undefined) delete process.env.VOIX_BASE_URL;
      else process.env.VOIX_BASE_URL = previousVoixUrl;
    }
  });
  test('optional Data down degrades AgentX without marking AgentX or Nestor down', async () => {
    const previous = { voix: process.env.VOIX_BASE_URL, data: process.env.DATAAPI_BASE_URL };
    process.env.VOIX_BASE_URL = 'http://voix.example.test';
    process.env.DATAAPI_BASE_URL = 'http://data.example.test';
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async url => {
      const { hostname, pathname } = new URL(String(url));
      if (hostname === 'data.example.test') throw new Error('fetch failed');
      if (pathname === '/api/nerve-center/ecosystem') {
        return new Response(JSON.stringify({ data: { health: { status: 'ok', configuredHosts: 1, onlineHosts: 1 },
          cluster: [{ hostKey: 'primary', status: 'online' }], operationalAttention: { issues: [] } } }),
        { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/json' } });
    });
    try {
      const { data } = (await request(app).get('/api/panel/status').expect(200)).body;
      expect(data.services.map(service => [service.id, service.status, service.optional === true])).toEqual([
        ['core', 'ok', false], ['benchmark', 'ok', false], ['rag', 'ok', false], ['data', 'down', true]
      ]);
      expect(data.crew.find(member => member.id === 'agentx')).toMatchObject({
        status: 'degraded', detail: '3/3 platform services ready · optional Data unavailable'
      });
      expect(data.crew.find(member => member.id === 'nestor').status).toBe('ok');
      expect(data.status).toBe('degraded');
    } finally {
      fetchMock.mockRestore();
      for (const [name, value] of [['VOIX_BASE_URL', previous.voix], ['DATAAPI_BASE_URL', previous.data]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
  test('personal native turns carry the selected Core notes as turn context, spoken or typed, never in the instructions', async () => {
    const note = 'Synthetic observatory voice context remains available.';
    await request(app).post('/api/voice-personas/private/notes').send({ operation: 'remember', text: note, kind: 'preference' }).expect(200);
    const staleSchedule = 'Synthetic archived son prochain quand schedule.';
    await request(app).post('/api/voice-personas/private/notes').send({ operation: 'remember', text: staleSchedule, kind: 'fact' }).expect(200);
    const staleDiscussion = 'Synthetic archived déjà tout mais pendant travail.';
    await request(app).post('/api/voice-personas/private/notes').send({ operation: 'remember', text: staleDiscussion, kind: 'fact' }).expect(200);
    const creativeNote = 'Synthetic Samuel hockey preference.';
    await request(app).post('/api/voice-personas/private/notes').send({ operation: 'remember', text: creativeNote, kind: 'preference' }).expect(200);
    const created = await request(app).post('/api/voice-personas/private/sessions')
      .send({ packId: 'personal_operator', scopeId: 'personal', backend: 'openclaw', agentId: 'main' }).expect(201);
    const id = created.body.data.session.sessionId;
    await request(app).post(`/api/voice-personas/private/sessions/${id}/turns/text`)
      .send({ text: 'observatory', channel: 'voice' }).expect(200);
    expect(agentForTest.mock.calls.at(-1)[0].turnContext || '').not.toContain(note);
    await request(app).post(`/api/voice-personas/private/sessions/${id}/turns/text`)
      .send({ text: 'Quand joue son prochain match l’équipe des Comètes ?', channel: 'voice' }).expect(200);
    expect(agentForTest.mock.calls.at(-1)[0].turnContext || '').not.toContain(staleSchedule);
    await request(app).post(`/api/voice-personas/private/sessions/${id}/turns/text`)
      .send({ text: 'Déjà tout prêt, mais pendant la pause le travail avance', channel: 'voice' }).expect(200);
    expect(agentForTest.mock.calls.at(-1)[0].turnContext || '').not.toContain(staleDiscussion);
    await request(app).post(`/api/voice-personas/private/sessions/${id}/turns/text`)
      .send({ text: 'Invente une blague sur Samuel et le hockey', channel: 'voice' }).expect(200);
    expect(agentForTest.mock.calls.at(-1)[0].turnContext || '').toContain(creativeNote);
    for (const channel of ['voice', 'text']) {
      await request(app).post(`/api/voice-personas/private/sessions/${id}/turns/text`)
        .send({ text: channel === 'voice' ? 'Rappelle-moi observatory' : 'observatory', channel }).expect(200);
      const native = agentForTest.mock.calls.at(-1)[0];
      expect(native.session.sessionId).toBe(id);
      expect(native.instructions).toContain(KNOWN_UNKNOWN);
      expect(native.turnContext).toContain(note);
      expect(native.instructions).not.toContain(note);
      if (channel === 'text') expect(native.session.agentSessionKey).toContain(id);
    }
  });
  test('a turn that names a team member runs in its own session and voice, then the conversation agent hears about it (#41)', async () => {
    const names = ['HOUSEHOLD_TEAM_MEMBERS', 'OPENCLAW_GATEWAY_URL', 'OPENCLAW_GATEWAY_TOKEN'];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    Object.assign(process.env, { HOUSEHOLD_TEAM_MEMBERS: JSON.stringify({ secretary: ['secrétaire', 'secretary'] }),
      OPENCLAW_GATEWAY_URL: 'http://openclaw.example.test', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token' });
    const originalFetch = global.fetch;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      if (!String(url).startsWith('http://openclaw.example.test/')) return originalFetch(url, options);
      return new Response(JSON.stringify({ ok: true, authority: 'openclaw.nestor', operation: 'agents',
        agents: [{ id: 'main', name: 'Main' }, { id: 'secretary', name: 'Secrétaire' }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    try {
      const created = await request(app).post('/api/voice-personas/private/sessions')
        .send({ packId: 'personal_operator', scopeId: 'personal', backend: 'openclaw', agentId: 'main' }).expect(201);
      const id = created.body.data.session.sessionId;
      const turn = text => request(app).post(`/api/voice-personas/private/sessions/${id}/turns/text`).send({ text, channel: 'voice' }).expect(200);
      await turn('Bonjour Nestor');
      const direct = await turn("Bonjour Nestor, est-ce que tu peux demander à secrétaire si j'ai des factures à payer?");
      const member = agentForTest.mock.calls.at(-1)[0];
      expect(member.session).toMatchObject({ agentId: 'secretary', agentSessionKey: `agent:secretary:household:direct:${id}` });
      expect(member.instructions).toContain('addressed you (Secretary) directly');
      expect(direct.body.data.reply.speaker).toEqual({ agentId: 'secretary', name: 'Secretary', personaId: 'secretary', personaVersion: 1 });
      expect(direct.body.data.reply.speech).toMatchObject({ provider: 'kokoro', voice: 'ff_siwis' });
      const back = (await turn('Merci, et toi Nestor?'), agentForTest.mock.calls.at(-1)[0]);
      expect(back.session).toMatchObject({ agentId: 'main', agentSessionKey: `agent:main:household:direct:${id}` });
      // The exchange is reference data beside that one request; the agent's instructions never change (#261).
      expect(back.turnContext).toContain('just asked Secretary directly');
      expect(back.instructions).not.toContain('just asked Secretary directly');
      await turn('Est-ce que la secrétaire a trié mes courriels hier?');
      const passing = agentForTest.mock.calls.at(-1)[0];
      expect(passing.session.agentId).toBe('main');
      expect(passing.turnContext || '').not.toContain('just asked Secretary directly');
      expect(passing.instructions).toBe(back.instructions);
      const audit = (await request(app).get(`/api/voice-personas/audit/recent?sessionId=${id}`).expect(200)).body.data.audit;
      expect(audit.map(row => row.speakerAgentId).filter(Boolean)).toEqual(['secretary']);
    } finally {
      fetchMock.mockRestore();
      for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    }
  });
  test('a voice whose engine fails before its first sound is reported unavailable so the browser falls back', async () => {
    const originalFetch = global.fetch, previousUrl = process.env.VOIX_BASE_URL;
    process.env.VOIX_BASE_URL = 'http://voix.example.test';
    let body = '{"type":"error","message":"Local speech synthesis failed"}\n';
    const upstream = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      if (!String(url).endsWith('/api/tts/stream')) return originalFetch(url, options);
      return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    try {
      const failed = await request(app).post('/api/voix/synthesize/stream')
        .send({ text: 'Bonjour', language: 'fr', tts_provider: 'voxcpm', voice: 'example' }).expect(503);
      expect(failed.body.code).toBe('VOIX_SYNTHESIS_FAILED');
      body = '{"type":"meta","protocol":"voix-pcm-v1"}\n{"type":"done","frames":1,"samples":1}\n';
      const spoken = await request(app).post('/api/voix/synthesize/stream')
        .send({ text: 'Bonjour', language: 'fr', tts_provider: 'voxcpm', voice: 'example' })
        .buffer(true).parse((res, done) => { let text = ''; res.setEncoding('utf8'); res.on('data', d => { text += d; }); res.on('end', () => done(null, text)); })
        .expect(200);
      expect(spoken.body).toBe(body);
    } finally {
      upstream.mockRestore();
      if (previousUrl === undefined) delete process.env.VOIX_BASE_URL; else process.env.VOIX_BASE_URL = previousUrl;
    }
  });
  test('the PCM proxy removes Kokoro quote-only fragments without changing other providers', async () => {
    const quoted = 'Le hibou dit : « Tu gagnes. »';
    const upstreamBody = '{"type":"done","frames":1,"samples":1}\n';
    const requests = [], originalFetch = global.fetch, previousUrl = process.env.VOIX_BASE_URL;
    process.env.VOIX_BASE_URL = 'http://voix.example.test';
    const upstream = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      if (!String(url).endsWith('/api/tts/stream')) return originalFetch(url, options);
      requests.push(JSON.parse(options.body));
      return new Response(upstreamBody, { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const ndjson = (res, done) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', data => { body += data; }); res.on('end', () => done(null, body));
    };
    try {
      for (const provider of ['kokoro', 'voxcpm']) {
        const response = await request(app).post('/api/voix/synthesize/stream')
          .send({ text: quoted, language: 'fr', tts_provider: provider }).buffer(true).parse(ndjson).expect(200);
        expect(response.body).toBe(upstreamBody);
      }
      expect(requests[0]).toMatchObject({ text: 'Le hibou dit : « Tu gagnes.', tts_provider: 'kokoro', save: false });
      expect(requests[1]).toMatchObject({ text: quoted, tts_provider: 'voxcpm', save: false });
    } finally {
      upstream.mockRestore();
      if (previousUrl === undefined) delete process.env.VOIX_BASE_URL;
      else process.env.VOIX_BASE_URL = previousUrl;
    }
  });
  test('spoken controls select the optional adapter without changing ordinary uploads', async () => {
    const previousUrl = process.env.VOIX_BASE_URL, previousControls = process.env.VOIX_SPOKEN_CONTROLS_ENABLED;
    const requests = [];
    process.env.VOIX_BASE_URL = 'http://voix.example.test';
    const upstream = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      requests.push({ url: String(url), body: options.body });
      return new Response(JSON.stringify({ text: '', control: 'stop' }), { headers: { 'Content-Type': 'application/json' } });
    });
    try {
      for (const enabled of ['false', 'true']) {
        process.env.VOIX_SPOKEN_CONTROLS_ENABLED = enabled;
        const response = await request(app).post('/api/voix/transcribe')
          .set('Content-Type', 'audio/wav').send(Buffer.from('synthetic-audio')).expect(200);
        expect(response.body).toEqual({ text: '', control: 'stop' });
      }
      expect(requests.map(row => row.url)).toEqual(['http://voix.example.test/v1/audio/transcriptions',
        'http://voix.example.test/v1/audio/transcriptions/controls']);
      expect(requests.every(row => row.body.equals(Buffer.from('synthetic-audio')))).toBe(true);
    } finally {
      upstream.mockRestore();
      if (previousUrl === undefined) delete process.env.VOIX_BASE_URL; else process.env.VOIX_BASE_URL = previousUrl;
      if (previousControls === undefined) delete process.env.VOIX_SPOKEN_CONTROLS_ENABLED;
      else process.env.VOIX_SPOKEN_CONTROLS_ENABLED = previousControls;
    }
  });
  test('Secretary mail routes use the native owner and preserve errors', async () => {
    const previous = app.locals.aioOpsSecretaryMail;
    const handled = jest.fn(async input => ({ ...input, removed: true, verified: true }));
    try {
      app.locals.aioOpsSecretaryMail = { contractVersion: 1,
        threads: async label => ({ label, threads: [{ threadId: 'abcdef123456' }] }), handled };
      expect((await request(app).get('/api/secretary/mail?label=urgent').expect(200)).body.data.label).toBe('urgent');
      await request(app).post('/api/secretary/mail/handled').send({ threadId: 'abcdef123456', label: 'urgent', ignored: true }).expect(200);
      expect(handled).toHaveBeenCalledWith({ threadId: 'abcdef123456', label: 'urgent' });
      delete app.locals.aioOpsSecretaryMail;
      expect((await request(app).get('/api/secretary/mail?label=urgent').expect(503)).body.code).toBe('SECRETARY_MAIL_UNAVAILABLE');
    } finally { app.locals.aioOpsSecretaryMail = previous; }
  });
  test('the original of a personal photo goes to the image archive, never through Famille', async () => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const base = '/api/voice-personas/private/sessions';
    const id = (await request(app).post(base).send({ packId: 'personal_operator', scopeId: 'personal', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
    const attached = (await request(app).post(`${base}/${id}/attachments`).send({ name: 'photo.png', dataUrl: `data:image/png;base64,${png}` }).expect(201)).body.data.attachment;
    const original = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(3 * 1024 * 1024, 5)]);
    const post = () => request(app).post(`${base}/${id}/attachments/${attached.id}/original`)
      .set('Content-Type', 'image/jpeg').set('X-Original-Name', encodeURIComponent('IMG_0042.jpg')).send(original);
    const previous = process.env.IMAGE_ARCHIVE_DIR;
    delete process.env.IMAGE_ARCHIVE_DIR;
    expect((await post().expect(404)).body.message).toMatch(/archive/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'household-archive-'));
    process.env.IMAGE_ARCHIVE_DIR = dir;
    try {
      const archived = (await post().expect(201)).body.data.attachment;
      expect(archived).toMatchObject({ id: attached.id, original: { mimeType: 'image/jpeg', size: original.length } });
      const [year] = fs.readdirSync(path.join(dir, 'uploaded'));
      const [month] = fs.readdirSync(path.join(dir, 'uploaded', year));
      expect(fs.readdirSync(path.join(dir, 'uploaded', year, month)).sort()).toEqual([`${archived.original.sha256}.jpg`, `${archived.original.sha256}.json`]);
      await request(app).post(`/api/voice-personas/family/sessions/${id}/attachments/${attached.id}/original`).set('Content-Type', 'image/jpeg').send(original.subarray(0, 64)).expect(404);
    } finally {
      if (previous === undefined) delete process.env.IMAGE_ARCHIVE_DIR; else process.env.IMAGE_ARCHIVE_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  test('the latest Super Dad conversation is offered with its preview to any device (#120)', async () => {
    const base = '/api/voice-personas/private/sessions';
    const id = (await request(app).post(base).send({ packId: 'personal_operator', scopeId: 'personal', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Synthetic phone question about the garden' }).expect(200);
    // A second device holds no browser state: it only asks Core for the latest conversation.
    const [latest] = (await request(app).get(`${base}/recent?limit=1&preview=true`).expect(200)).body.data.sessions;
    expect(latest).toMatchObject({ sessionId: id, lastTurn: { inputPreview: 'Synthetic phone question about the garden' } });
    expect(Date.parse(latest.lastTurnAt)).toBeGreaterThan(Date.now() - 60_000);
    const history = (await request(app).get(`${base}/${id}/history`).expect(200)).body.data;
    expect(history.turns.at(-1).inputText).toBe('Synthetic phone question about the garden');
  });
  test('personal attachments survive HTTP resume and stay outside family and other conversations', async () => {
    const base = '/api/voice-personas/private/sessions';
    const create = async () => (await request(app).post(base).send({ packId: 'personal_operator', scopeId: 'personal', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    const id = await create(), other = await create();
    const payload = { name: 'synthetic.txt', dataUrl: `data:text/plain;base64,${Buffer.from('Observatoire bleu').toString('base64')}` };
    const attached = (await request(app).post(`${base}/${id}/attachments`).send(payload).expect(201)).body.data.attachment;
    const download = await request(app).get(`${base}/${id}/attachments/${attached.id}`).expect(200);
    expect(download.text).toBe('Observatoire bleu');
    expect(download.headers['cache-control']).toBe('private, no-store');
    await request(app).get(`${base}/${other}/attachments/${attached.id}`).expect(404);
    await request(app).post(`${base}/${other}/turns/text`).send({ text: 'Read', attachmentIds: [attached.id] }).expect(404);
    await request(app).get(`/api/voice-personas/family/sessions/${id}/attachments/${attached.id}`).expect(404);
    await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Lis mon document.', attachmentIds: [attached.id] }).expect(200);
    expect(executeForTest.mock.calls.at(-1)[0].messages.at(-1).content).toContain('Observatoire bleu');
    const resumed = (await request(app).get(`${base}/${id}/history`).expect(200)).body.data;
    expect(resumed.turns[0].attachments).toEqual([attached]);
    await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Quelle couleur?' }).expect(200);
    expect(executeForTest.mock.calls.at(-1)[0].messages.some(message => message.content.includes('Observatoire bleu'))).toBe(true);
    const family = (await request(app).post('/api/voice-personas/family/sessions').send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    await request(app).post(`/api/voice-personas/family/sessions/${family}/turns/text`).send({ text: 'Read', attachmentIds: [attached.id] }).expect(400);
    await request(app).post(`${base}/${family}/attachments`).send(payload).expect(404);
    const exported = (await request(app).get(`${base}/${id}/export`).expect(200)).body;
    expect(exported.schema).toBe('agentx.conversation-export/v1');
    expect(exported.conversation.messages[0].content).toBe('Lis mon document.');
    expect(exported.attachments).toEqual([expect.objectContaining({ id: attached.id, dataUrl: payload.dataUrl })]);
    await request(app).get(`${base}/${family}/export`).expect(404);
    await request(app).delete(`${base}/${id}`).send({}).expect(400);
    await request(app).delete(`${base}/${family}`).send({ confirmation: 'DELETE CONVERSATION' }).expect(404);
    await request(app).delete(`${base}/${id}`).send({ confirmation: 'DELETE CONVERSATION' }).expect(200);
    await request(app).delete(`${base}/${id}`).send({ confirmation: 'DELETE CONVERSATION' }).expect(200);
    await request(app).get(`${base}/${id}/history`).expect(404);
    await request(app).get(`${base}/${id}/attachments/${attached.id}`).expect(404);
    await request(app).get(`${base}/${id}/export`).expect(404);
    await request(app).post(`${base}/${id}/attachments`).send(payload).expect(404);
    const tombstone = await Conversation.findOne({ 'surfaceSession.sessionId': id }).lean();
    expect(tombstone.messages).toHaveLength(0);
    expect(tombstone.surfaceSession.deletedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(tombstone)).not.toContain('Observatoire');
    expect(await require('../../models/ConversationAttachment').countDocuments({ conversationId: tombstone._id })).toBe(0);
  });
  test('a parent erases a family conversation through its own scope only', async () => {
    const familyBase = '/api/voice-personas/family/sessions', privateBase = '/api/voice-personas/private/sessions';
    const family = (await request(app).post(familyBase).send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    const personal = (await request(app).post(privateBase).send({ packId: 'personal_operator', scopeId: 'personal', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    await request(app).post(`${familyBase}/${family}/turns/text`).send({ text: 'Synthetic family question about pancakes' }).expect(200);
    const confirmation = { confirmation: 'DELETE CONVERSATION' };
    await request(app).delete(`${familyBase}/${family}`).send({}).expect(400);
    // Each space erases only its own conversations.
    await request(app).delete(`${familyBase}/${personal}`).send(confirmation).expect(404);
    await request(app).delete(`${privateBase}/${family}`).send(confirmation).expect(404);
    await request(app).delete(`${familyBase}/${family}`).send(confirmation).expect(200);
    await request(app).get(`${familyBase}/${family}/history`).expect(404);
    const recent = (await request(app).get(`${familyBase}/recent?limit=5`).expect(200)).body.data.sessions;
    expect(recent.some(session => session.sessionId === family)).toBe(false);
    const tombstone = await Conversation.findOne({ 'surfaceSession.sessionId': family }).lean();
    expect(tombstone.messages).toHaveLength(0);
    expect(JSON.stringify(tombstone)).not.toContain('pancakes');
    await request(app).get(`${privateBase}/${personal}/history`).expect(200);
  });
  test('a parent pages through older family conversations with a before cursor', async () => {
    const familyBase = '/api/voice-personas/family/sessions';
    for (let index = 0; index < 7; index++) {
      const id = (await request(app).post(familyBase).send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
      await request(app).post(`${familyBase}/${id}/turns/text`).send({ text: `Synthetic page question ${index}` }).expect(200);
    }
    // Previews without narrowing: a family conversation with no persona must still be listed to be erased.
    const first = (await request(app).get(`${familyBase}/recent?limit=5&preview=true`).expect(200)).body.data.sessions;
    expect(first).toHaveLength(5);
    expect(first[0].lastTurn.inputPreview).toMatch(/^Synthetic page question/);
    const oldest = first.at(-1).lastTurnAt;
    const second = (await request(app).get(`${familyBase}/recent?limit=5&preview=true&before=${encodeURIComponent(oldest)}`).expect(200)).body.data.sessions;
    expect(second.length).toBeGreaterThanOrEqual(2);
    expect(second.some(session => first.some(seen => seen.sessionId === session.sessionId))).toBe(false);
    expect(second.every(session => new Date(session.lastTurnAt) < new Date(oldest))).toBe(true);
    // An unreadable cursor is ignored rather than hiding every conversation.
    expect((await request(app).get(`${familyBase}/recent?limit=5&before=not-a-date`).expect(200)).body.data.sessions).toHaveLength(5);
  });
  test('native voice replies use Core speech cleanup while canonical history keeps the original prose', async () => {
    const original = 'Bonjour 🦉. **Tout va bien.** 911 et 811 restent disponibles.';
    executeForTest.mockImplementationOnce(async () => ({ ok: true, body: { response: original }, metadata: { model: 'synthetic' } }));
    const base = '/api/voice-personas/private/sessions';
    const id = (await request(app).post(base).send({ packId: 'personal_operator', scopeId: 'personal', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    const response = await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Comment ça va?', channel: 'voice' }).expect(200);
    expect(response.body.data.reply.text).toBe('Bonjour . Tout va bien. 911 et 811 restent disponibles.');
    const record = await Conversation.findOne({ 'surfaceSession.sessionId': id }).lean();
    expect(record.messages.at(-1).content).toContain('🦉');
    expect(record.messages.at(-1).content).toContain('911 et 811');
  });
  test('a second LLMx opening request while the first is generating reports it pending', async () => {
    const base = '/api/consumers/nestor/v1/llmx';
    const id = (await request(app).post(`${base}/sessions`).send({ backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    let release;
    const calls = executeForTest.mock.calls.length;
    executeForTest.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ ok: true, body: { response: 'Hello, synthetic visitor.' }, metadata: { model: 'synthetic' } });
    }));
    const opening = { requestId: 'synthetic-pending-opening', openingVersion: 1, channel: 'text' };
    const first = request(app).post(`${base}/sessions/${id}/opening`).send(opening).then(response => response);
    for (let attempt = 0; attempt < 200 && executeForTest.mock.calls.length === calls; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(executeForTest.mock.calls.length).toBe(calls + 1);
    const pending = await request(app).post(`${base}/sessions/${id}/opening`).send(opening).expect(202);
    expect(pending.body.data.opening.status).toBe('pending');
    release();
    expect((await first).status).toBe(200);
  });

  test('LLMx opening and rejected scene result resume from the same canonical messages', async () => {
    const base = '/api/consumers/nestor/v1/llmx';
    const created = await request(app).post(`${base}/sessions`).send({ backend: 'agentx' }).expect(201);
    const id = created.body.data.session.sessionId;
    executeForTest.mockResolvedValueOnce({ ok: true, body: { response: 'Hello, synthetic visitor.' }, metadata: { model: 'synthetic' } });
    await request(app).post(`${base}/sessions/${id}/opening`).send({ requestId: 'synthetic-opening-1', openingVersion: 1, channel: 'text' }).expect(200);
    const calls = executeForTest.mock.calls.length;
    await request(app).post(`${base}/sessions/${id}/opening`).send({ requestId: 'synthetic-opening-1', openingVersion: 1, channel: 'text' }).expect(200);
    expect(executeForTest).toHaveBeenCalledTimes(calls);
    const sceneContext = { schemaVersion: 1, environment: { id: 'synthetic-world', name: 'Synthetic world' }, revision: '1',
      capabilities: { commandsVersion: 2 }, buildZone: { center: [0, 0, 0], radius: 4 }, entities: [{ id: 'box', type: 'box' }] };
    executeForTest.mockResolvedValueOnce({ ok: true, body: { response: JSON.stringify({ reply: 'Synthetic proposed scene.',
      scene: { schemaVersion: 1, intent: 'Move a synthetic box', commands: [{ op: 'update', id: 'box', patch: { transform: { position: [1, 1, 1] } } }] } }) }, metadata: { model: 'synthetic' } });
    const turnId = 'synthetic-scene-turn-1';
    await request(app).post(`${base}/sessions/${id}/turns/text`).send({ turnId, text: 'Move the box', sceneContext }).expect(200);
    const receipt = { turnId, status: 'rejected', entityIds: [], message: 'Synthetic browser rejection.' };
    await request(app).post(`${base}/sessions/${id}/scene-receipts`).send(receipt).expect(200);
    expect((await request(app).post(`${base}/sessions/${id}/scene-receipts`).send(receipt).expect(200)).body.data.duplicate).toBe(true);
    const history = await request(app).get(`${base}/sessions/${id}/history`).expect(200);
    expect(history.body.data.history).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Hello, synthetic visitor.' }),
      expect.objectContaining({ role: 'user', content: 'Move the box' }),
      expect.objectContaining({ role: 'assistant', content: 'Synthetic browser rejection.' })
    ]);
    expect(history.body.data.session.turnCount).toBe(2);
    expect(history.body.data.turns[1].sceneReceipt.status).toBe('rejected');
    await request(app).post(`${base}/sessions/${id}/turns/text`).send({ turnId, text: 'Move the box', sceneContext }).expect(409);
    await request(app).get(`${base}/family/sessions/${id}/history`).expect(404);
    const row = await Conversation.findOne({ 'surfaceSession.sessionId': id }).lean();
    expect(row.messages).toHaveLength(3);
    expect(row.messages.at(-1).content).toBe(receipt.message);
  });

  test('the shipped native OpenClaw adapter changes the same real Mongo note as Nestor UI', async () => {
    const server = createServer(app);
    const address = await listenLoopback(server);
    try {
      const adapterUrl = pathToFileURL(path.resolve(__dirname, '../../../integrations/openclaw/super-dad-memory/core-notes.js')).href;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        const { createCoreNotesClient } = await import(process.argv[2]);
        const client = createCoreNotesClient({ baseUrl: process.argv[1] });
        const note = await client({ action: 'remember', text: 'Synthetic native adapter note' });
        const corrected = await client({ action: 'remember', id: note.id, text: 'Synthetic corrected native note' });
        console.log(JSON.stringify(corrected));
      `, `http://127.0.0.1:${address.port}`, adapterUrl], { windowsHide: true, timeout: 15000 });
      const note = JSON.parse(stdout);
      expect(note.authority).toBe('agentx.core');
      const listed = await request(app).post('/api/voice-personas/private/notes').send({ operation: 'list' }).expect(200);
      expect(listed.body.data.notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: note.id, text: 'Synthetic corrected native note' })
      ]));
      await request(app).post('/api/voice-personas/private/notes').send({ operation: 'forget', id: note.id }).expect(200);
    } finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    }
  });

  test('Core and Nestor UI share notes without an OpenClaw dependency', async () => {
    const base = '/api/voice-personas';
    const created = await request(app).post(`${base}/private/notes`).send({ operation: 'remember',
      text: 'Synthetic observatory preference', kind: 'preference' }).expect(200);
    const id = created.body.data.id;
    expect(created.body.data.authority).toBe('agentx.core');
    const native = await request(app).post('/api/consumers/nestor/v1/memory/notes').send({ action: 'search', query: 'observatory' }).expect(200);
    expect(native.body.data.notes).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    const journal = '/api/consumers/nestor/v1/mail-journal';
    const filed = await request(app).post(journal).send({ action: 'record', threadId: 'synthetic-thread',
      occurredAt: new Date().toISOString(), summary: 'Synthetic observatory newsletter arrived' }).expect(200);
    expect(filed.body.data).toMatchObject({ authority: 'agentx.core', action: 'record', recorded: true });
    const recalled = await request(app).post(journal).send({ action: 'search', query: 'observatory' }).expect(200);
    expect(recalled.body.data.entries.map(entry => entry.threadId)).toEqual(['synthetic-thread']);
    // Mail digests never surface as memory notes.
    const notesAfter = await request(app).post('/api/consumers/nestor/v1/memory/notes').send({ action: 'search', query: 'newsletter' }).expect(200);
    expect(notesAfter.body.data.notes).toEqual([]);
    await request(app).post(journal).send({ action: 'delete' }).expect(400);
    const session = await request(app).post(`${base}/private/sessions`).send({ packId: 'personal_operator', backend: 'agentx' }).expect(201);
    // Selected context travels in the final user message; the system message is the same on every turn (#261).
    const sentMessages = () => executeForTest.mock.calls.at(-1)[0].messages;
    const selected = () => sentMessages().at(-1).content, wholePrompt = () => sentMessages().map(message => message.content).join('\n');
    await request(app).post(`${base}/private/sessions/${session.body.data.session.sessionId}/turns/text`).send({ text: 'observatory' }).expect(200);
    expect(selected()).toContain('Synthetic observatory preference');
    const personalSystem = sentMessages()[0].content;
    expect(personalSystem).not.toContain('Synthetic observatory preference');
    const family = await request(app).post(`${base}/sessions`).send({ packId: 'kidx_nestor', backend: 'agentx' }).expect(201);
    await request(app).post(`${base}/sessions/${family.body.data.session.sessionId}/turns/text`).send({ text: 'observatory' }).expect(200);
    expect(wholePrompt()).not.toContain('Synthetic observatory preference');
    const HouseholdProfile = require('../../models/HouseholdProfile');
    await HouseholdProfile.create([{ profileId: 'synthetic-a', displayName: 'Synthetic Alex', ageBand: 'school' },
      { profileId: 'synthetic-b', displayName: 'Synthetic Sam', ageBand: 'little' }]);
    try {
      await request(app).post(`${base}/private/sessions/${session.body.data.session.sessionId}/turns/text`).send({ text: 'Comment s’appellent mes enfants?' }).expect(200);
      const personal = selected();
      expect(personal).toContain('Synthetic Alex (âge scolaire)');
      expect(personal).toContain('Synthetic Sam (petite enfance)');
      expect(sentMessages()[0].content).toContain(KNOWN_UNKNOWN);
      expect(sentMessages()[0].content).toBe(personalSystem);
      await request(app).post(`${base}/sessions/${family.body.data.session.sessionId}/turns/text`).send({ text: 'Comment s’appellent les enfants?' }).expect(200);
      expect(wholePrompt()).not.toContain('Enfants de la maison');
      expect(wholePrompt()).not.toContain(KNOWN_UNKNOWN);
      // A parent-set birth date gives Super Dad the age and birthday; Famille and child projections keep the band only.
      const set = await request(app).post('/api/family/profiles/birth-date').send({ profileId: 'synthetic-a', birthDate: '2016-03-14' }).expect(200);
      expect(set.body.data.profile.birthDate).toBe('2016-03-14');
      expect((await request(app).post('/api/family/profiles/birth-date').send({ profileId: 'synthetic-a', birthDate: '2016-02-30' }).expect(400)).body.code)
        .toBe('FAMILY_PROFILE_BAD_BIRTH_DATE');
      const details = (await request(app).get('/api/family/profiles/details').expect(200)).body.data.profiles;
      expect(details.find(profile => profile.id === 'synthetic-a').birthDate).toBe('2016-03-14');
      const childProfiles = (await request(app).get('/api/family/profiles').expect(200)).body.data.profiles;
      expect(JSON.stringify(childProfiles)).not.toMatch(/birthDate|2016-03-14/);
      expect(JSON.stringify((await request(app).get('/api/family/room?profileId=synthetic-a').expect(200)).body.data)).not.toMatch(/birthDate|2016/);
      const age = ageInYears('2016-03-14', instanceToday());
      await request(app).post(`${base}/private/sessions/${session.body.data.session.sessionId}/turns/text`).send({ text: 'Quel âge a Synthetic Alex?' }).expect(200);
      const aged = wholePrompt();
      expect(aged).toContain(`Synthetic Alex (${age} ans, anniversaire le 14 mars)`);
      expect(aged).not.toContain('2016');
      await request(app).post(`${base}/sessions/${family.body.data.session.sessionId}/turns/text`).send({ text: 'Quel âge a Synthetic Alex?' }).expect(200);
      const familyPrompt = wholePrompt();
      expect(familyPrompt).not.toContain('anniversaire le 14 mars');
      expect(familyPrompt).not.toContain('2016');
      await request(app).post('/api/family/profiles/birth-date').send({ profileId: 'synthetic-a', birthDate: null }).expect(200);
      await request(app).post(`${base}/private/sessions/${session.body.data.session.sessionId}/turns/text`).send({ text: 'Quel âge a Synthetic Alex?' }).expect(200);
      expect(selected()).toContain('Synthetic Alex (âge scolaire)');
      expect(sentMessages()[0].content).toBe(personalSystem);
    } finally { await HouseholdProfile.deleteMany({ profileId: { $in: ['synthetic-a', 'synthetic-b'] } }); }
    await request(app).post(`${base}/private/notes`).send({ operation: 'forget', id }).expect(200);
    expect((await request(app).post(`${base}/private/notes`).send({ operation: 'list' })).body.data.notes.some(note => note.id === id)).toBe(false);
  });

  test('Nestor keeps one shopping list through MCP', async () => {
    const call = (id, args) => request(app).post('/mcp').send({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'shopping_list', arguments: args } }).expect(200);
    const tools = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(200);
    expect(tools.body.result.tools.map(tool => tool.name)).toContain('shopping_list');
    await call(2, { action: 'add', items: ['Synthetic avocado', 'Synthetic lime'] });
    await call(3, { action: 'add', items: ['synthetic avocado'] });
    const listed = await call(4, { action: 'list' });
    expect(listed.body.result.structuredContent.items).toEqual(['Synthetic avocado', 'Synthetic lime']);
    const refused = await call(5, { action: 'add', items: [] });
    expect(refused.body.result.isError).toBe(true);
    // The desk and the Kids Room share the same list over HTTP.
    await request(app).post('/api/family/shopping/add').send({ items: ['Synthetic bread'] }).expect(200);
    const bought = await request(app).post('/api/family/shopping/bought').send({ items: ['synthetic lime'] }).expect(200);
    expect(bought.body.data.items).toEqual(['Synthetic avocado', 'Synthetic bread']);
    await request(app).post('/api/family/shopping/add').send({ items: [] }).expect(400);
  });

  test('HTTP and MCP share personal tasks, while family approval uses the same canonical store', async () => {
    const created = await request(app).post('/api/secretary/tasks').send({ title: 'Synthetic personal task' }).expect(201);
    const task = created.body.data.task;
    const listed = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_personal_tasks', arguments: {} } }).expect(200);
    expect(listed.body.result.structuredContent.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id })]));
    // Weekdays come from the server in the household zone, never from the model (#43):
    // 02:30Z on the 25th is still Thursday the 24th in America/Toronto.
    await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'update_personal_task', arguments: { ref: task.id, dueAt: '2026-09-25T02:30:00.000Z' } } }).expect(200);
    const dated = (await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'list_personal_tasks', arguments: {} } }).expect(200)).body.result.structuredContent;
    expect(dated.tasks.find(item => item.id === task.id)).toMatchObject({ dueLocal: 'jeudi 24 septembre', relevantUntilLocal: null });
    expect(dated.todayLocal).toMatch(/^[a-zé]+ \d{1,2} [a-zéû]+$/);
    const updated = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'update_personal_task', arguments: { ref: task.id, relevantUntil: '2020-01-01' } } }).expect(200);
    expect(updated.body.result.structuredContent).toMatchObject({ id: task.id, lane: 'expired' });
    const briefed = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'personal_briefing', arguments: {} } }).expect(200);
    expect(briefed.body.result.structuredContent.text).toContain('Activité passée : 1 tâche à fermer');
    await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'complete_personal_task', arguments: { ref: task.id } } }).expect(200);
    expect((await PipelineTask.findOne({ pipelineId: task.id })).status).toBe('done');

    const launched = await request(app).post('/api/family/launch').send({
      profile: { profileId: 'synthetic-child', displayName: 'Example child' },
      routines: [{ title: 'Synthetic family task' }]
    }).expect(201);
    const chore = launched.body.data.routines[0];
    expect(Number(chore.id)).toBe(Number(task.id) + 1);
    await request(app).post('/api/secretary/tasks/complete').send({ ref: chore.id }).expect(404);
    await request(app).post('/api/family/chores/check-in').send({ ref: chore.id, profileId: 'synthetic-child' }).expect(200);
    expect((await PipelineTask.findOne({ pipelineId: chore.id })).status).toBe('review');
    await request(app).post('/api/family/chores/approve').send({ ref: chore.id }).expect(200);
    expect((await PipelineTask.findOne({ pipelineId: chore.id })).status).toBe('done');
  });

  test('a date-only deadline stays on its household day through HTTP and MCP (#287)', async () => {
    const previousZone = process.env.PLANNING_TIME_ZONE;
    process.env.PLANNING_TIME_ZONE = 'America/Toronto';
    const mcp = (id, name, args) => request(app).post('/mcp').send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }).expect(200);
    const createdIds = [];
    try {
      // Date-only create through HTTP: stored as the end of the household day,
      // not midnight of the UTC day.
      const created = await request(app).post('/api/secretary/tasks').send({ title: 'Synthetic date-only', dueAt: '2026-10-04' }).expect(201);
      const httpTask = created.body.data.task;
      createdIds.push(httpTask.id);
      expect(httpTask.dueAt).toBe('2026-10-05T03:59:59.999Z'); // 23:59:59.999 EDT.
      // Date-only create through MCP: the same instant, with the local weekday.
      const mcpCreated = await mcp(1, 'add_personal_task', { title: 'Synthetic mcp date-only', dueAt: '2026-10-04' });
      const mcpTaskId = mcpCreated.body.result.structuredContent.id;
      createdIds.push(mcpTaskId);
      expect(mcpCreated.body.result.structuredContent.dueAt).toBe('2026-10-05T03:59:59.999Z');
      const listed = (await mcp(2, 'list_personal_tasks', { limit: 100 })).body.result.structuredContent;
      const mcpRow = listed.tasks.find(item => item.id === mcpTaskId);
      expect(mcpRow.dueLocal).toBe('dimanche 4 octobre');
      // Date-only update through HTTP moves the same task to another household day.
      const updated = await request(app).post('/api/secretary/tasks/update').send({ ref: httpTask.id, dueAt: '2026-11-01' }).expect(200);
      expect(updated.body.data.task.dueAt).toBe('2026-11-02T04:59:59.999Z'); // 23:59:59.999 EST.
      // Date-only update through MCP lands on the spring-forward boundary day.
      const mcpUpdated = await mcp(3, 'update_personal_task', { ref: mcpTaskId, dueAt: '2026-03-08' });
      expect(mcpUpdated.body.result.structuredContent.dueAt).toBe('2026-03-09T03:59:59.999Z');
      // A full ISO datetime with an explicit offset keeps its exact instant.
      const offsetTask = (await request(app).post('/api/secretary/tasks').send({ title: 'Synthetic offset', dueAt: '2026-10-03T23:59:00-04:00' }).expect(201)).body.data.task;
      createdIds.push(offsetTask.id);
      expect(offsetTask.dueAt).toBe('2026-10-04T03:59:00.000Z');
      const offsetMcp = await mcp(4, 'update_personal_task', { ref: offsetTask.id, dueAt: '2026-10-04T05:00:00.000Z' });
      expect(offsetMcp.body.result.structuredContent.dueAt).toBe('2026-10-04T05:00:00.000Z');
      // An invalid date-only deadline is rejected on both paths, never stored.
      const badHttp = await request(app).post('/api/secretary/tasks').send({ title: 'Synthetic bad date', dueAt: '2026-13-40' }).expect(400);
      expect(badHttp.body.code).toBe('SECRETARY_BAD_DUE_DATE');
      const badMcp = await mcp(5, 'add_personal_task', { title: 'Synthetic bad date mcp', dueAt: '2026-13-40' });
      expect(badMcp.body.result.isError).toBe(true);
      expect(badMcp.body.result.structuredContent.error).toBe('SECRETARY_BAD_DUE_DATE');
      const badUpdate = await request(app).post('/api/secretary/tasks/update').send({ ref: httpTask.id, dueAt: 'soon' }).expect(400);
      expect(badUpdate.body.code).toBe('SECRETARY_BAD_DUE_DATE');
      // The date-only deadline still projects onto its own household day in the list.
      const relisted = (await mcp(6, 'list_personal_tasks', { limit: 100 })).body.result.structuredContent;
      expect(relisted.tasks.find(item => item.id === httpTask.id).dueLocal).toBe('dimanche 1 novembre');
    } finally {
      if (previousZone === undefined) delete process.env.PLANNING_TIME_ZONE;
      else process.env.PLANNING_TIME_ZONE = previousZone;
      await PipelineTask.deleteMany({ pipelineId: { $in: createdIds } });
    }
  });

  test('a completed native stream with open HTTP persists its answer and permits a same-session follow-up', async () => {
    const { createAgentClient } = jest.requireActual('../../surfaces/household/conversation-agent');
    const runIds = ['resp_22222222-2222-4222-8222-222222222222', 'resp_33333333-3333-4333-8333-333333333333'];
    const replies = ['Une tâche reçue.', 'Dans la même conversation.'];
    const requests = [], releases = [];
    const row = data => Buffer.from('data: ' + JSON.stringify(data) + '\n\n');
    const native = createAgentClient({
      env: { OPENCLAW_GATEWAY_URL: 'http://openclaw.example.test', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token' },
      settleMs: 0, progressMs: 25, streamGraceMs: 5, streamDrainMs: 20,
      continuity: async ({ runId }) => ({
        answer: { status: 'ready', runId, text: replies[runIds.indexOf(runId)] },
        run: { runId, model: 'synthetic-native' }, receipts: [{ runId, tool: 'list_personal_tasks', status: 'verified', observed: true }]
      }),
      fetchImpl: async (_url, options) => {
        const runId = runIds[requests.length];
        requests.push(JSON.parse(options.body));
        return { ok: true, body: (async function* () {
          yield row({ type: 'response.created', response: { id: runId } });
          yield row({ type: 'response.completed', response: { id: runId } });
          await new Promise(resolve => {
            releases.push(resolve);
            options.signal.addEventListener('abort', resolve, { once: true });
          });
        })() };
      }
    });
    agentForTest.mockImplementationOnce(native).mockImplementationOnce(native);
    try {
      const base = '/api/voice-personas/private/sessions';
      const id = (await request(app).post(base).send({ packId: 'personal_operator', backend: 'openclaw' }).expect(201)).body.data.session.sessionId;
      const first = (await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Regarde mes tâches.' }).expect(200)).body.data;
      expect(first.reply.text).toBe(replies[0]);
      expect(first.tools.receipts).toEqual([{ runId: runIds[0], tool: 'list_personal_tasks', status: 'verified', observed: true }]);
      const history = (await request(app).get(`${base}/${id}/history`).expect(200)).body.data;
      expect(history.history.map(message => message.content)).toEqual(['Regarde mes tâches.', replies[0]]);
      expect(requests).toHaveLength(1);
      await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Et ensuite ?' }).expect(200);
      const resumed = (await request(app).get(`${base}/${id}/history`).expect(200)).body.data;
      expect(resumed.session.turnCount).toBe(2);
      expect(resumed.history.map(message => message.content)).toEqual(['Regarde mes tâches.', replies[0], 'Et ensuite ?', replies[1]]);
      expect(requests).toHaveLength(2);
      expect(requests[1].input).toHaveLength(1);
    } finally { releases.forEach(release => release()); }
  });

  test('a previously observed answer persists through HTTP when the final native observation fails', async () => {
    const { createAgentClient } = jest.requireActual('../../surfaces/household/conversation-agent');
    const runId = 'resp_44444444-4444-4444-8444-444444444444';
    const reply = 'Trois tâches reçues.';
    let reads = 0, requests = 0, release;
    const native = createAgentClient({
      env: { OPENCLAW_GATEWAY_URL: 'http://openclaw.example.test', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token' },
      settleMs: 0, progressMs: 5, streamGraceMs: 20, streamDrainMs: 20,
      continuity: async () => {
        if (++reads > 1) throw new Error('Synthetic continuity unavailable');
        return { answer: { status: 'ready', runId, text: reply },
          run: { runId, model: 'old-attempt', provider: 'old-provider' },
          receipts: [{ tool: 'list_personal_tasks', observed: true }] };
      },
      fetchImpl: async (_url, options) => {
        requests++;
        return { ok: true, body: (async function* () {
          yield Buffer.from('data: ' + JSON.stringify({ type: 'response.created', response: { id: runId } }) + '\n\n');
          await new Promise(resolve => { release = resolve; options.signal.addEventListener('abort', resolve, { once: true }); });
        })() };
      }
    });
    agentForTest.mockImplementationOnce(native);
    try {
      const base = '/api/voice-personas/private/sessions';
      const id = (await request(app).post(base).send({ packId: 'personal_operator', backend: 'openclaw' }).expect(201)).body.data.session.sessionId;
      const turn = (await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Regarde mes tâches.' }).expect(200)).body.data;
      expect(turn.reply.text).toBe(reply);
      expect(turn.tools).toMatchObject({ status: 'unavailable', run: null, receipts: [] });
      expect(turn.model).toEqual({ model: '', hostKey: '' });
      const canonical = await Conversation.findOne({ 'surfaceSession.sessionId': id }).lean();
      expect(canonical.messages[1].turn.model).toBe('');
      const history = (await request(app).get(`${base}/${id}/history`).expect(200)).body.data;
      expect(history.history.map(message => message.content)).toEqual(['Regarde mes tâches.', reply]);
      expect(history.session.turnCount).toBe(1);
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(requests).toBe(1);
    } finally { release?.(); }
  });

  test('persists and resumes a personal conversation without exposing it through child routes', async () => {
    const base = '/api/voice-personas';
    const created = await request(app).post(`${base}/private/sessions`).send({
      packId: 'personal_operator', backend: 'agentx', label: 'Synthetic private conversation'
    }).expect(201);
    const id = created.body.data.session.sessionId;
    const turn = await request(app).post(`${base}/private/sessions/${id}/turns/text`).send({ text: 'Synthetic private input' }).expect(200);
    expect(turn.body.data.reply.text).toBe('Synthetic response');
    expect(turn.body.data.speaker).toMatchObject({ agentId: 'main', personaId: 'nestor', personaVersion: 1, name: 'Nestor · Majordome' });
    expect(turn.body.data.reply.speaker).toEqual(turn.body.data.speaker);
    expect(turn.body.data.tools.status).toBe('not_supported');
    const canonical = await Conversation.findOne({ 'surfaceSession.sessionId': id }).lean();
    expect(canonical.messages.map(message => message.content)).toEqual(['Synthetic private input', 'Synthetic response']);
    expect(canonical.surfaceSession.turnCount).toBe(1);
    expect(canonical.messages[1].turn.speaker).toEqual(turn.body.data.speaker);
    expect(canonical.messages[1].turn.performedBy).toEqual([{ agentId: 'main', runId: null }]);
    expect(canonical.messages[1].turn.voice).toEqual({ provider: turn.body.data.reply.speech.provider, voice: turn.body.data.reply.speech.voice });
    await request(app).get(`/api/history/${canonical._id}`).expect(404);
    const history = await request(app).get(`${base}/private/sessions/${id}/history`).expect(200);
    expect(history.body.data.policy.historyAuthority).toBe('agentx.core.conversations');
    expect(history.body.data.turns[0]).toMatchObject({ speaker: turn.body.data.speaker,
      performedBy: [{ agentId: 'main', runId: null }], voice: canonical.messages[1].turn.voice });
    expect(history.body.data.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'Synthetic private input' }),
      expect.objectContaining({ role: 'assistant', content: 'Synthetic response' })
    ]));
    const recent = await request(app).get(`${base}/private/sessions/recent`).expect(200);
    expect(recent.body.data.sessions.some(session => session.sessionId === id)).toBe(true);
    await request(app).post(`${base}/private/sessions/${id}/turns/text`).send({ text: 'Synthetic follow-up' }).expect(200);
    expect(executeForTest.mock.calls.at(-1)[0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'Synthetic private input' })
    ]));
    const calls = executeForTest.mock.calls.length;
    await request(app).get(`${base}/family/sessions/${id}/history`).expect(404);
    await request(app).post(`${base}/sessions/${id}/turns/text`).send({ text: 'Synthetic child attempt' }).expect(403);
    await request(app).post(`${base}/sessions`).send({ packId: 'personal_operator' }).expect(403);
    expect(executeForTest).toHaveBeenCalledTimes(calls);
  });

  test('family Nestor reads the Kids Room routines and keeps a child idea for the parent (#41, #13)', async () => {
    await request(app).post('/api/family/launch').send({
      profile: { profileId: 'idea-child', displayName: 'Synthetic idea child' },
      routines: [{ title: 'Synthetic feed the fish', cadence: 'daily' }]
    }).expect(201);
    await request(app).post('/api/secretary/tasks').send({ title: 'Synthetic adult-only errand' });
    const base = '/api/voice-personas/family/sessions';
    const id = (await request(app).post(base).send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    await request(app).post(`${base}/${id}/turns/text`).send({ text: "Qu'est-ce que je dois faire aujourd'hui?" }).expect(200);
    const prompt = executeForTest.mock.calls.at(-1)[0].messages.map(message => message.content).join('\n');
    expect(prompt).toContain('Synthetic idea child : à faire : Synthetic feed the fish');
    expect(prompt).not.toContain('Synthetic adult-only errand');
    expect(prompt).not.toContain('has been saved for Dad');
    // Routines and the capture receipt are this turn's reference data; the family system message never changes (#261).
    const familySystem = executeForTest.mock.calls.at(-1)[0].messages[0].content;
    expect(familySystem).not.toContain('Synthetic feed the fish');
    expect(executeForTest.mock.calls.at(-1)[0].messages.at(-1).content).toContain('Synthetic idea child : à faire : Synthetic feed the fish');

    const personalBefore = await PipelineTask.countDocuments({ service: 'personal' });
    await request(app).post(`${base}/${id}/turns/text`).send({ text: "J'ai une idée : une cabane dans l'arbre" }).expect(200);
    expect(executeForTest.mock.calls.at(-1)[0].messages.at(-1).content).toContain('an idea and it has been saved for Dad to review');
    expect(executeForTest.mock.calls.at(-1)[0].messages[0].content).toBe(familySystem);
    const idea = await PlanningItem.findOne({ type: 'idea', tags: 'origin:family' }).lean();
    expect(idea).toMatchObject({ status: 'inbox', summary: "J'ai une idée : une cabane dans l'arbre" });
    expect(idea.tags).toEqual(expect.arrayContaining(['origin:family', 'kind:idea']));
    expect(await PipelineTask.countDocuments({ service: 'personal' })).toBe(personalBefore);

    const listed = (await request(app).get('/api/family/ideas').expect(200)).body.data.ideas;
    expect(listed.find(entry => entry.id === String(idea._id))).toMatchObject({ origin: 'family', kind: 'idea', status: 'inbox' });
    const promoted = (await request(app).post(`/api/family/ideas/${idea._id}/promote`).send({ targetType: 'personal' }).expect(201)).body.data;
    expect(await PipelineTask.findOne({ pipelineId: promoted.task.pipelineId }).lean()).toMatchObject({ service: 'personal', source: 'planning-idea' });
    expect((await request(app).post(`/api/family/ideas/${idea._id}/promote`).send({ targetType: 'personal' }).expect(409)).body.code).toBe('IDEA_ALREADY_REVIEWED');
    expect((await PlanningItem.findById(idea._id).lean()).promotedTask).toEqual({ kind: 'personal', pipelineId: promoted.task.pipelineId });
  });

  test('a current finding from the archive catch-up lands once in the idea inbox for Dad (#130)', async () => {
    const finding = { kind: 'action', text: 'Synthetic: return the signed form', due: '2026-10-09',
      gmailUrl: 'https://mail.google.com/mail/u/0/#all/abcdef1234567890', key: 'a'.repeat(32) };
    const first = await request(app).post('/api/secretary/catchup/proposals').send(finding).expect(201);
    expect(first.body.data.idea).toMatchObject({ origin: 'secretary', kind: 'reminder', status: 'inbox' });
    expect(first.body.data.idea.text).toBe('Action : Synthetic: return the signed form (échéance : 2026-10-09) — https://mail.google.com/mail/u/0/#all/abcdef1234567890');
    const again = await request(app).post('/api/secretary/catchup/proposals').send(finding).expect(200);
    expect(again.body.data).toMatchObject({ duplicate: true, idea: { id: first.body.data.idea.id } });
    expect(await PlanningItem.countDocuments({ type: 'idea', tags: `source:catchup-${'a'.repeat(32)}` })).toBe(1);
    const fact = await request(app).post('/api/secretary/catchup/proposals')
      .send({ kind: 'memory', text: 'Synthetic dated fact', key: 'b'.repeat(32), gmailUrl: 'javascript:alert(1)' }).expect(201);
    expect(fact.body.data.idea).toMatchObject({ kind: 'idea', text: 'À retenir : Synthetic dated fact' });
    expect(fact.body.data.idea.memory).toBe(true);
    expect((await request(app).post(`/api/family/ideas/${first.body.data.idea.id}/promote`).send({ targetType: 'memory' }).expect(400)).body.code).toBe('IDEA_NOT_A_FACT');
    const remembered = (await request(app).post(`/api/family/ideas/${fact.body.data.idea.id}/promote`).send({ targetType: 'memory' }).expect(201)).body.data;
    expect(remembered.idea).toMatchObject({ status: 'promoted', promotedTask: { kind: 'memory' } });
    const notes = (await request(app).post('/api/voice-personas/private/notes').send({ operation: 'list' }).expect(200)).body.data.notes;
    expect(notes.map(note => note.text)).toContain('Synthetic dated fact');
    expect((await request(app).post('/api/secretary/catchup/proposals').send({ ...finding, kind: 'send' }).expect(400)).body.code).toBe('CATCHUP_PROPOSAL_BAD_KIND');
    expect((await request(app).post('/api/secretary/catchup/proposals').send({ ...finding, key: 'x' }).expect(400)).body.code).toBe('CATCHUP_PROPOSAL_BAD_KEY');
  });

  test('a family math question streams its picture first and Nestor answers without waiting for inference (#131)', async () => {
    const base = '/api/voice-personas/family/sessions';
    const id = (await request(app).post(base).send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    const ndjson = (res, done) => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => done(null, text)); };
    const inferencesBefore = executeForTest.mock.calls.length;
    const streamed = await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Nestor, combien font 8 + 5 ?', stream: true })
      .buffer(true).parse(ndjson).expect(200);
    const events = streamed.body.split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(events[0]).toEqual({ type: 'scene', scene: { schema: 'agentx.math-scene.v1', kind: 'add', a: 8, b: 5 } });
    expect(events.at(-1).type).toBe('done');
    expect(events.at(-1).data.reply.text).toBe('8 plus 5, ça fait 13 ! Regarde : 2 cubes orange complètent la dizaine, et il en reste 3.');
    expect(events.at(-1).data.reply.language).toBe('fr');
    expect(events.at(-1).data.routing.tier).toBe('deterministic');
    expect(executeForTest.mock.calls.length).toBe(inferencesBefore);

    const plain = await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Raconte une histoire', stream: true })
      .buffer(true).parse(ndjson).expect(200);
    expect(plain.body).not.toContain('"type":"scene"');

    // The mask's receipt is kept once on that turn; the picture is recomputed from the recorded question.
    const traceId = events.at(-1).data.traceId;
    const receipt = (await request(app).post('/api/family/math-receipts').send({ sessionId: id, traceId, status: 'applied' }).expect(200)).body.data;
    expect(receipt).toMatchObject({ duplicate: false, receipt: { schema: 'agentx.math-scene.v1', kind: 'add', a: 8, b: 5, status: 'applied' } });
    expect((await request(app).post('/api/family/math-receipts').send({ sessionId: id, traceId, status: 'applied' }).expect(200)).body.data.duplicate).toBe(true);
    expect((await request(app).post('/api/family/math-receipts').send({ sessionId: id, traceId, status: 'rejected', reason: 'no-face' }).expect(409)).body.code).toBe('MATH_RECEIPT_CONFLICT');
    const plainTrace = plain.body.split('\n').filter(Boolean).map(line => JSON.parse(line)).at(-1).data.traceId;
    expect((await request(app).post('/api/family/math-receipts').send({ sessionId: id, traceId: plainTrace, status: 'applied' }).expect(409)).body.code).toBe('MATH_RECEIPT_NO_PICTURE');
    expect((await request(app).post('/api/family/math-receipts').send({ sessionId: id, traceId, status: 'shown' }).expect(400)).body.code).toBe('MATH_RECEIPT_INVALID');
    // The parent journal sees which picture was drawn on the child's screen (#168).
    const journal = (await request(app).get('/api/voice-personas/audit/recent?childSafe=true&limit=10').expect(200)).body.data.audit;
    expect(journal.find(row => row.traceId === traceId).sceneReceipt).toMatchObject({ kind: 'add', a: 8, b: 5, status: 'applied' });
  });

  test('the family lane runs new Family conversations on Core inference with their Core features; spoken turns use the voice task (#261)', async () => {
    const names = ['HOUSEHOLD_FAMILY_CONVERSATION_BACKEND', 'HOUSEHOLD_VOICE_TASK', 'OPENCLAW_GATEWAY_URL', 'OPENCLAW_GATEWAY_TOKEN'];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { OPENCLAW_GATEWAY_URL: 'http://openclaw.example.test', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token' });
    const originalFetch = global.fetch;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      if (!String(url).startsWith('http://openclaw.example.test/')) return originalFetch(url, options);
      return new Response(JSON.stringify({ ok: true, authority: 'openclaw.nestor', operation: 'agents',
        agents: [{ id: 'main', name: 'Main' }, { id: 'family', name: 'Family' }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    const base = '/api/voice-personas/sessions', family = { packId: 'kidx_nestor', modeId: 'family', scopeId: 'family' };
    const create = async (path, body) => (await request(app).post(path).send(body).expect(201)).body.data.session;
    const ndjson = (res, done) => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => done(null, text)); };
    const lastInference = () => executeForTest.mock.calls.at(-1)[0];
    try {
      // Unset: the general engine, as before.
      const native = await create(base, family);
      expect(native.backend).toBe('openclaw');
      process.env.HOUSEHOLD_FAMILY_CONVERSATION_BACKEND = 'agentx';
      // New family conversations take the lane, whatever the page asked for; Super Dad does not.
      const direct = await create(base, { ...family, backend: 'openclaw' });
      expect(direct).toMatchObject({ backend: 'agentx', agentId: 'family' });
      expect((await create(base, { packId: 'kidx_reader' })).backend).toBe('agentx');
      expect((await create('/api/voice-personas/family/sessions', family)).backend).toBe('agentx');
      expect((await create('/api/voice-personas/private/sessions', { packId: 'personal_operator', scopeId: 'personal' })).backend).toBe('openclaw');

      // A conversation that already exists keeps its backend: no turn is replayed on the other one.
      const nativeRuns = agentForTest.mock.calls.length;
      let inferences = executeForTest.mock.calls.length;
      await request(app).post(`${base}/${native.sessionId}/turns/text`).send({ text: 'Raconte une histoire', channel: 'voice' }).expect(200);
      expect(agentForTest.mock.calls.length).toBe(nativeRuns + 1);
      expect(executeForTest.mock.calls.length).toBe(inferences);

      const turn = body => request(app).post(`${base}/${direct.sessionId}/turns/text`).send(body);
      const spoken = await turn({ text: 'Pourquoi le ciel est bleu?', channel: 'voice', stream: true }).buffer(true).parse(ndjson).expect(200);
      expect(lastInference()).toMatchObject({ taskType: 'voice_persona_chat', think: false, stream: true, callerDetail: 'agentx-household/kidx_nestor/family' });
      expect(spoken.body.split('\n').filter(Boolean).map(line => JSON.parse(line)).at(-1).data)
        .toMatchObject({ routing: { tier: 'router' }, tools: { status: 'not_supported' }, session: { backend: 'agentx' } });
      await turn({ text: 'Pourquoi la mer est salée?' }).expect(200);
      expect(lastInference()).toMatchObject({ taskType: 'nestor_answer_light', think: false, stream: false });
      process.env.HOUSEHOLD_VOICE_TASK = 'quick_chat';
      await turn({ text: 'Et la pluie?', channel: 'voice' }).expect(200);
      expect(lastInference().taskType).toBe('quick_chat');
      delete process.env.HOUSEHOLD_VOICE_TASK;

      // Core owns the family features, so they work without the native agent: routines, idea and
      // reminder capture, the math picture and animal sounds.
      await request(app).post('/api/family/launch').send({ profile: { profileId: 'lane-child', displayName: 'Synthetic lane child' },
        routines: [{ title: 'Synthetic water the plant', cadence: 'daily' }] }).expect(201);
      await turn({ text: "Qu'est-ce que je dois faire aujourd'hui?", channel: 'voice' }).expect(200);
      expect(lastInference().messages.at(-1).content).toContain('Synthetic lane child : à faire : Synthetic water the plant');
      await turn({ text: "J'ai une idée : un potager sur le balcon", channel: 'voice' }).expect(200);
      expect(lastInference().messages.at(-1).content).toContain('an idea and it has been saved for Dad to review');
      expect((await PlanningItem.findOne({ type: 'idea', summary: "J'ai une idée : un potager sur le balcon" }).lean()).tags)
        .toEqual(expect.arrayContaining(['origin:family', 'kind:idea']));
      await turn({ text: 'Rappelle-moi de nourrir le poisson demain', channel: 'voice' }).expect(200);
      expect(lastInference().messages.at(-1).content).toContain('a reminder and it has been saved for Dad to review');
      expect((await PlanningItem.findOne({ type: 'idea', summary: 'Rappelle-moi de nourrir le poisson demain' }).lean()).tags)
        .toEqual(expect.arrayContaining(['origin:family', 'kind:reminder']));
      inferences = executeForTest.mock.calls.length;
      const math = await turn({ text: 'Nestor, combien font 8 + 5 ?', channel: 'voice', stream: true }).buffer(true).parse(ndjson).expect(200);
      expect(JSON.parse(math.body.split('\n')[0])).toEqual({ type: 'scene', scene: { schema: 'agentx.math-scene.v1', kind: 'add', a: 8, b: 5 } });
      expect(executeForTest.mock.calls.length).toBe(inferences);
      const cow = (await turn({ text: 'Quel bruit fait la vache?', channel: 'voice' }).expect(200)).body.data;
      expect(cow.sound).toMatchObject({ id: 'cow', play: 'after-reply' });
      expect(lastInference().messages.at(-1).content).toContain('[Household instruction for this turn: follow it]\nSon : un vrai enregistrement (une vache) joue');
      expect(lastInference().taskType).toBe('voice_persona_chat');
      expect(agentForTest.mock.calls.length).toBe(nativeRuns + 1);
    } finally {
      fetchMock.mockRestore();
      for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    }
  });

  test('Kids Room and Lecture conversations carry the Nestor personality, so his instance voice reads the reply (#261)', async () => {
    const previous = process.env.HOUSEHOLD_PERSONA_VOICES;
    process.env.HOUSEHOLD_PERSONA_VOICES = JSON.stringify({ nestor: 'voxcpm|synthetic_voice' });
    const base = '/api/voice-personas/sessions';
    try {
      for (const packId of ['kidx_nestor', 'kidx_reader']) {
        // The request both pages send.
        const session = (await request(app).post(base).send({ packId, scopeId: 'family', modeId: '', personaId: 'nestor' }).expect(201)).body.data.session;
        expect(session.persona).toMatchObject({ id: 'nestor', voice: { provider: 'voxcpm', source: 'instance',
          voices: { fr: 'synthetic_voice', en: 'synthetic_voice' }, fallback: { provider: 'kokoro' } } });
        const turn = (await request(app).post(`${base}/${session.sessionId}/turns/text`)
          .send({ text: 'Que veut dire le mot curieux?', channel: 'voice' }).expect(200)).body.data;
        expect(turn.reply.speech).toMatchObject({ provider: 'voxcpm', voice: 'synthetic_voice' });
        expect(turn.session.persona.voice.source).toBe('instance');
      }
      // Without an instance voice the same request reads with Nestor's catalog voice.
      delete process.env.HOUSEHOLD_PERSONA_VOICES;
      const catalog = (await request(app).post(base).send({ packId: 'kidx_nestor', scopeId: 'family', modeId: '', personaId: 'nestor' }).expect(201)).body.data.session;
      expect(catalog.persona.voice).toMatchObject({ provider: 'kokoro', presentation: 'masculine' });
      // A family conversation accepts no other personality.
      await request(app).post(base).send({ packId: 'kidx_nestor', personaId: 'secretary' }).expect(400);
    } finally {
      if (previous === undefined) delete process.env.HOUSEHOLD_PERSONA_VOICES; else process.env.HOUSEHOLD_PERSONA_VOICES = previous;
    }
  });

  test('screen blocks stream as show events, never as speech, and secrets are not retained (#167)', async () => {
    const base = '/api/voice-personas/private/sessions';
    const id = (await request(app).post(base).send({ packId: 'personal_operator', scopeId: 'personal', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    const ndjson = (res, done) => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => done(null, text)); };
    executeForTest.mockResolvedValueOnce({ ok: true, metadata: { model: 'synthetic' }, body: { response:
      'Je t’ai mis les étapes à l’écran.\n<show kind="list" title="Étapes">\n1. Ouvrir\n2. Brancher\n3. Tester\n4. Fermer\n</show>\n'
      + '<show kind="secret" title="Clé">sk-synthetic-secret-value</show>\nOn commence?' } });
    const streamed = await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Montre-moi les étapes', channel: 'voice', stream: true })
      .buffer(true).parse(ndjson).expect(200);
    const events = streamed.body.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const spoken = events.filter(event => event.type === 'delta').map(event => event.delta).join('');
    expect(spoken).not.toMatch(/Brancher|sk-synthetic|show/);
    // `say_end` follows the last spoken word and precedes the turn's closing work, so a voice page flushes early.
    const types = events.map(event => event.type), sayEnd = types.indexOf('say_end');
    expect(types.filter(type => type === 'say_end')).toHaveLength(1);
    expect(sayEnd).toBeGreaterThan(types.lastIndexOf('delta'));
    expect(sayEnd).toBeLessThan(types.indexOf('tools'));
    expect(types.indexOf('tools')).toBeLessThan(types.indexOf('done'));
    expect(events.filter(event => event.type === 'show').map(event => event.block.kind)).toEqual(['list', 'secret']);
    const done = events.at(-1).data;
    expect(done.reply.text).toBe('Je t’ai mis les étapes à l’écran.\n\nOn commence?');
    expect(done.display[1]).toMatchObject({ kind: 'secret', body: 'sk-synthetic-secret-value' });

    const resumed = (await request(app).get(`${base}/${id}/history`).expect(200)).body.data;
    expect(resumed.turns[0].display[0]).toMatchObject({ kind: 'list', title: 'Étapes' });
    expect(resumed.turns[0].display[1]).toMatchObject({ kind: 'secret', body: '', redacted: true });
    expect(JSON.stringify(await Conversation.findOne({ 'messages.turn.sessionId': id }).lean())).not.toContain('sk-synthetic-secret-value');

    await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Lis-moi la troisième étape' }).expect(200);
    const prompt = executeForTest.mock.calls.at(-1)[0];
    const history = prompt.messages.map(message => message.content).join('\n');
    expect(history).toContain('3. Tester');
    expect(history).not.toContain('sk-synthetic-secret-value');
    expect(prompt.messages[0].content).toContain('kind="secret"');
  });

  test('a family voice turn keeps the browser’s timeline on its record, and the parent journal reads it (#9)', async () => {
    const base = '/api/voice-personas/family/sessions';
    const ndjson = (res, done) => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => done(null, text)); };
    const id = (await request(app).post(base).send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
    const turnId = '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', other = '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e60';
    executeForTest.mockResolvedValueOnce({ ok: true, metadata: { model: 'synthetic' }, body: { response: 'Une girafe mange des feuilles.' } });
    await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Que mange une girafe ?', channel: 'voice', stream: true, turnId })
      .buffer(true).parse(ndjson).expect(200);
    const timings = { sttDone: 640, requestSent: 655.4, firstDelta: 4200, firstAudio: 5100, interrupted: false, note: 'never stored' };
    const stored = (await request(app).post(`${base}/${id}/voice-timings`).send({ turnId, timings }).expect(200)).body.data;
    expect(stored.voiceTimings).toEqual({ sttDone: 640, requestSent: 655, firstDelta: 4200, firstAudio: 5100, interrupted: false });
    // Another space, another turn and unbounded values never reach the record.
    expect((await request(app).post(`/api/voice-personas/private/sessions/${id}/voice-timings`).send({ turnId, timings }).expect(404)).body.code).toBe('VOICE_TIMINGS_TURN_NOT_RECORDED');
    expect((await request(app).post(`${base}/${id}/voice-timings`).send({ turnId: other, timings }).expect(404)).body.code).toBe('VOICE_TIMINGS_TURN_NOT_RECORDED');
    expect((await request(app).post(`${base}/${id}/voice-timings`).send({ turnId, timings: { firstAudio: 1e12 } }).expect(400)).body.code).toBe('VOICE_TIMINGS_INVALID');
    const journal = (await request(app).get('/api/voice-personas/audit/recent?childSafe=true&limit=10').expect(200)).body.data.audit;
    expect(journal.find(row => row.clientTurnId === turnId).voiceTimings).toEqual(stored.voiceTimings);
    const resumed = (await request(app).get(`${base}/${id}/history`).expect(200)).body.data;
    expect(resumed.turns[0].voiceTimings).toEqual(stored.voiceTimings);
    expect((await Conversation.findOne({ 'messages.turn.clientTurnId': turnId }).lean()).messages.at(-1).turn.voiceTimings).toEqual(stored.voiceTimings);
  });

  test('an image block is resolved by Core, streamed to the visual zone and kept with the turn (#168)', async () => {
    const base = '/api/voice-personas/family/sessions';
    const previous = process.env.SEARXNG_URL, originalFetch = global.fetch, searches = [];
    process.env.SEARXNG_URL = 'http://searxng.example.test';
    const upstream = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      if (!String(url).startsWith('http://searxng.example.test/')) return originalFetch(url, options);
      searches.push(new URL(url));
      return new Response(JSON.stringify({ results: [{ img_src: 'https://images.example.test/giraffe.jpg',
        url: 'https://zoo.example.test/giraffe', title: 'Girafe' }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    const ndjson = (res, done) => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => done(null, text)); };
    try {
      const id = (await request(app).post(base).send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
      executeForTest.mockResolvedValueOnce({ ok: true, metadata: { model: 'synthetic' }, body: { response:
        'Je te montre une girafe! <show kind="image" source="web" title="Une girafe">girafe savane</show> Elle mange des feuilles.' } });
      const streamed = await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Montre-moi une girafe', stream: true })
        .buffer(true).parse(ndjson).expect(200);
      const events = streamed.body.split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(executeForTest.mock.calls.at(-1)[0].messages[0].content).toContain('<show kind="image" source="web"');
      expect(events.filter(event => event.type === 'delta').map(event => event.delta).join('')).not.toMatch(/savane|show/);
      const image = events.find(event => event.type === 'show').block;
      expect(image).toMatchObject({ kind: 'image', source: 'web', status: 'found',
        image: { url: 'https://images.example.test/giraffe.jpg', sourceLabel: 'Internet' } });
      expect(searches[0].searchParams.get('safesearch')).toBe('2');
      expect(events.at(-1).data.display[0].status).toBe('found');
      const resumed = (await request(app).get(`${base}/${id}/history`).expect(200)).body.data;
      expect(resumed.turns[0].display[0]).toMatchObject({ kind: 'image', status: 'found', image: { url: 'https://images.example.test/giraffe.jpg' } });
      await request(app).get('/api/voice-personas/family/visuals/file?source=photos&path=a.jpg').expect(404);
    } finally {
      upstream.mockRestore();
      if (previous === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = previous;
    }
  });

  test('the background brain reviews a recorded turn, the page receives it, and the next turn can correct itself (#169)', async () => {
    const base = '/api/voice-personas/private/sessions';
    const previous = process.env.HOUSEHOLD_BRAIN_ENABLED;
    process.env.HOUSEHOLD_BRAIN_ENABLED = 'true';
    try {
      const id = (await request(app).post(base).send({ packId: 'personal_operator', scopeId: 'personal', backend: 'agentx' }).expect(201)).body.data.session.sessionId;
      executeForTest.mockResolvedValueOnce({ ok: true, metadata: { model: 'synthetic' }, body: { response: 'Une araignée a six pattes.' } });
      executeForTest.mockResolvedValueOnce({ ok: true, metadata: { model: 'synthetic-brain' }, body: { response: JSON.stringify({
        suggestions: ['Et un scorpion?'], corrections: ['Une araignée a huit pattes, pas six.'], interjection: { text: 'Petite correction : huit pattes.', urgent: false } }) } });
      const turn = (await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Combien de pattes a une araignée?' }).expect(200)).body.data;
      const review = (await request(app).get(`${base}/${id}/brain?after=${turn.traceId}`).expect(200)).body.data.review;
      expect(review).toMatchObject({ traceId: turn.traceId, suggestions: ['Et un scorpion?'], interjection: { text: 'Petite correction : huit pattes.' } });
      const reviewer = executeForTest.mock.calls.at(-1)[0];
      expect(reviewer).toMatchObject({ taskType: 'master_brain', think: false, callerDetail: 'agentx-household/brain/private' });
      expect(reviewer.messages[1].content).toContain('Nestor (spoken): Une araignée a six pattes.');
      await request(app).get(`/api/voice-personas/family/sessions/${id}/brain`).expect(404);

      process.env.HOUSEHOLD_BRAIN_ENABLED = 'false';
      await request(app).post(`${base}/${id}/turns/text`).send({ text: 'Tu es sûr?' }).expect(200);
      // The reviewer's advice is reference data beside the request, never part of the system message (#261).
      const corrected = executeForTest.mock.calls.at(-1)[0].messages;
      expect(corrected.at(-1).content).toContain('Possible corrections: Une araignée a huit pattes, pas six.');
      expect(corrected[0].content).not.toContain('Possible corrections');
    } finally {
      if (previous === undefined) delete process.env.HOUSEHOLD_BRAIN_ENABLED; else process.env.HOUSEHOLD_BRAIN_ENABLED = previous;
    }
  });

  test('Nestor keeps an idea through add_idea and a parent promotes it once to a pipeline task (#13)', async () => {
    const kept = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'add_idea', arguments: { text: 'Synthetic idea: a weekly family game night', tags: ['maison'] } } }).expect(200);
    const idea = kept.body.result.structuredContent.idea;
    expect(idea).toMatchObject({ origin: 'nestor', kind: 'idea', status: 'inbox' });
    expect(await PipelineTask.countDocuments({ sourceKey: `idea:${idea.id}` })).toBe(0);
    // Planning targets still require a shaped idea; execution targets are the parent's review.
    expect((await request(app).post(`/api/planning/ideas/${idea.id}/promote`).send({ targetType: 'workstream' }).expect(409)).body.code).toBe('PLANNING_IDEA_NOT_SHAPED');
    const promoted = (await request(app).post(`/api/planning/ideas/${idea.id}/promote`).send({ targetType: 'task' }).expect(201)).body.data;
    expect(await PipelineTask.find({ source: 'planning-idea', sourceKey: `idea:${idea.id}` }).lean()).toHaveLength(1);
    expect(promoted.idea.status).toBe('promoted');
    const setAside = await request(app).post(`/api/family/ideas/${idea.id}/set-aside`).send({ action: 'reject' }).expect(409);
    expect(setAside.body.code).toBe('IDEA_ALREADY_REVIEWED');
  });
});
