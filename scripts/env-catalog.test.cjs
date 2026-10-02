'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { compare, parseCompose, parseReference, scan } = require('./env-catalog.cjs');

test('parses compose environment blocks per service', () => {
  const services = parseCompose([
    'services:',
    '  core:',
    '    image: x',
    '    environment:',
    '      FIXED: http://mongo:27017',
    '      OPT_IN: ${OPT_IN:-}',
    '      WITH_DEFAULT: "${WITH_DEFAULT:-auto}"',
    '    ports:',
    '      - "3080:3080"',
    '  rag:',
    '    environment:',
    '      RENAMED: ${HOST_NAME:-x}',
    'volumes:',
    '  data:',
  ].join('\n'));
  assert.deepEqual(services.core, { FIXED: 'http://mongo:27017', OPT_IN: '${OPT_IN:-}', WITH_DEFAULT: '${WITH_DEFAULT:-auto}' });
  assert.deepEqual(services.rag, { RENAMED: '${HOST_NAME:-x}' });
  assert.equal(services.data, undefined);
});

test('reads references, defaults and templates', () => {
  assert.equal(parseReference('http://mongo:27017'), null);
  assert.deepEqual(parseReference('${OPT_IN:-}'), { hostVar: 'OPT_IN', default: '' });
  assert.deepEqual(parseReference('${OPT_IN}'), { hostVar: 'OPT_IN', default: null });
  assert.deepEqual(parseReference('${MODE:-auto}'), { hostVar: 'MODE', default: 'auto' });
  assert.deepEqual(parseReference('http://127.0.0.1:${CORE_PORT:-3180}'), { hostVar: 'CORE_PORT', default: 'http://127.0.0.1:${CORE_PORT:-3180}' });
});

test('flags missing, stale, outdated and undescribed entries', () => {
  const scanned = {
    A: { services: ['core'], forwarded: true, default: null },
    B: { services: ['core'], forwarded: false, default: null },
    C: { services: ['core', 'rag'], forwarded: true, default: 'x' },
  };
  const catalog = { variables: {
    B: { services: ['core'], forwarded: false, default: null, description: '' },
    C: { services: ['core'], forwarded: true, default: 'x', description: '' },
    OLD: { services: ['core'], forwarded: false, default: null, description: 'gone' },
  } };
  assert.deepEqual(compare(scanned, catalog), { missing: ['A'], stale: ['OLD'], undocumented: ['C'], mismatched: ['C'] });
});

test('shared/envCatalog.json matches the code and compose, and every forwarded setting is described', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'envCatalog.json'), 'utf8'));
  const drift = compare(scan(), catalog);
  assert.deepEqual(drift, { missing: [], stale: [], undocumented: [], mismatched: [] },
    'Run node scripts/env-catalog.cjs --write, then describe the new entries.');
});
