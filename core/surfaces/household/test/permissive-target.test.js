'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PACKS, inferenceTargetForMode } = require('../packs');

const pack = PACKS.find(entry => entry.id === 'personal_operator');
const open = pack.modes.find(mode => mode.id === 'open');
const env = { HOUSEHOLD_PERMISSIVE_PRIMARY_HOST_URL: 'http://inference-host:11434/' };

test('the Open lane runs the Abliterated model the operator named', () => {
  assert.deepEqual(inferenceTargetForMode(pack, open, env, 196608, 'open-model:27b'), {
    tier: 'primary', hostKey: 'primary', model: 'open-model:27b', hostUrl: 'http://inference-host:11434', numCtx: 196608
  });
});

test('the Open lane names no built-in model and says where to choose one', () => {
  assert.throws(() => inferenceTargetForMode(pack, open, env, null, null),
    { code: 'PRINCIPAL_ABLITERATED_UNSET', statusCode: 503, message: /Nerve Center/ });
});
