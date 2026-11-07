'use strict';
const express = require('express');
const request = require('supertest');
const Model = require('../../models/ConversationPreferences');
const { createConversationPreferences } = require('../../src/services/conversationPreferences/service');
const { catalogFor, defaultsFor } = require('../../src/services/conversationPreferences/catalog');
const { registerPreferenceRoutes } = require('../../src/services/conversationPreferences/routes');
const store = createConversationPreferences({ Model, env: {} });
const own = (surface = 'nestor', ownerId = 'synthetic-owner') => store.forOwner({ ownerId, surface });
beforeEach(async () => { await Model.deleteMany({}); });

test('environment is a bootstrap default, not a persisted preference', async () => {
  expect(defaultsFor('nestor', {})).toMatchObject({ backgroundReview: false, memoryContext: true });
  const first = await own().read(); expect(first.revision).toBe(0); expect(first.values.recapContext).toBe(true);
  expect(await Model.countDocuments()).toBe(0);
});
test('saves, reloads and resets without changing another owner or surface', async () => {
  const saved = await own().save({ revision: 0, values: { backgroundReview: false, recapContext: false } });
  expect(saved.values.backgroundReview).toBe(false); expect(saved.revision).toBe(1);
  expect((await own().read()).values.recapContext).toBe(false);
  expect((await own('nestor', 'other').read()).values.recapContext).toBe(true);
  expect((await own('playground').read()).values.historyContext).toBe(true);
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
    { revision: 0, values: {}, ownerId: 'other' }, { revision: 0, values: { reviewDelaySeconds: '4' } }, { revision: -1, values: {} }, { revision: 0, values: [] }]) {
    await expect(own().save(body)).rejects.toMatchObject({ statusCode: 400 });
  }
  await expect(own('playground').save({ revision: 0, values: { unregisteredOption: false } })).rejects.toMatchObject({ statusCode: 400 });
  expect(await Model.countDocuments()).toBe(0);
});
test('every exposed optional control can be disabled and persists across factories', async () => {
  for (const surface of ['nestor', 'family', 'playground']) {
    const values = Object.fromEntries(catalogFor(surface).map(item => [item.key, ['number', 'enum'].includes(item.type) ? defaultsFor(surface, {})[item.key] : false]));
    await own(surface).save({ revision: 0, values });
    const fresh = createConversationPreferences({ Model, env: {} }).forOwner({ ownerId: 'synthetic-owner', surface });
    expect((await fresh.read()).values).toEqual(values);
  }
});
test('Nestor stores only configured inference profiles and keeps family and other surfaces independent', async () => {
  const env = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'test-guardian',
    PERSONAL_CONVERSATION_WORK_AGENT_ID: 'test-worker', PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-private-work-binding-token',
    PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL: 'synthetic-cloud/deep-model', PERSONAL_CONVERSATION_CLOUD_GUARDIAN_MODEL: 'synthetic-cloud/fast-model' };
  const selected = createConversationPreferences({ Model, env }).forOwner({ ownerId: 'profile-owner', surface: 'nestor' });
  expect((await selected.read()).values.inferenceProfile).toBe('local');
  for (const [revision, value] of ['boss_cloud', 'full_cloud', 'local'].entries()) {
    expect((await selected.save({ revision, values: { inferenceProfile: value } })).values.inferenceProfile).toBe(value);
  }
  for (const value of [false, {}, 'synthetic-cloud/arbitrary-model', 'guardian_cloud']) {
    await expect(selected.save({ revision: 3, values: { inferenceProfile: value } })).rejects.toMatchObject({ statusCode: 400 });
  }
  await expect(own('nestor').save({ revision: 0, values: { inferenceProfile: 'boss_cloud' } })).rejects.toMatchObject({ statusCode: 400 });
  await expect(own('family').save({ revision: 0, values: { inferenceProfile: 'full_cloud' } })).rejects.toMatchObject({ statusCode: 400 });
  expect((await own('family').read()).catalog.some(item => item.key === 'inferenceProfile')).toBe(false);
});
test('routes bind trusted scope, signal a revision conflict, and do not cache preferences', async () => {
  const app = express(); app.use(express.json());
  registerPreferenceRoutes(app, { base: '/preferences', serviceFor: () => own() });
  const first = await request(app).get('/preferences').expect(200).expect('Cache-Control', 'private, no-store');
  expect(first.body.data.surface).toBe('nestor');
  await request(app).put('/preferences').send({ revision: 0, values: { recapContext: false } }).expect(200);
  await request(app).put('/preferences').send({ revision: 0, values: {} }).expect(409);
  await request(app).put('/preferences').send({ revision: 1, values: {}, surface: 'family' }).expect(400);
});
