'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const graphysx = require('../index');
const { allowedForFamilyDevice } = require('../../household/family-device');
const { demoSurfaceDisabled } = require('../../../../shared/agentxRuntimeProfile');

const VOCABULARY_URL = 'https://graphysx.example/embed/world-vocabulary.json';

// A small vocabulary in the published shape. Test fixture only: Core never carries the real
// one, it reads GraphysX's build.
const VOCABULARY = {
  schema: 'graphysx.world-vocabulary/v1',
  worldSchema: 'graphysx.agent-world/v2',
  proposalLimits: { commands: 4, intentChars: 60, replyBytes: 262144 },
  idPattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$',
  reservedIdPrefixes: ['live-agent:', 'live-mission:', 'live-nestor:'],
  operations: {
    spawn: { shape: { op: 'spawn', entity: '<entity>' }, description: 'Create one entity.', documentSubset: true },
    'spawn-prefab': { shape: { op: 'spawn-prefab', prefabId: '<prefabId>' }, description: 'Create a prefab.', documentSubset: false },
    update: { shape: { op: 'update', id: '<id>', patch: '<patch>' }, description: 'Change an entity.', documentSubset: true },
    remove: { shape: { op: 'remove', id: '<id>' }, description: 'Delete an entity.', documentSubset: true },
    'set-environment': { shape: { op: 'set-environment', environment: '<environment>' }, description: 'Scene looks.', documentSubset: true },
    select: { shape: { op: 'select', ids: ['<id>'] }, description: 'Highlight.', documentSubset: false }
  },
  entityTypes: {
    box: { primitive: true, physics: true, config: null },
    water: { primitive: false, physics: false, config: 'water' },
    flock: { primitive: false, physics: false, config: 'flock' },
    'point-light': { primitive: false, physics: false, config: null, fields: ['intensity', 'distance', 'marker'] }
  },
  fields: {
    entity: [{ name: 'id', description: 'Stable id.' }, { name: 'type', description: 'One of entityTypes.' }],
    patch: ['label', 'transform'],
    physics: [{ name: 'mass', range: [0, 100000], description: 'Kilograms.' }],
    dayNight: [{ name: 'cycleSeconds', range: [5, 86400] }]
  },
  behaviors: { spin: { fields: ['id', 'type', 'axis', 'speedDegrees'], description: 'Rotate.' } },
  interactions: { 'apply-impulse': { fields: ['id', 'type', 'targetIds', 'impulse'], description: 'Push.' } },
  enums: { skyIds: [{ id: 'clearblue', label: 'Clear Blue', description: 'Day.' }, { id: 'nightsky' }], flockPresets: [{ id: 'starlings', label: 'Starlings' }] },
  prefabs: [{ id: 'luminous-tree', label: 'Luminous Tree', summary: 'A glowing tree.', entityCount: 6 }],
  rules: ['Reply with JSON only.'],
  examples: { lake: [{ op: 'spawn', entity: { id: 'lake', type: 'water' } }] }
};

const SCENE = { id: 'showroom', label: 'Showroom', entities: [{ id: 'plinth', type: 'box', label: 'Plinth' }, { id: 'starlings', type: 'flock', label: 'Starlings' }] };
const REQUEST = { request: 'add a lake with a flock of birds at sunset', revision: 7, scene: SCENE };

const GOOD_REPLY = {
  intent: 'Add a lake, birds and a sunset sky.',
  commands: [
    { op: 'spawn', entity: { id: 'lake', type: 'water', water: { size: 20 } } },
    { op: 'spawn', entity: { id: 'lake-birds', type: 'flock', flock: { preset: 'starlings' } } },
    { op: 'set-environment', environment: { sky: 'nightsky' } },
    { op: 'update', id: 'starlings', patch: { label: 'Old birds' } }
  ]
};

