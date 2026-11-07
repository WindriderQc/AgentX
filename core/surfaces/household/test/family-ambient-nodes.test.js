'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readNodeHints, nodeFor, alertView } = require('../family-ambient-nodes');

const configured = value => readNodeHints({ HOUSEHOLD_ECOSYSTEM_NODE_HINTS_JSON: JSON.stringify(value) });

test('an unconfigured instance has no implicit inventory and retains critical alerts', () => {
  const hints = readNodeHints({});
  assert.deepEqual(hints, []);
  assert.equal(nodeFor('disk:gpu-host.example', hints), null);
  assert.deepEqual(alertView({ findings: [
    { key: 'disk:gpu-host.example', severity: 'attention' },
    { key: 'power:unknown', severity: 'critical', text: 'private detail' }
  ] }, hints), { at: null, fingerprint: null, count: 1, critical: 1, nodes: [] });
});

test('configured host hints are case-insensitive and never reach the screen', () => {
  const hints = configured({ compute: ['GPU-HOST.EXAMPLE', '192.168.50.10'] });
  assert.equal(nodeFor('alert:gpu-host.example:hot', hints), 'compute');
  assert.equal(nodeFor('alert:COMPUTE:hot', hints), 'compute');
  const view = alertView({ findings: [
    { key: 'disk:192.168.50.10', severity: 'attention', text: 'private alert' }
  ] }, hints);
  assert.deepEqual(view.nodes, ['compute']);
  assert.equal(view.count, 1);
  assert.doesNotMatch(JSON.stringify(view), /192\.168|gpu-host|private alert/);
});

test('specific matches keep their configured order and visits remain bounded', () => {
  const hints = configured({ primary: ['gpu-1'], fleet: ['gpu'], third: ['host-3'], fourth: ['host-4'] });
  assert.equal(nodeFor('gpu-1', hints), 'primary');
  assert.deepEqual(alertView({ findings: ['gpu-1', 'gpu-2', 'host-3', 'host-4'].map(key => ({
    key, severity: 'attention'
  })) }, hints).nodes, ['primary', 'fleet', 'third']);
});

test('malformed or excessive mappings fail closed without logging their contents', () => {
  for (const value of [null, [], { '../private': ['a'] }, { node: [] }, { node: [''] },
    { node: [42] }, { node: ['x'.repeat(201)] }, { node: Array(17).fill('host') },
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['node' + i, ['host']]))]) {
    assert.deepEqual(configured(value), []);
  }
  const warnings = [];
  for (const raw of ['not json private-host', 'x'.repeat(16385)]) {
    assert.deepEqual(readNodeHints({ HOUSEHOLD_ECOSYSTEM_NODE_HINTS_JSON: raw },
      { warn: message => warnings.push(message) }), []);
  }
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(warnings.join(' '), /private-host/);
});
