'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { profileField, resolveProfile } = require('../../../src/services/conversationWorks/performance');

const env = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'synthetic-guardian',
  PERSONAL_CONVERSATION_WORK_AGENT_ID: 'synthetic-worker', PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-private-work-binding-token',
  PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL: 'synthetic-cloud/deep-model', PERSONAL_CONVERSATION_CLOUD_GUARDIAN_MODEL: 'synthetic-cloud/fast-model' };

test('model profiles keep local defaults and independently select the native guardian and complete brain', () => {
  assert.deepEqual(resolveProfile(undefined, {}), { profile: 'local', guardian: {}, boss: {} });
  assert.deepEqual(resolveProfile('boss_cloud', env), { profile: 'boss_cloud', guardian: {}, boss: { model: 'synthetic-cloud/deep-model' } });
  assert.deepEqual(resolveProfile('full_cloud', env), { profile: 'full_cloud', guardian: { model: 'synthetic-cloud/fast-model' }, boss: { model: 'synthetic-cloud/deep-model' } });
});

test('cloud profiles need native work, a separate guardian and valid configured model references', () => {
  for (const patch of [{ PERSONAL_CONVERSATION_WORK_MODE: 'read' }, { PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'main' },
    { PERSONAL_CONVERSATION_WORK_TOKEN: '' }, { PERSONAL_CONVERSATION_WORK_AGENT_ID: 'main' },
    { PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'family' }, { PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL: '' },
    { PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL: 'https://external.invalid/model' }]) {
    const modified = { ...env, ...patch };
    assert.equal(profileField(modified).choices.find(choice => choice.value === 'boss_cloud').disabled, true);
    assert.throws(() => resolveProfile('boss_cloud', modified), error => error.code === 'CONVERSATION_INFERENCE_PROFILE_UNAVAILABLE');
  }
  const brainOnly = { ...env, PERSONAL_CONVERSATION_CLOUD_GUARDIAN_MODEL: '' };
  assert.equal(resolveProfile('boss_cloud', brainOnly).boss.model, env.PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL);
  assert.throws(() => resolveProfile('full_cloud', brainOnly), error => error.statusCode === 409);
});