function app({ env = { GRAPHYSX_VOCABULARY_URL: VOCABULARY_URL }, vocabulary = () => VOCABULARY, replies = [GOOD_REPLY], fetches = [] } = {}) {
  const server = express();
  const calls = [];
  let fetchCount = 0;
  const execute = async (body, options) => {
    calls.push({ body, options });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply && reply.$unavailable) return { ok: false, status: 503, body: { message: 'No host is admitted for this lane.' } };
    return { ok: true, status: 200, headers: { 'X-Resolved-Model': 'test-model' }, body: { response: typeof reply === 'string' ? reply : JSON.stringify(reply) } };
  };
  graphysx.register({
    app: server, express, env, execute,
    fetchWithTimeout: async (url) => {
      fetches.push(url);
      fetchCount += 1;
      const value = typeof vocabulary === 'function' ? vocabulary(fetchCount) : vocabulary;
      if (value && value.$status) return { ok: false, status: value.$status, text: async () => '' };
      return { ok: true, status: 200, text: async () => (typeof value === 'string' ? value : JSON.stringify(value)) };
    }
  });
  server.calls = calls;
  server.fetches = fetches;
  return server;
}

test('a request becomes a validated proposal: prompt from the vocabulary, one admitted inference, JSON back', async () => {
  const server = app();
  const res = await request(server).post('/api/graphysx/propose').send(REQUEST).expect(200);
  assert.equal(res.body.intent, GOOD_REPLY.intent);
  assert.deepEqual(res.body.commands, GOOD_REPLY.commands);
  assert.equal(res.body.model, 'test-model');
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.deepEqual(server.fetches, [VOCABULARY_URL]);
  assert.equal(server.calls.length, 1);
  const { body, options } = server.calls[0];
  assert.equal(body.callerDetail, 'graphysx-propose');
  assert.equal(body.taskType, 'analysis');
  assert.equal(body.stream, false);
  assert.equal(body.format, 'json');
  assert.ok(options.signal instanceof AbortSignal);
  // The prompt is rendered from the vocabulary, not from a copy: every op, type, bound, id and rule is there.
  for (const text of ['spawn-prefab', 'point-light', 'mass[0..100000]', 'cycleSeconds[5..86400]', 'clearblue (Clear Blue: Day.)', 'luminous-tree: Luminous Tree', 'Reply with JSON only.', 'live-agent:', '"lake"']) {
    assert.ok(body.system.includes(text), `system prompt lacks ${text}`);
  }
  const user = JSON.parse(body.prompt);
  assert.equal(user.request, REQUEST.request);
  assert.deepEqual(user.scene.entities, SCENE.entities);
  assert.equal(user.scene.revision, 7);
  assert.doesNotMatch(body.prompt, /water: \{/, 'the scene summary is ids, types and labels; never the document');
});

test('the request is refused before any model runs when it is not a proposal request', async () => {
  const server = app();
  for (const body of [
    {}, { ...REQUEST, extra: 1 }, { ...REQUEST, request: '' }, { ...REQUEST, request: 'x'.repeat(2001) }, { ...REQUEST, revision: -1 },
    { ...REQUEST, scene: { id: 's', label: 'S' } }, { ...REQUEST, scene: { ...SCENE, entities: [{ id: 'a', type: 'box', label: 'A', position: [0, 0, 0] }] } },
    { ...REQUEST, scene: { ...SCENE, entities: Array.from({ length: 61 }, (_, i) => ({ id: `e${i}`, type: 'box', label: 'x' })) } },
    { ...REQUEST, request: 'add\u0000thing' }
  ]) {
    const res = await request(server).post('/api/graphysx/propose').set('content-type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(res.body.ok, false);
  }
  assert.equal(server.calls.length, 0);
  assert.equal(server.fetches.length, 0, 'the vocabulary is not even read for a bad request');
});

test('without GRAPHYSX_VOCABULARY_URL the route says so and composes nothing', async () => {
  const server = app({ env: {} });
  const res = await request(server).post('/api/graphysx/propose').send(REQUEST).expect(404);
  assert.equal(res.body.code, 'GRAPHYSX_NOT_CONFIGURED');
  assert.match(res.body.reason, /not configured/);
  assert.equal(server.calls.length, 0);
  assert.throws(() => graphysx.vocabularyUrl({ GRAPHYSX_VOCABULARY_URL: 'https://u:p@graphysx.example/x.json' }), /without credentials/);
});

test('the vocabulary is read once, kept, and must be the vocabulary', async () => {
  const server = app();
  await request(server).post('/api/graphysx/propose').send(REQUEST).expect(200);
  await request(server).post('/api/graphysx/propose').send(REQUEST).expect(200);
  assert.equal(server.fetches.length, 1, 'cached for ten minutes');
  const status = await request(server).get('/api/graphysx/vocabulary').expect(200);
  assert.equal(status.body.data.url, VOCABULARY_URL);
  assert.equal(status.body.data.entityTypes, 4);
  assert.equal(status.body.data.prefabs, 1);
  assert.deepEqual(status.body.data.proposalLimits, VOCABULARY.proposalLimits);

  for (const bad of ['<!doctype html>', { schema: 'something-else', operations: {} }, { ...VOCABULARY, $status: 404 }]) {
    const broken = app({ vocabulary: bad });
    const res = await request(broken).post('/api/graphysx/propose').send(REQUEST).expect(502);
    assert.equal(res.body.code, 'GRAPHYSX_VOCABULARY_UNAVAILABLE');
    assert.equal(broken.calls.length, 0);
  }
  // Too large to be the vocabulary.
  const huge = app({ vocabulary: `{"schema":"graphysx.world-vocabulary/v1","operations":{},"entityTypes":{},"pad":"${'x'.repeat(1024 * 1024)}"}` });
  assert.equal((await request(huge).post('/api/graphysx/propose').send(REQUEST)).status, 502);
});

test('a model answer is validated against the vocabulary and the scene before it leaves Core', () => {
  const check = (reply) => graphysx.validateProposal(reply, { vocabulary: VOCABULARY, scene: SCENE });
  assert.equal(check(GOOD_REPLY).ok, true);
  const refused = [
    [null, /did not answer with a JSON proposal/],
    [{ commands: GOOD_REPLY.commands }, /did not say what the change does/],
    [{ intent: 'x'.repeat(61), commands: GOOD_REPLY.commands }, /61 characters; 60 is the most/],
    [{ intent: 'ok', commands: 'spawn a box' }, /list of commands/],
    [{ intent: 'ok', commands: [] }, /no changes/],
    [{ intent: 'ok', commands: Array.from({ length: 5 }, (_, i) => ({ op: 'spawn', entity: { id: `b${i}`, type: 'box' } })) }, /5 changes; 4 is the most/],
    [{ intent: 'ok', commands: [{ op: 'eval', code: 'x' }] }, /operation the world does not have \(eval\)/],
    [{ intent: 'ok', commands: [{ op: 'spawn', entity: { id: 'dragon', type: 'dragon' } }] }, /entity type the world does not have \(dragon\)/],
    [{ intent: 'ok', commands: [{ op: 'spawn', entity: { id: 'plinth', type: 'box' } }] }, /reuses the id "plinth"/],
    [{ intent: 'ok', commands: [{ op: 'spawn', entity: { id: 'live-agent:bob', type: 'box' } }] }, /reserved id namespace "live-agent:"/],
    [{ intent: 'ok', commands: [{ op: 'update', id: 'ghost', patch: {} }] }, /\(update\) names "ghost", which is not in this scene/],
    [{ intent: 'ok', commands: [{ op: 'remove', id: 'nothing' }] }, /\(remove\) names "nothing"/],
    [{ intent: 'ok', commands: [{ op: 'select', ids: ['plinth', 'nope'] }] }, /selects an id that is not in this scene/],
    [{ intent: 'ok', commands: [{ op: 'spawn-prefab', prefabId: 'castle' }] }, /prefab the world does not have \(castle\)/],
    [{ intent: 'ok', commands: [{ op: 'spawn', entity: { id: 'kid', type: 'box', parentId: 'missing' } }] }, /parents under "missing"/],
    [{ intent: 'ok', commands: ['spawn'] }, /Change 1 is not an object/],
  ];
  for (const [reply, pattern] of refused) {
    const result = check(reply);
    assert.equal(result.ok, false, JSON.stringify(reply).slice(0, 80));
    assert.match(result.reason, pattern);
  }
  // Ids a prior command in the same list creates are usable by the next one, as the runtime applies them in order.
  assert.equal(check({ intent: 'ok', commands: [{ op: 'spawn', entity: { id: 'post', type: 'box' } }, { op: 'update', id: 'post', patch: {} }, { op: 'select', ids: ['post'] }] }).ok, true);
  assert.equal(check({ intent: 'ok', commands: [{ op: 'spawn-prefab', prefabId: 'luminous-tree', options: { idPrefix: 'tree' } }, { op: 'select', ids: ['tree'] }] }).ok, true);
  // The model's own refusal passes through as its sentence.
  assert.deepEqual(check({ ok: false, reason: 'A dragon is not in this world.' }), { ok: false, reason: 'A dragon is not in this world.', declined: true });
});

test('a fenced or chatty answer is still read; a second attempt carries the refusal; then the refusal is the answer', async () => {
  const fenced = `Here you go:\n\`\`\`json\n${JSON.stringify(GOOD_REPLY)}\n\`\`\``;
  const ok = await request(app({ replies: [fenced] })).post('/api/graphysx/propose').send(REQUEST).expect(200);
  assert.equal(ok.body.intent, GOOD_REPLY.intent);
  assert.deepEqual(graphysx.parseModelReply('text {"a":{"b":"}"}} tail'), { a: { b: '}' } });
  assert.equal(graphysx.parseModelReply('no json here'), null);

  const retried = app({ replies: [{ intent: 'ok', commands: [{ op: 'eval' }] }, GOOD_REPLY] });
  const second = await request(retried).post('/api/graphysx/propose').send(REQUEST).expect(200);
  assert.equal(second.body.intent, GOOD_REPLY.intent);
  assert.equal(retried.calls.length, 2);
  assert.match(retried.calls[1].body.prompt, /previous answer was refused: Change 1 uses an operation the world does not have \(eval\)/);

  const refusing = app({ replies: [{ intent: 'ok', commands: [{ op: 'eval' }] }] });
  const refused = await request(refusing).post('/api/graphysx/propose').send(REQUEST).expect(200);
  assert.deepEqual(refused.body, { ok: false, reason: 'Change 1 uses an operation the world does not have (eval).', model: 'test-model' });
  assert.equal(refusing.calls.length, graphysx.MAX_ATTEMPTS);

  // The model declining is an answer in one attempt, not a retry.
  const declined = app({ replies: [{ ok: false, reason: 'A dragon is not in this world.' }] });
  const no = await request(declined).post('/api/graphysx/propose').send(REQUEST).expect(200);
  assert.equal(no.body.ok, false);
  assert.match(no.body.reason, /dragon/);
  assert.equal(declined.calls.length, 1);

  // No admitted host: a sentence, with the router's status.
  const down = await request(app({ replies: [{ $unavailable: true }] })).post('/api/graphysx/propose').send(REQUEST).expect(503);
  assert.equal(down.body.ok, false);
  assert.match(down.body.reason, /No host is admitted/);
});

test('the route is a full-profile, private-LAN surface like DiskX: off in demo, refused on a family-pinned device', () => {
  for (const path of ['/api/graphysx/propose', '/api/graphysx/vocabulary']) {
    assert.equal(demoSurfaceDisabled(path, 'POST'), true, path);
    assert.equal(allowedForFamilyDevice({ path, method: 'POST', query: {} }), false, path);
    assert.equal(allowedForFamilyDevice({ path, method: 'GET', query: {} }), false, path);
  }
});


test('prompt includes new vocabulary blocks and their resource limits without a second field registry', () => {
  const vocabulary = structuredClone(VOCABULARY);
  vocabulary.entityTypes.mesh = { primitive: false, physics: true, requires: ['mesh'] };
  vocabulary.fields.mesh = [{ name: 'positions', description: 'Local xyz triples.' }, 'indices'];
  vocabulary.fields.pixels = [{ name: 'rgba', description: 'Unsigned RGBA bytes.' }];
  vocabulary.fields.futureConstruction = [{ name: 'profile', description: 'Published construction profile.' }];
  vocabulary.limits = { mesh: { vertices: 4096 }, pixels: { dimension: 64 } };
  const prompt = graphysx.buildSystemPrompt(vocabulary);
  assert.match(prompt, /mesh: positions.*Local xyz triples.*indices/);
  assert.match(prompt, /pixels: rgba.*Unsigned RGBA bytes/);
  assert.match(prompt, /futureConstruction: profile.*Published construction profile/);
  assert.match(prompt, /authored triangle mesh/);
  assert.ok(prompt.includes(JSON.stringify(vocabulary.limits)));
  assert.equal(prompt.split('mesh: positions').length, 2);
});
