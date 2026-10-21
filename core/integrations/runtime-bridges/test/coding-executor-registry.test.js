'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const registry = require('../coding-executor-registry');

test('registry accepts a bounded ordered multiharness pool', () => {
  const rows = registry.fromEnvironment({ CODING_EXECUTORS_JSON: JSON.stringify([
    { id: 'slow', harness: 'dsh', sshTarget: 'worker@slow', priority: 20 },
    { id: 'fast', harness: 'opencode', sshTarget: 'worker@fast', priority: 10, profiles: ['code'] },
  ]) });
  assert.deepEqual(rows.map(row => [row.id, row.harness, row.capacity]),
    [['fast', 'opencode', 1], ['slow', 'dsh', 1]]);
  assert.deepEqual(rows[0].profiles, ['code']);
});

test('registry preserves the legacy single DSH executor', () => {
  const [row] = registry.fromEnvironment({ CODING_DISPATCHER_SSH_TARGET: 'worker@host',
    CODING_DISPATCHER_REMOTE_ROOT: '/srv/product' });
  assert.deepEqual({ id: row.id, harness: row.harness, target: row.sshTarget, root: row.remoteRoot },
    { id: 'default', harness: 'dsh', target: 'worker@host', root: '/srv/product' });
});

test('registry rejects duplicate ids and malformed capabilities', () => {
  assert.throws(() => registry.fromEnvironment({ CODING_EXECUTORS_JSON: '[{"id":"same","harness":"dsh","sshTarget":"a@one"},{"id":"same","harness":"dsh","sshTarget":"a@two"}]' }));
  assert.throws(() => registry.fromEnvironment({ CODING_EXECUTORS_JSON: '[{"id":"one","harness":"dsh","sshTarget":"a@one"},{"id":"two","harness":"opencode","sshTarget":"a@one"}]' }));
  assert.throws(() => registry.fromEnvironment({ CODING_EXECUTORS_JSON: '[{"id":"bad","harness":"dsh","sshTarget":"a@one","profiles":["unknown"]}]' }));
  assert.throws(() => registry.fromEnvironment({ CODING_EXECUTORS_JSON: '{"id":"not-an-array"}' }));
});

test('programmatic registries enforce the same duplicate host rules', () => {
  assert.throws(() => registry.normalizeAll([
    { id: 'first', harness: 'dsh', sshTarget: 'worker@same' },
    { id: 'second', harness: 'opencode', sshTarget: 'worker@same' },
  ]), error => error.code === 'CODING_EXECUTOR_CONFIGURATION_INVALID');
});
