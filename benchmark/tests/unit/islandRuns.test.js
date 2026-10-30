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
const FRANK = { id: 'ile-de-frank', label: 'Île de Frank', live: 'https://frank.lan:18794' };
const WORLDS = JSON.stringify([{ id: 'mesa-island', label: 'Île Clawblox' }, FRANK]);
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
  it('retains a remote world recording receipt and filters untrusted paths', async () => {
    await islands.recordReport(ID, report({
      worldPrepared: { world: 'living-island', recordDir: '/data/recordings/run-1', token: 'never-kept' },
      status: { phase: 'running', worldKind: 'remote', remoteWorld: { world: 'living-island' },
        recording: `${ID}/recordings/delegated.clawrec`, liveView: { port: 18080, path: '/' } }
    }));
    expect((await IslandRun.findById(ID).lean()).worldView).toEqual({
      kind: 'remote', world: 'living-island', recordDir: '/data/recordings/run-1'
    });
    expect((await islands.getRun(ID, { env, queue: async () => ({ jobs: [] }) })).worldView).toEqual({
      kind: 'remote', world: 'living-island', recordDir: '/data/recordings/run-1'
    });
    for (const renderer of ['clawblox', 'graphysx']) {
      const deps = { env: { ...env, AGENTX_ISLAND_RENDERER: renderer, AGENTX_ISLAND_GRAPHYSX_URL: 'https://viewer.lan' },
        queue: async () => ({ jobs: [] }) };
      expect(await islands.getRun(ID, deps)).toMatchObject({ liveView: null, replayable: false });
      await expect(islands.openReplay(ID, deps)).rejects.toMatchObject({ statusCode: 409 });
    }
    await islands.recordReport(ID, report({
      worldPrepared: { world: '../wrong', recordDir: '/data/../secret' },
      status: { phase: 'finished', worldKind: 'remote', remoteWorld: { world: 'living-island' } }
    }));
    expect((await IslandRun.findById(ID).lean()).worldView).toEqual({
      kind: 'remote', world: 'living-island', recordDir: null
    });
  });

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

  it('offers the configured terrains and watches one that runs on its own', async () => {
    const gx = { ...env, AGENTX_ISLAND_GRAPHYSX_URL: 'http://viewer.lan:4231/', AGENTX_ISLAND_WORLDS: WORLDS };
    await islands.recordReport(ID, report({ executor: { ...executor, world: 'ile-de-frank' } }));
    const data = await islands.listRuns({ env: gx, queue: async () => ({ jobs: [] }) });
    expect(data.worldsError).toBeNull();
    expect(data.worlds.map(world => [world.id, world.label])).toEqual([['mesa-island', 'Île Clawblox'], ['ile-de-frank', 'Île de Frank']]);
    expect(data.worlds[0].liveUrl).toBeNull();
    expect(Object.fromEntries(new URL(data.worlds[1].liveUrl).searchParams)).toEqual({ app: 'island', embed: '1', source: 'https://frank.lan:18794' });
    // A running run on that terrain follows its agent there; its recording is not offered as a replay yet.
    expect(data.runs[0]).toMatchObject({ world: 'ile-de-frank', replayable: false });
    expect(Object.fromEntries(new URL(data.runs[0].liveView).searchParams)).toMatchObject({ source: 'https://frank.lan:18794', agent: 'Eko' });
    await expect(islands.openReplay(ID, { env: gx })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Île de Frank/) });
    // Without the setting the tab keeps its single terrain.
    expect((await islands.listRuns({ env, queue: async () => ({ jobs: [] }) })).worlds).toEqual([{ id: 'mesa-island', label: 'Île Clawblox', liveUrl: null }]);
  });

  it('launches on the chosen terrain and refuses one that is not configured', async () => {
    const calls = [];
    const deps = { queue: async () => ({ jobs: [] }), env: { ...env, AGENTX_ISLAND_WORLDS: WORLDS }, now: () => new Date('2026-10-28T20:00:00Z'), principalEndpoint: async () => 'http://gpu.lan:11434',
      submit: async body => { calls.push(body); return { id: ID, state: 'requested', revision: 1 }; }, place: async () => ({}) };
    await islands.launch({ clientKey: CLIENT_KEY, agent: 'Eko', minutes: 60, memory: 'fresh', world: 'ile-de-frank', when: 'none' }, deps);
    expect(calls[0].executor.world).toBe('ile-de-frank');
    expect(calls[0].title).toMatch(/Île de Frank$/);
    expect((await IslandRun.findById(ID).lean()).world).toBe('ile-de-frank');
    await expect(islands.launch({ clientKey: CLIENT_KEY, agent: 'Eko', minutes: 60, world: 'elsewhere', when: 'none' }, deps))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/mesa-island, ile-de-frank/) });
    await expect(islands.launch({ clientKey: CLIENT_KEY, agent: 'Eko', minutes: 60, world: 'ile-de-frank', when: 'none' }, { ...deps, env }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toHaveLength(1);
  });

  it('keeps one dispatch when the first reports arrive concurrently', async () => {
    const other = '00000000-0000-4000-8000-0000000000d2';
    const results = await Promise.allSettled([
      islands.recordReport(ID, report()), islands.recordReport(ID, report({ dispatchId: other }))
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason.statusCode).toBe(409);
    const saved = await IslandRun.findById(ID).lean();
    expect([DISPATCH, other]).toContain(saved.dispatchId);
    await Promise.all([islands.recordReport(ID, report({ dispatchId: saved.dispatchId })),
      islands.recordReport(ID, report({ dispatchId: saved.dispatchId }))]);
    expect((await IslandRun.findById(ID).lean()).dispatchId).toBe(saved.dispatchId);
  });

  it('reconciles a lost submit response by its native key despite a later clock or moved pin', async () => {
    let native = null;
    let clock = new Date('2026-10-29T01:00:00Z');
    const principalEndpoint = jest.fn(async () => 'http://gpu.lan:11434');
    const submit = jest.fn(async body => {
      native = { ...body, id: ID, revision: 1, state: 'requested', createdAt: clock.toISOString() };
      throw new Error('synthetic lost answer after native save');
    });
    const deps = { env, queue: async () => ({ jobs: native ? [native] : [] }), now: () => clock, principalEndpoint, submit };
    const input = { clientKey: CLIENT_KEY, agent: 'Agent', minutes: 60, when: 'none' };
    await expect(islands.launch(input, deps)).rejects.toThrow(/lost answer/);
    clock = new Date('2026-10-29T02:00:00Z');
    principalEndpoint.mockRejectedValue(new Error('pin changed'));
    const reconciled = await islands.launch(input, deps);
    expect(reconciled.id).toBe(ID);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(principalEndpoint).toHaveBeenCalledTimes(1);
    expect((await IslandRun.findById(ID).lean()).requestedAt).toBe(native.createdAt);
    await expect(islands.launch({ ...input, minutes: 120 }, deps)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reconciles a concurrent native key conflict and refuses an unreadable queue', async () => {
    let native = null;
    const deps = { env, queue: async () => ({ jobs: native ? [native] : [] }), principalEndpoint: async () => 'http://gpu.lan:11434',
      submit: async body => {
        native = { ...body, id: ID, revision: 1, state: 'requested' };
        throw Object.assign(new Error('another retry won'), { statusCode: 409 });
      } };
    const input = { clientKey: CLIENT_KEY, minutes: 60, when: 'none' };
    expect((await islands.launch(input, deps)).id).toBe(ID);
    const submit = jest.fn();
    await expect(islands.launch(input, { ...deps, queue: async () => ({}), submit }))
      .rejects.toMatchObject({ statusCode: 502 });
    expect(submit).not.toHaveBeenCalled();

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
    const deps = { env, queue: async () => ({ jobs: [] }), now: () => new Date('2026-10-28T20:00:00Z'), principalEndpoint: async () => 'http://gpu.lan:11434',
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

  it('keeps only typed recent agent messages, in the run detail and not in the list', async () => {
    const entries = [
      { at: '2026-10-29T22:04:14Z', kind: 'thought', text: 'Read my memory first.' },
      { at: '2026-10-29T22:11:08Z', kind: 'say', text: 'Both mysteries solved.' },
      { at: 'x', kind: 'shell', text: 'not a known kind' },
      { at: 'x', kind: 'command', text: 42 },
      ...Array.from({ length: 50 }, (_, i) => ({ at: 't', kind: 'command', text: `cmd ${i} ` + 'x'.repeat(700) }))
    ];
    await islands.recordReport(ID, report({ status: { ...report().status, agentMessages: entries } }));
    const quiet = { env, queue: async () => ({ jobs: [] }) };
    const run = await islands.getRun(ID, quiet);
    expect(run.agentMessages.length).toBeLessThanOrEqual(40);
    expect(run.agentMessages.every(m => ['thought', 'say', 'command'].includes(m.kind) && m.text.length <= 600)).toBe(true);
    expect(run.agentMessages.at(-1).text.startsWith('cmd 49 ')).toBe(true);
    const listed = await islands.listRuns(quiet);
    expect(listed.runs.find(r => r.id === ID)).not.toHaveProperty('agentMessages');
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
    const gx = await islands.openReplay(ID, { env: { ...env, AGENTX_ISLAND_GRAPHYSX_URL: 'http://viewer.lan/' }, fetchImpl });
    expect(new URL(gx.src).searchParams.get('agent')).toBe('Eko');
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
      expect(Object.keys(make({})).sort()).toEqual(['available', 'liveUrl', 'name', 'replayUrl', 'worldUrl']);
    }
    expect(() => islandViews({}, 'unknown')).toThrow(/Unknown island renderer/);
  });

  it('reads the terrains setting and refuses a bad one whole', () => {
    const { islandWorlds } = require('../../src/services/island/islandWorlds');
    expect(islandWorlds({})).toMatchObject({ worlds: [{ id: 'mesa-island', live: null }], error: null });
    expect(islandWorlds({ AGENTX_ISLAND_WORLDS: WORLDS }).worlds[1]).toEqual(FRANK);
    expect(islandWorlds({ AGENTX_ISLAND_WORLDS: '[{"id":"x-1"}]' }).worlds).toEqual([{ id: 'x-1', label: 'x-1', live: null }]);
    for (const bad of ['{', '[]', '{"id":"a"}', '[{"id":"A b"}]', '[{"id":"a"},{"id":"a"}]',
      '[{"id":"a","live":"https://h:1/path"}]', '[{"id":"a","live":"https://u:p@h:1"}]', '[{"id":"a","live":"ftp://h"}]']) {
      const read = islandWorlds({ AGENTX_ISLAND_WORLDS: bad });
      expect(read.worlds.map(world => world.id)).toEqual(['mesa-island']);
      expect(read.error).toMatch(/AGENTX_ISLAND_WORLDS/);
    }
  });

  it('shows a terrain that runs on its own only through GraphysX-Web', async () => {
    const { islandViews } = require('../../src/services/island/islandViews');
    const running = { phase: 'running', agent: 'Eko', world: 'ile-de-frank', liveView: { port: 18080, path: '/?spectator_token=tok-1' }, recording: 'r/x.clawrec' };
    const fetchImpl = async () => { throw new Error('the replay server must not be asked'); };
    const gx = islandViews({ ...env, AGENTX_ISLAND_GRAPHYSX_URL: 'http://viewer.lan:4231/', AGENTX_ISLAND_WORLDS: WORLDS });
    const live = new URL(gx.liveUrl(running));
    expect(Object.fromEntries(live.searchParams)).toEqual({ app: 'island', embed: '1', source: 'https://frank.lan:18794', agent: 'Eko' });
    expect(live.hash).toBe('');
    expect(gx.liveUrl({ ...running, phase: 'finished' })).toBeNull();
    expect(gx.worldUrl({ id: 'mesa-island', live: null })).toBeNull();
    await expect(gx.replayUrl(running, { fetchImpl })).rejects.toMatchObject({ statusCode: 409 });
    // A Clawblox world in the same list keeps the Clawblox stream.
    expect(new URL(gx.liveUrl({ ...running, world: 'mesa-island' })).searchParams.get('source')).toBe('http://runner.lan:18080');
    const own = islandViews({ ...env, AGENTX_ISLAND_WORLDS: WORLDS });
    expect(own.name).toBe('clawblox');
    expect(own.liveUrl(running)).toBeNull();
    expect(own.worldUrl(FRANK)).toBeNull();
    await expect(own.replayUrl(running, { fetchImpl })).rejects.toMatchObject({ statusCode: 409 });
    expect(own.liveUrl({ ...running, world: 'mesa-island' })).toBe('http://runner.lan:18080/?spectator_token=tok-1');
  });

  it('draws the island in GraphysX-Web when its viewer is configured', async () => {
    const { islandViews } = require('../../src/services/island/islandViews');
    const gx = { ...env, AGENTX_ISLAND_GRAPHYSX_URL: 'http://viewer.lan:4231/' };
    const running = { phase: 'running', agent: 'Eko', liveView: { port: 18080, path: '/?spectator_token=tok-1' } };
    const views = islandViews(gx);
    expect(views.name).toBe('graphysx');
    expect(views.available()).toEqual({ live: true, replay: true });
    const live = new URL(views.liveUrl(running));
    expect(live.origin).toBe('http://viewer.lan:4231');
    expect(Object.fromEntries(live.searchParams)).toEqual({ app: 'island', embed: '1', source: 'http://runner.lan:18080', agent: 'Eko' });
    expect(live.hash).toBe('#spectator_token=tok-1');
    const fetchImpl = async () => ({ ok: true, json: async () => ({ url: '/sessions/abc/', agent_log: '/x' }) });
    const replay = await views.replayUrl({ recording: 'r/x.clawrec', agent: 'Eko' }, { fetchImpl });
    expect(new URL(replay.src).searchParams.get('agent')).toBe('Eko');
    const odd = await views.replayUrl({ recording: 'r/x.clawrec', agent: '<b>' }, { fetchImpl });
    expect(new URL(odd.src).searchParams.has('agent')).toBe(false);
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
  const page = loadBrowserModule('island/index.js', 'escapeHtml, when, clock, duration, stateLabel, runRowHtml, runDetailHtml, episodesHtml, thoughtsHtml, terrainLabel, worldOptionsHtml', { apiFetch: async () => ({}) });

  it('reuses the same pending launch after a lost response, double click and page reload', async () => {
    const stored = new Map();
    const storage = { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
    const uuid = jest.fn(() => CLIENT_KEY);
    const calls = [];
    let rejectFirst;
    const apiFetch = async (url, options) => {
      if (!url.endsWith('/launch')) return { data: { runs: [], view: {}, queueRead: true } };
      calls.push(JSON.parse(JSON.stringify(options.body)));
      if (calls.length === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
      return { data: { id: ID, state: 'requested' } };
    };
    function mount() {
      const listeners = {};
      const fields = Object.fromEntries(Object.entries({ agent: 'Agent', minutes: '60', memory: 'continue', harness: 'pi', world: 'ile-de-frank', when: 'none' })
        .map(([key, value]) => [key, { value, disabled: false }]));
      const button = {};
      const form = { elements: { namedItem: key => fields[key] }, querySelector: () => button,
        addEventListener: (kind, fn) => { listeners[kind] = fn; } };
      const node = () => ({ addEventListener() {}, classList: { remove() {}, add() {} } });
      fields.world.dataset = {};
      fields.world.addEventListener = () => {};
      const nodes = { 'island-world': fields.world, 'island-watch': node(), 'island-watch-label': node(),
        'island-launch-form': form, 'island-launch-result': node(), 'island-runs': node(), 'island-runs-status': node(), 'island-memory-run': node() };
      loadBrowserModule('island/index.js', 'readPendingLaunch', {
        apiFetch, window: { sessionStorage: storage }, crypto: { randomUUID: uuid },
        FormData: class { get(key) { return fields[key].disabled ? null : fields[key].value; } },
        document: { getElementById: id => nodes[id], querySelector: () => node(), hidden: false },
        setInterval: () => 0, clearInterval() {}
      });
      return { fields, result: nodes['island-launch-result'], submit: () => listeners.submit({ preventDefault() {}, target: form }) };
    }
    const first = mount();
    const pending = first.submit();
    await first.submit(); // A second click while awaiting Core must do nothing.
    expect(calls).toHaveLength(1);
    rejectFirst(new Error('lost response'));
    await pending;
    expect(first.result.textContent).toContain('non confirmée');
    expect(first.fields.agent.disabled).toBe(true);
    expect(stored.size).toBe(1);
    const reloaded = mount();
    expect(reloaded.fields.world.value).toBe('ile-de-frank');
    expect(reloaded.fields.world.disabled).toBe(true);
    expect(calls[0].world).toBe('ile-de-frank');
    await reloaded.submit();
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1].harness).toBe('pi');
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(stored.size).toBe(0);
    expect(reloaded.fields.agent.disabled).toBe(false);
  });

  it('shows the latest thoughts newest first, escaped, with a time zone', () => {
    const html = page.thoughtsHtml([
      { at: '2026-10-29T22:04:14Z', kind: 'thought', text: 'Read <b>memory</b>' },
      { at: '2026-10-29T22:04:15Z', kind: 'command', text: 'curl "http://world/observe"' }], 'America/Toronto');
    expect(html.indexOf('commande')).toBeLessThan(html.indexOf('pense'));
    expect(html).toContain('&lt;b&gt;memory&lt;/b&gt;');
    expect(html).toContain('<code>curl &quot;http://world/observe&quot;</code>');
    expect(html).toMatch(/18:04|18 h 04/);
    expect(html).toMatch(/HAE|EDT|UTC−4|GMT-4/);
    expect(page.thoughtsHtml([])).toContain('Rien');
  });

  it('offers the terrains escaped and names each run\'s terrain once there is a choice', () => {
    const worlds = [{ id: 'mesa-island', label: 'Île Clawblox' }, { id: 'ile-de-frank', label: 'Île <de> Frank', liveUrl: 'http://v/' }];
    const options = page.worldOptionsHtml(worlds, 'ile-de-frank');
    expect(options).toContain('<option value="ile-de-frank" selected>Île &lt;de&gt; Frank</option>');
    expect(options).not.toContain('mesa-island" selected');
    expect(page.terrainLabel({ world: null }, worlds)).toBe('Île Clawblox');
    expect(page.terrainLabel({ world: 'gone' }, worlds)).toBe('gone');
    const run = { id: ID, agent: 'Eko', minutes: 60, world: 'ile-de-frank', queue: { state: 'reserved' } };
    const [main, detail] = page.runRowHtml(run, worlds).split('</tr>');
    expect((main.match(/<td/g) || []).length).toBe(4);
    expect(main).toContain('<span class="island-terrain">Île &lt;de&gt; Frank</span>');
    expect(detail).toContain('Île &lt;de&gt; Frank · Eko');
    expect(page.runRowHtml(run, [worlds[0]])).not.toContain('island-terrain');
  });

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
