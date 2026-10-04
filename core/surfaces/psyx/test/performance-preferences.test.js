'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createReviewer } = require('../src/reviewer');
const { defaultsFor } = require('../../../src/services/conversationPreferences/catalog');
const { emptyState } = require('../../../src/domains/psyx/stateRepository');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

test('an all-light PsyX turn preserves crisis safeguards while sending no optional context and scheduling no work', async () => {
  const values = Object.fromEntries(Object.entries(defaultsFor('psyx', {})).map(([key, value]) => [key, typeof value === 'boolean' ? false : value]));
  const state = emptyState(); state.profile.about = 'SYNTHETIC_PRIVATE_ABOUT'; state.notes = [{ text: 'SYNTHETIC_PRIVATE_NOTE' }];
  const submitted = [], scheduled = [], touched = [], owners = [];
  const database = { stateRepository: { read: async () => state },
    preferencesForUser: owner => { owners.push(owner); return { read: async () => ({ revision: 7, values }) }; },
    recapForUser: () => { throw new Error('Disabled recap must not be read'); },
    conversationRepository: { context: async () => [{ role: 'user', content: 'Je veux me tuer ce soir.' }, { role: 'assistant', content: 'Reste avec moi.' }], saveCompletedTurn: async () => ({ id: '507f1f77bcf86cd799439011' }) } };
  const app = createApp({ config: { env: 'test', accessMode: 'token', accessToken: 'synthetic-perf', loopbackBypass: false,
    sessionTtlMs: 3600000, maxBodyBytes: 262144, requestTimeoutMs: 1000, voice: { mode: 'disabled' } }, database,
    provider: { stream: async (request, sink) => { submitted.push(request); sink.onToken('Synthetic safe reply'); return { content: 'Synthetic safe reply' }; } },
    reviewer: { schedule: (...args) => scheduled.push(args) }, dreamer: { touch: (...args) => touched.push(args) }, logger: { error() {} } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/psyx`, headers = { Authorization: 'Bearer synthetic-perf', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/preferences')).status, 401);
    const response = await fetch(base + '/chat/stream', { method: 'POST', headers,
      body: JSON.stringify({ conversationId: '507f1f77bcf86cd799439011', message: 'Je suis encore là.', psyx: { mode: 'challenge', depth: 'deep' } }) });
    assert.equal(response.status, 200); const body = await response.text();
    assert.match(body, /"safety":true/); assert.match(body, /"preferencesRevision":7/);
    assert.equal(submitted[0].taskType, 'analysis'); assert.equal(submitted[0].think, false);
    assert.deepEqual(submitted[0].messages, []); assert.doesNotMatch(submitted[0].system, /SYNTHETIC_PRIVATE/);
    assert.match(submitted[0].system, /immediate|crisis/i); assert.deepEqual(scheduled, []); assert.deepEqual(touched, []);
    assert.ok(owners.every(owner => owner === 'default'));
    assert.equal((await fetch(base + '/dream/run', { method: 'POST', headers, body: '{}' })).status, 409);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('review preferences gate queued work and discard a running result after a settings revision changes', async () => {
  let preferences = { revision: 1, values: { ...defaultsFor('psyx', {}), reviewDelaySeconds: 0, backgroundReview: false } };
  let calls = 0, recorded = 0, release, started;
  const begin = new Promise(resolve => { started = resolve; });
  const reviewer = createReviewer({ config: { review: { enabled: false, delayMs: 0 }, requestTimeoutMs: 1000 },
    preferencesFor: async () => structuredClone(preferences), logger: { warn() {} },
    provider: { complete: async () => { calls++; started(); await new Promise(resolve => { release = resolve; });
      return { content: JSON.stringify({ digest: { summary: 'Synthetic summary', next: { mode: 'talk', depth: 'normal' } }, proposals: [] }) }; } },
    conversationRepository: { context: async () => [{ role: 'user', content: 'Synthetic context' }] },
    stateRepository: { read: async () => emptyState(), recordReview: async (_id, input) => { if (await input.stillWanted()) recorded++; return { added: 0 }; } } });
  reviewer.schedule('owner', 'session'); await tick(); assert.equal(calls, 0);
  preferences = { revision: 2, values: { ...preferences.values, backgroundReview: true } };
  reviewer.schedule('owner', 'session'); await begin;
  preferences = { revision: 3, values: { ...preferences.values, backgroundReview: false } };
  release(); await tick(); assert.equal(calls, 1); assert.equal(recorded, 0);
  reviewer.forgetUser('owner');
});

test('the saved review delay postpones inference dispatch', async t => {
  let calls = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reviewer = createReviewer({ config: { review: {} }, logger: {},
    preferencesFor: async () => ({ revision: 1, values: { ...defaultsFor('psyx', {}), reviewDelaySeconds: 0.025 } }),
    provider: { complete: async () => { calls++; return { content: '{"digest":{"summary":"Synthetic"},"proposals":[]}' }; } },
    conversationRepository: { context: async () => [{ role: 'user', content: 'Synthetic' }] },
    stateRepository: { read: async () => emptyState(), recordReview: async () => ({ added: 0 }) } });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    reviewer.schedule('owner', 'session'); await flush();
    t.mock.timers.tick(24); await flush(); assert.equal(calls, 0);
    t.mock.timers.tick(1); await flush(); assert.equal(calls, 1);
  } finally { reviewer.forgetUser('owner'); t.mock.timers.reset(); }
});
