'use strict';
const express = require('express');
const request = require('supertest');
const Model = require('../../models/ConversationPreferences');
const { createConversationPreferences } = require('../../src/services/conversationPreferences/service');
const { catalogFor, defaultsFor, selectPsyxState } = require('../../src/services/conversationPreferences/catalog');
const { registerPreferenceRoutes } = require('../../src/services/conversationPreferences/routes');
const { composeSystemContext, normalizeControl } = require('../../src/domains/psyx/domain');
const { emptyState } = require('../../src/domains/psyx/stateRepository');
const store = createConversationPreferences({ Model, env: {} });
const own = (surface = 'psyx', ownerId = 'synthetic-owner') => store.forOwner({ ownerId, surface });
beforeEach(async () => { await Model.deleteMany({}); });

test('environment is a bootstrap default, not a persisted preference', async () => {
  expect(defaultsFor('psyx', { PSYX_AUTO_REVIEW: 'false', PSYX_DREAM: 'false' })).toMatchObject({ backgroundReview: false, dreamEnabled: false });
  expect(defaultsFor('nestor', {})).toMatchObject({ backgroundReview: false, memoryContext: true });
  const first = await own().read(); expect(first.revision).toBe(0); expect(first.values.recapContext).toBe(true);
  expect(await Model.countDocuments()).toBe(0);
});
test('saves, reloads and resets without changing another owner or surface', async () => {
  const saved = await own().save({ revision: 0, values: { backgroundReview: false, recapContext: false } });
  expect(saved.values.backgroundReview).toBe(false); expect(saved.revision).toBe(1);
  expect((await own().read()).values.recapContext).toBe(false);
  expect((await own('psyx', 'other').read()).values.recapContext).toBe(true);
  expect((await own('nestor').read()).values.recapContext).toBe(true);
  const reset = await own().save({ revision: 1, values: {} });
  expect(reset.values.recapContext).toBe(true); expect(reset.overrides).toEqual({});
});
test('two first saves and two later editors have exactly one winner', async () => {
  const first = await Promise.allSettled([own().save({ revision: 0, values: { recapContext: false } }), own().save({ revision: 0, values: { backgroundReview: false } })]);
  expect(first.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(first.find(result => result.status === 'rejected').reason.code).toBe('CONVERSATION_PREFERENCES_CONFLICT');
  const later = await Promise.allSettled([own().save({ revision: 1, values: {} }), own().save({ revision: 1, values: { recapContext: false } })]);
  expect(later.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await Model.countDocuments()).toBe(1);
});
test('rejects foreign keys, malformed switches and owner selection in the body', async () => {
  for (const body of [{ revision: 0, values: { security: false } }, { revision: 0, values: { recapContext: 'false' } },
    { revision: 0, values: {}, ownerId: 'other' }, { revision: 0, values: { dreamNightHour: 24 } }, { revision: 0, values: { dreamIdleMinutes: 0 } }, { revision: 0, values: { reviewDelaySeconds: '4' } }, { revision: -1, values: {} }, { revision: 0, values: [] }]) {
    await expect(own().save(body)).rejects.toMatchObject({ statusCode: 400 });
  }
  await expect(own('playground').save({ revision: 0, values: { dreamEnabled: false } })).rejects.toMatchObject({ statusCode: 400 });
  expect(await Model.countDocuments()).toBe(0);
});
test('every exposed optional control can be disabled and persists across factories', async () => {
  for (const surface of ['psyx', 'nestor', 'family', 'playground']) {
    const values = Object.fromEntries(catalogFor(surface).map(item => [item.key, item.type === 'number' ? defaultsFor(surface, {})[item.key] : false]));
    await own(surface).save({ revision: 0, values });
    const fresh = createConversationPreferences({ Model, env: {} }).forOwner({ ownerId: 'synthetic-owner', surface });
    expect((await fresh.read()).values).toEqual(values);
  }
});
test('disabling context removes model material, retains stored state, and preserves safety instructions', () => {
  const state = emptyState('synthetic'); state.profile = { about: 'SYNTHETIC_PRIVATE_PROFILE', expectations: 'SYNTHETIC_EXPECTATION' };
  for (const key of ['activeThreads', 'notes', 'patterns', 'hypotheses', 'openLoops', 'goals']) state[key] = [{ text: 'SYNTHETIC_' + key }];
  state.experiments = [{ id: 'fixture', status: 'active', action: 'SYNTHETIC_EXPERIMENT' }];
  state.sessionDigests = [{ summary: 'SYNTHETIC_OLD_SESSION' }];
  state.proposals = [{ kind: 'notes', text: 'SYNTHETIC_PENDING_NOTE' }, { kind: 'experiments', hypothesis: 'SYNTHETIC_PENDING_EXPERIMENT', action: 'SYNTHETIC_ACTION' }];
  const before = JSON.stringify(state), values = Object.fromEntries(catalogFor('psyx').filter(item => item.type !== 'number').map(item => [item.key, false]));
  const selected = selectPsyxState(state, values);
  const prompt = composeSystemContext(selected, normalizeControl({ mode: 'talk' }), { safety: { level: 'crisis' }, features: values });
  expect(prompt).not.toContain('SYNTHETIC_'); expect(prompt).toMatch(/crisis|immediate danger/i);
  expect(require('../../src/domains/psyx/review').reviewMessages({ state: selected, turns: [] })[1].content).not.toContain('SYNTHETIC_');
  expect(JSON.stringify(state)).toBe(before);
});
test('routes bind trusted scope, signal a revision conflict, and do not cache preferences', async () => {
  const app = express(); app.use(express.json());
  registerPreferenceRoutes(app, { base: '/preferences', serviceFor: () => own() });
  const first = await request(app).get('/preferences').expect(200).expect('Cache-Control', 'private, no-store');
  expect(first.body.data.surface).toBe('psyx');
  await request(app).put('/preferences').send({ revision: 0, values: { recapContext: false } }).expect(200);
  await request(app).put('/preferences').send({ revision: 0, values: {} }).expect(409);
  await request(app).put('/preferences').send({ revision: 1, values: {}, surface: 'family' }).expect(400);
});
