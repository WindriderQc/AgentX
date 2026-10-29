'use strict';
// Île tab (docs/ISLAND.md): service on a disposable in-memory Mongo, routes
// and page helpers. No Core, no runner, no model.
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const mongoOptions = require('../../../shared/testing/mongoOptions');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { loadBrowserModule } = require('../helpers/browserModule');
const IslandRun = require('../../models/IslandRun');
const islands = require('../../src/services/island/islandRunService');

const ID = '00000000-0000-4000-8000-0000000000a1';
const DISPATCH = '00000000-0000-4000-8000-0000000000d1';
const CLIENT_KEY = '00000000-0000-4000-8000-0000000000c1';
const executor = { mode: 'island', receiptRef: 'island/x.json', agent: 'Eko', minutes: 60, memory: 'continue', world: 'mesa-island' };
const env = { AGENTX_ISLAND_VIEW_ORIGIN: 'http://runner.lan', AGENTX_ISLAND_REPLAY_URL: 'http://runner.lan:18092' };
const job = (extra = {}) => ({ id: ID, kind: 'other', state: 'running', revision: 4, title: 'Île — Eko, 60 min', executor,
  reservation: { start: '2026-10-29T03:00:00.000Z', end: '2026-10-29T04:10:00.000Z' }, createdAt: '2026-10-28T20:00:00.000Z', ...extra });

let mongoServer;
beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), mongoOptions);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});
afterEach(async () => { await IslandRun.deleteMany({}); });

function report(extra = {}) {
  return { queueRequestId: ID, dispatchId: DISPATCH, runner: 'devx', executor,
    status: { phase: 'running', model: 'agentx-primary', startedAt: '2026-10-28T23:00:05-04:00', timeZone: 'America/Toronto',
      resumeCount: 2, events: [{ at: 'x', event: 'resumed', reason: 'memory-reminder', token: 'never-kept' }],
      liveView: { port: 18080, path: '/?viewport=1&spectator_token=abc' }, recording: `${ID}/recordings/20261029_030005.clawrec` },
    ...extra };
}

