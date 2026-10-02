'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scope } = require('./ci-scope.cjs');

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
