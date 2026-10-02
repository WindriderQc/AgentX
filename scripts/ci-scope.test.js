'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scope, CORE_ASSET_CONSUMERS } = require('./ci-scope.cjs');

const sorted = set => [...set].sort();

test('documentation-only changes run nothing', () => {
  const result = scope(['docs/STATUS.md', 'core/README.md']);
  assert.deepEqual(sorted(result.services), []);
  assert.equal(result.compose, false);
});

test('a service change runs only that service', () => {
  const result = scope(['benchmark/src/services/x.js', 'benchmark/tests/x.test.js']);
  assert.deepEqual(sorted(result.services), ['benchmark']);
  assert.equal(result.compose, false);
});

test('integrations and skills are tested with core', () => {
  assert.deepEqual(sorted(scope(['integrations/coding/a.py']).services), ['core']);
  assert.deepEqual(sorted(scope(['skills/x/SKILL.js']).services), ['core']);
});

test('shared or root changes run every service and compose', () => {
  const result = scope(['shared/embeddingModels.js']);
  assert.deepEqual(sorted(result.services), ['benchmark', 'core', 'data', 'rag']);
  assert.equal(result.compose, true);
});

test('runtime packaging changes run compose', () => {
  assert.equal(scope(['core/Dockerfile']).compose, true);
  assert.equal(scope(['core/package-lock.json']).compose, true);
  assert.equal(scope(['docker-compose.yml']).compose, true);
  assert.equal(scope(['core/src/app.js']).compose, false);
});

test('core assets copied into Benchmark and RAG images run those services and compose', () => {
  for (const file of [
    'core/views/partials/x.ejs',
    'core/views/layouts/main.ejs',
    'core/src/frontend/shared-utils.js',
    'core/src/frontend/shared-tokens.css',
    'core/public/css/platform-chrome.css',
    'core/public/js/utils/toast.js'
  ]) {
    const result = scope([file]);
    assert.deepEqual(sorted(result.services), ['benchmark', 'core', 'rag'], file);
    assert.equal(result.compose, true, file);
  }
});

test('core files not copied into Benchmark or RAG stay core only', () => {
  for (const file of ['core/public/js/utils/not-shipped.js', 'core/views/pages/x.ejs', 'core/src/frontend/signal-evidence.js', 'core/views/partials-old/x.ejs']) {
    const result = scope([file]);
    assert.deepEqual(sorted(result.services), ['core'], file);
    assert.equal(result.compose, false, file);
  }
});

test('core asset sources are read from both Dockerfiles', () => {
  for (const { service, sources } of CORE_ASSET_CONSUMERS) {
    assert.ok(sources.includes('core/views/partials'), service);
    assert.ok(sources.includes('core/public/js/utils/polling-controller.js'), service);
  }
});