describe('island run service', () => {
  it('keeps only typed report fields and refuses another dispatch of the same request', async () => {
    await islands.recordReport(ID, report());
    const saved = await IslandRun.findById(ID).lean();
    expect(saved).toMatchObject({ agent: 'Eko', model: 'agentx-primary', runner: 'devx', resumeCount: 2, phase: 'running' });
    expect(saved.events[0]).not.toHaveProperty('token');
    await expect(islands.recordReport(ID, report({ dispatchId: '00000000-0000-4000-8000-0000000000d2' }))).rejects.toMatchObject({ statusCode: 409 });
    await expect(islands.recordReport(ID, report({ queueRequestId: 'other' }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(islands.recordReport(ID, report({ executor: { ...executor, model: 'x' } }))).rejects.toMatchObject({ statusCode: 400 });
    await islands.recordReport(ID, report({ status: { phase: 'finished', model: 'some-concrete-model', recording: '../../etc/passwd' } }));
    const later = await IslandRun.findById(ID).lean();
    expect(later.model).toBe('agentx-primary');
    expect(later.recording).toBe(`${ID}/recordings/20261029_030005.clawrec`);
  });

  it('lists recorded runs joined with Core queue state, live link only while running', async () => {
    await islands.recordReport(ID, report({ memory: { 'SEMANTIC_MEMORY.md': { bytes: 4, text: 'note' } } }));
    const waiting = job({ id: '00000000-0000-4000-8000-0000000000a2', state: 'reserved' });
    const other = { id: '00000000-0000-4000-8000-0000000000a3', kind: 'profiler', executor: { hostId: 'h' } };
    const data = await islands.listRuns({ env, queue: async () => ({ jobs: [job(), waiting, other] }) });
    expect(data.runs.map(run => run.id)).toEqual([ID, waiting.id]);
    expect(data.runs[0]).toMatchObject({ liveView: 'http://runner.lan:18080/?viewport=1&spectator_token=abc', replayable: true, resumeCount: 2,
      hasMemory: true, queue: { state: 'running' } });
    expect(data.view).toEqual({ live: true, replay: true });
    expect(data.runs[1]).toMatchObject({ agent: 'Eko', model: 'agentx-primary', liveView: null, queue: { state: 'reserved' } });
    const unread = await islands.listRuns({ env: {}, queue: async () => { throw new Error('down'); } });
    expect(unread).toMatchObject({ queueRead: false, view: { live: false, replay: false } });
    expect(unread.runs[0].liveView).toBeNull();
  });

  it('shows the memory files of a run and the agent\'s other runs', async () => {
    const memory = { 'SOUL.md': { bytes: 5, text: 'I am' }, 'EPISODIC_MEMORY.jsonl': { bytes: 9, text: '{"summary":"tower"}\n' },
      'SEMANTIC_MEMORY.md': { bytes: 20, text: '[verified] blocks stay' } };
    await islands.recordReport(ID, report({ memory, status: { phase: 'finished', endedAt: '2026-10-29T00:00:00-04:00' } }));
    const data = await islands.getMemory(ID);
    expect(data.files['SEMANTIC_MEMORY.md'].text).toBe('[verified] blocks stay');
    expect(data.runs.map(run => run.id)).toEqual([ID]);
    await expect(islands.getMemory('00000000-0000-4000-8000-0000000000ff')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('Lancer records one queue request on the principal endpoint and lets Core place it; nothing starts', async () => {
    const calls = [];
    const deps = { env, now: () => new Date('2026-10-28T20:00:00Z'), principalEndpoint: async () => 'http://gpu.lan:11434',
      submit: async body => { calls.push(['submit', body]); return { id: ID, state: 'requested', revision: 1 }; },
      place: async (id, body) => { calls.push(['place', id, body]); return { reservation: { start: '2026-10-29T03:00:00Z', end: '2026-10-29T04:10:00Z' } }; } };
    const result = await islands.launch({ clientKey: CLIENT_KEY, agent: 'Eko', minutes: 60, memory: 'fresh', when: 'tonight' }, deps);
    expect(result).toMatchObject({ id: ID, state: 'reserved', placed: { start: '2026-10-29T03:00:00Z' } });
    const submitted = calls[0][1];
    expect(submitted).toMatchObject({ key: `island:${CLIENT_KEY}`, kind: 'other', hosts: ['http://gpu.lan:11434'], estimatedMinutes: 70,
      source: { type: 'operator', ref: 'benchmark-island-tab' },
      executor: { mode: 'island', agent: 'Eko', minutes: 60, memory: 'fresh', world: 'mesa-island', receiptRef: `island/${CLIENT_KEY}.json` } });
    expect(JSON.stringify(submitted)).not.toMatch(/model/);
    expect(calls[1]).toEqual(['place', ID, { expectedRevision: 1, when: 'tonight' }]);
    expect((await IslandRun.findById(ID).lean()).phase).toBe('queued');

    const refused = await islands.launch({ clientKey: CLIENT_KEY, agent: 'Eko', minutes: 60, when: 'asap' },
      { ...deps, place: async () => { throw new Error('HEAVY_QUEUE_CONFLICT'); } });
    expect(refused).toMatchObject({ placed: null, note: expect.stringMatching(/did not place/) });
    await expect(islands.launch({ clientKey: 'x', minutes: 60 }, deps)).rejects.toMatchObject({ statusCode: 400 });
    await expect(islands.launch({ clientKey: CLIENT_KEY, minutes: 2 }, deps)).rejects.toMatchObject({ statusCode: 400 });
    await expect(islands.launch({ clientKey: CLIENT_KEY, minutes: 60 }, { ...deps, principalEndpoint: async () => null }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('opens a recording in the configured replay server only', async () => {
    await expect(islands.openReplay(ID, { env: {} })).rejects.toMatchObject({ statusCode: 409 });
    await islands.recordReport(ID, report());
    const seen = [];
    const fetchImpl = async (url, options) => { seen.push([url, JSON.parse(options.body)]); return { ok: true, json: async () => ({ url: '/sessions/abc', agent_log: '/x' }) }; };
    await expect(islands.openReplay(ID, { env, fetchImpl })).resolves.toEqual({ src: 'http://runner.lan:18092/sessions/abc', agentLog: true });
    expect(seen[0]).toEqual(['http://runner.lan:18092/api/open-replay', { path: `${ID}/recordings/20261029_030005.clawrec` }]);
    const evil = async () => ({ ok: true, json: async () => ({ url: 'https://elsewhere.example/x' }) });
    await expect(islands.openReplay(ID, { env, fetchImpl: evil })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('keeps the 3D views behind one renderer interface with credential-free origins', () => {
    const { islandViews, RENDERERS } = require('../../src/services/island/islandViews');
    const running = { phase: 'running', liveView: { port: 18080, path: '/?t=1' } };
    const refused = islandViews({ AGENTX_ISLAND_VIEW_ORIGIN: 'http://u:p@runner.lan', AGENTX_ISLAND_REPLAY_URL: 'http://runner.lan:18092/x' });
    expect(refused.available()).toEqual({ live: false, replay: false });
    expect(refused.liveUrl(running)).toBeNull();
    const views = islandViews({ AGENTX_ISLAND_VIEW_ORIGIN: 'http://runner.lan:80', AGENTX_ISLAND_REPLAY_URL: 'https://runner.lan' });
    expect(views.available()).toEqual({ live: true, replay: true });
    expect(views.liveUrl(running)).toBe('http://runner.lan:18080/?t=1');
    expect(views.liveUrl({ ...running, phase: 'finished' })).toBeNull();
    for (const make of Object.values(RENDERERS)) {
      expect(Object.keys(make({})).sort()).toEqual(['available', 'liveUrl', 'name', 'replayUrl']);
    }
    expect(() => islandViews({}, 'unknown')).toThrow(/Unknown island renderer/);
  });

  it('draws the island in GraphysX-Web when its viewer is configured', async () => {
    const { islandViews } = require('../../src/services/island/islandViews');
    const gx = { ...env, AGENTX_ISLAND_GRAPHYSX_URL: 'http://viewer.lan:4231/' };
    const running = { phase: 'running', liveView: { port: 18080, path: '/?spectator_token=tok-1' } };
    const views = islandViews(gx);
    expect(views.name).toBe('graphysx');
    expect(views.available()).toEqual({ live: true, replay: true });
    const live = new URL(views.liveUrl(running));
    expect(live.origin).toBe('http://viewer.lan:4231');
    expect(Object.fromEntries(live.searchParams)).toEqual({ app: 'island', embed: '1', source: 'http://runner.lan:18080' });
    expect(live.hash).toBe('#spectator_token=tok-1');
    const fetchImpl = async () => ({ ok: true, json: async () => ({ url: '/sessions/abc/', agent_log: '/x' }) });
    const replay = await views.replayUrl({ recording: 'r/x.clawrec' }, { fetchImpl });
    expect(replay.agentLog).toBe(true);
    expect(new URL(replay.src).searchParams.get('source')).toBe('http://runner.lan:18092/sessions/abc');
    expect(islandViews({ ...gx, AGENTX_ISLAND_RENDERER: 'clawblox' }).name).toBe('clawblox');
    const unset = islandViews({ ...env, AGENTX_ISLAND_RENDERER: 'graphysx' });
    expect(unset.available()).toEqual({ live: false, replay: false });
    expect(unset.liveUrl(running)).toBeNull();
    await expect(unset.replayUrl({ recording: 'r/x.clawrec' }, { fetchImpl })).rejects.toMatchObject({ statusCode: 409 });
    expect(islandViews({ ...env, AGENTX_ISLAND_GRAPHYSX_URL: 'http://viewer.lan/?x=1' }).available()).toEqual({ live: false, replay: false });
  });
});

describe('island routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/island', require('../../routes/island'));

  it('reports and reads through the API; bad ids are client errors', async () => {
    await request(app).post(`/api/island/runs/${ID}/report`).send(report()).expect(200);
    const shown = await request(app).get(`/api/island/runs/${ID}`).expect(200);
    expect(shown.body.data).toMatchObject({ id: ID, agent: 'Eko', events: [{ event: 'resumed' }] });
    await request(app).get('/api/island/runs/not-an-id').expect(400);
    await request(app).post('/api/island/launch').send({ clientKey: 'bad' }).expect(400);
  });
});

describe('island page helpers', () => {
  const page = loadBrowserModule('island/index.js', 'escapeHtml, when, duration, stateLabel, runRowHtml, runDetailHtml, episodesHtml', { apiFetch: async () => ({}) });

  it('escapes run text and always shows a time zone', () => {
    expect(page.escapeHtml('<img onerror=x>')).toBe('&lt;img onerror=x&gt;');
    expect(page.when('2026-10-28T22:06:03Z', 'America/Toronto')).toMatch(/18 h 06|18:06/);
    expect(page.when('2026-10-28T22:06:03Z', 'America/Toronto')).toMatch(/HAE|EDT|UTC−4|GMT-4/);
    expect(page.when(null)).toBe('—');
  });

  it('renders four columns, with resumes and receipts in the hidden detail row', () => {
    const run = { id: ID, agent: 'Eko', minutes: 60, memoryMode: 'continue', model: 'agentx-primary', resumeCount: 3,
      startedAt: '2026-10-28T22:06:03Z', endedAt: '2026-10-28T23:06:03Z', timeZone: 'America/Toronto', replayable: true, hasMemory: true,
      liveView: null, receipt: { state: 'completed', sha256: 'f'.repeat(64), runtimeReleased: true }, queue: { state: 'completed' } };
    const html = page.runRowHtml(run);
    const [main, detail] = html.split('</tr>');
    expect((main.match(/<td/g) || []).length).toBe(4);
    expect(main).toContain('60 min');
    expect(main).toContain('data-replay');
    expect(main).not.toContain('data-live');
    expect(main).toContain('>Voir<');
    expect(main).toContain('>Mémoire<');
    expect(main).not.toContain('agentx-primary');
    expect(detail).toContain('hidden');
    expect(detail).toContain('Relances : 3');
    expect(detail).toContain('Reçu terminée');
    // A running run's Voir opens the live view instead of the replay.
    expect(page.runRowHtml({ ...run, liveView: 'http://runner.lan:18080/?t=1' })).toContain('data-live');
    expect(page.stateLabel({ queue: { state: 'reserved' } }).text).toBe('créneau réservé');
  });

  it('lists episodes and keeps unreadable lines visible', () => {
    const html = page.episodesHtml('{"time":"t1","summary":"<b>tower</b>","detail":"five blocks"}\nnot json\n');
    expect(html).toContain('&lt;b&gt;tower&lt;/b&gt;');
    expect(html).toContain('not json');
  });
});
