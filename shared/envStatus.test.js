'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildEnvStatus, describeVariable, redactValue, summarizeForLog } = require('./envStatus');

const CATALOG = {
  version: 1,
  variables: {
    FALLBACK_TASK: { services: ['core'], forwarded: true, default: null, category: 'routing', secret: false, description: 'Ladder task.' },
    FACE_ENABLED: { services: ['core'], forwarded: true, default: 'false', category: 'household', secret: false, description: 'Synthetic camera flag.' },
    BRIDGE_TOKEN: { services: ['core'], forwarded: true, default: null, category: 'bridges', secret: true, description: 'Bridge token.' },
    GATEWAY_URL: { services: ['core'], forwarded: true, default: null, category: 'bridges', secret: false, description: '' },
    SNEAKY_PASSWORD: { services: ['core'], forwarded: false, default: null, category: 'other', secret: false, description: '' },
    BENCH_ONLY: { services: ['benchmark'], forwarded: true, default: '1', category: 'benchmark', secret: false, description: 'x' },
  },
};

test('classifies custom, default and off, per service', () => {
  const status = buildEnvStatus({
    service: 'core',
    catalog: CATALOG,
    env: { FALLBACK_TASK: 'nestor_answer_light', FACE_ENABLED: 'false', BRIDGE_TOKEN: 'abc123', GATEWAY_URL: '' },
  });
  const by = Object.fromEntries(status.variables.map((v) => [v.name, v]));
  assert.equal(by.FALLBACK_TASK.state, 'custom');
  assert.equal(by.FALLBACK_TASK.value, 'nestor_answer_light');
  assert.equal(by.FACE_ENABLED.state, 'default');
  assert.equal(by.GATEWAY_URL.state, 'off');
  assert.equal(by.BENCH_ONLY, undefined);
  assert.deepEqual(status.summary, { total: 5, custom: 2, default: 1, off: 2, undocumented: 2 });
});

test('never exposes secret values, even when the catalog forgets the flag', () => {
  const token = describeVariable('BRIDGE_TOKEN', CATALOG.variables.BRIDGE_TOKEN, { BRIDGE_TOKEN: 'abc123' });
  assert.equal(token.set, true);
  assert.equal(token.value, null);
  const sneaky = describeVariable('SNEAKY_PASSWORD', CATALOG.variables.SNEAKY_PASSWORD, { SNEAKY_PASSWORD: 'hunter2' });
  assert.equal(sneaky.secret, true);
  assert.equal(sneaky.value, null);
  assert.ok(!JSON.stringify(buildEnvStatus({ service: 'core', catalog: CATALOG, env: { BRIDGE_TOKEN: 'abc123', SNEAKY_PASSWORD: 'hunter2' } })).includes('hunter2'));
});

test('strips credentials from URLs and bounds long values', () => {
  assert.equal(redactValue('mongodb://user:pw@mongo:27017/db'), 'mongodb://***@mongo:27017/db');
  assert.equal(redactValue('x'.repeat(500)).length, 240);
});

test('startup summary names the instance-env options left unset', () => {
  const line = summarizeForLog(buildEnvStatus({ service: 'core', catalog: CATALOG, env: { FALLBACK_TASK: 'x' } }));
  assert.match(line, /^Configuration \(core\): 1 customized, 1 default, 3 not configured; instance-env options left unset: BRIDGE_TOKEN, GATEWAY_URL$/);
});

test('the real catalog loads and covers core', () => {
  const status = buildEnvStatus({ service: 'core', env: {} });
  assert.ok(status.summary.total > 50);
  assert.ok(status.variables.every((v) => ['custom', 'default', 'off'].includes(v.state)));
});

test('a documented code fallback counts as default, not as an off switch', () => {
  const catalog = { version: 1, variables: {
    UI_MODE: { services: ['core'], forwarded: true, default: null, category: 'bridges', secret: false, description: 'x', fallback: 'direct' },
    FEATURE_URL: { services: ['core'], forwarded: true, default: null, category: 'network', secret: false, description: 'y' },
  } };
  const by = Object.fromEntries(buildEnvStatus({ service: 'core', catalog, env: {} }).variables.map((v) => [v.name, v]));
  assert.equal(by.UI_MODE.state, 'default');
  assert.equal(by.UI_MODE.fallback, 'direct');
  assert.equal(by.FEATURE_URL.state, 'off');
  assert.equal(by.FEATURE_URL.fallback, null);
});
