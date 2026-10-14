'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePrincipalAlias } = require('../principal-model');
const { studioSettings, studioPatch, settingsPatch } = require('../../../../integrations/coding/dsh-studio-settings.cjs');

test('a following consumer resolves the current concrete model and preserves the full context', () => {
  for (const model of ['standard', 'abliterated']) {
    const target = resolvePrincipalAlias({ tasks: { daily_operator: { model, contextSize: 196608, hostUrl: 'http://model-host' } } }, 'agentx-primary');
    assert.equal(target.model, model);
    assert.equal(target.numCtx, 196608);
  }
  assert.equal(resolvePrincipalAlias({ tasks: {} }, 'explicit-standard'), null);
  assert.throws(() => resolvePrincipalAlias({ tasks: {} }, 'agentx-primary'), { code: 'PRINCIPAL_MODEL_UNAVAILABLE' });
});

test('Studio launch overlays preserve preferences, principal context and optional browser configuration', () => {
  const source = { 'ui-onboarding': { welcomeNoticeVersion: 'original' } };
  const plain = studioPatch(source, 'http://core-host:3180', 196608);
  assert.deepEqual(settingsPatch(source), [{ id: 'ui-settings-general', config: source['ui-onboarding'] }]);
  assert.equal(plain.some(row => row.id === 'ui-settings-general'), false);
  assert.equal(plain.find(row => row.id === 'llm-pi-ai').config.providers['agentx-core'].models[0].contextWindow, 196608);
  assert.equal(plain.some(row => row.insert), false);
  const browser = studioPatch(source, 'http://core-host:3180', 196608, '/opt/chromium/chrome').at(-1).insert;
  assert.equal(browser[1].config.executablePath, '/opt/chromium/chrome');
  assert.equal(browser[1].config.headless, true);
  assert.deepEqual(source, { 'ui-onboarding': { welcomeNoticeVersion: 'original' } });
});

test('Studio settings keep native preferences and use the existing Core gateway', () => {
  const original = { 'agent-default-model': { provider: 'old', model: 'standard' },
    theme: 'dark', 'llm-pi-ai': { providers: { old: { baseURL: 'http://direct-model-host' } }, setting: true } };
  const result = studioSettings(original, 'http://core-host:3180', 196608);
  assert.equal(result.theme, 'dark');
  assert.equal(result['llm-pi-ai'].setting, true);
  assert.equal(result['llm-pi-ai'].providers['agentx-core'].baseURL, 'http://core-host:3180/api/hermes-openai/v1');
  assert.deepEqual(result['agent-default-model'], { provider: 'agentx-core', model: 'agentx-primary' });
  assert.equal(original['agent-default-model'].provider, 'old');
  assert.throws(() => studioSettings(original, 'http://core-host', null), /context/);
});
