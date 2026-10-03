'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerSessionPersonaRoutes } = require('../session-persona');

function fixture(overrides = {}) {
  const routes = new Map(), activePersonaTurns = new Map(), writes = [];
  const session = { sessionId: 'synthetic', packId: 'personal_operator', scopeId: 'personal', modeId: 'personal', agentId: 'main', status: 'active' };
  registerSessionPersonaRoutes({ post: (path, handler) => routes.set(path, handler) }, {
    activePersonaTurns, conversations: { getSession: async () => session,
      updateSession: async (query, update) => { writes.push({ query, update }); return { ...session, ...update.$set }; } },
    personas: { resolve: async () => ({ name: 'jarvis', version: 2, _id: 'synthetic', isActive: true, systemPrompt: 'Synthetic tone.' }) },
    ensureCatalog: async () => {}, envelope: (_res, data) => ({ status: 200, data }),
    fail: (_res, status, message, code) => ({ status, message, code }), ...overrides
  });
  return { activePersonaTurns, writes,
    switch: (body, space = 'private') => routes.get(`/${space}/sessions/:sessionId/persona`)({ params: { sessionId: 'synthetic' }, body }, {}) };
}

test('switch admission is synchronous and prevents a concurrent turn or switch throughout catalog resolution', async () => {
  let resolveRow, resolving;
  const entered = new Promise(resolve => { resolving = resolve; });
  const row = new Promise(resolve => { resolveRow = resolve; });
  const f = fixture({ personas: { resolve: async () => { resolving(); return row; } } });
  const pending = f.switch({ personaId: 'jarvis' });
  assert.equal(f.activePersonaTurns.has('synthetic'), true, 'turn admission sees the lock before the first await');
  await entered;
  assert.equal((await f.switch({ personaId: 'nestor' })).status, 409);
  resolveRow({ name: 'jarvis', version: 2, _id: 'synthetic', isActive: true, systemPrompt: 'Synthetic tone.' });
  assert.equal((await pending).status, 200);
  assert.equal(f.activePersonaTurns.size, 0);
  assert.deepEqual(Object.keys(f.writes[0].update.$set), ['persona']);
  assert.equal(f.writes[0].query.scopeId, 'personal');
});

test('an in-progress turn rejects the change before reading or writing the session', async () => {
  const f = fixture({ conversations: { getSession: () => { throw new Error('must not read'); } } });
  f.activePersonaTurns.set('synthetic', { turn: true });
  assert.equal((await f.switch({ personaId: 'jarvis' })).code, 'VOICE_TURN_IN_PROGRESS');
  assert.equal(f.writes.length, 0);
  assert.equal(f.activePersonaTurns.size, 1);
});

test('inactive exact versions refuse the write and release the lock for a later turn', async () => {
  const f = fixture({ personas: { resolve: async (name, version) => {
    assert.equal(version, 1);
    return { name, version, isActive: false };
  } } });
  assert.equal((await f.switch({ personaId: 'jarvis', personaVersion: 1 })).code, 'VOICE_PERSONA_INACTIVE');
  assert.equal(f.writes.length, 0);
  assert.equal(f.activePersonaTurns.size, 0);
});

test('missing selection and versions on a cleared personality fail explicitly', async () => {
  const f = fixture();
  for (const body of [{}, { personaId: '' }, { personaId: {} }, { personaId: null, personaVersion: 1 }]) {
    assert.equal((await f.switch(body)).code, 'VOICE_PERSONA_INVALID');
  }
  assert.equal((await f.switch({ personaId: null })).status, 200);
  assert.equal(f.writes[0].update.$set.persona, null);
});
