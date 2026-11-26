'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('an instance style is read once and applies only to family presentation', t => {
  const file = path.resolve(__dirname, '../family-style.txt');
  const style = 'Use the calm rhythm of a story read aloud.';
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (source, ...args) => {
    if (source !== file) return read(source, ...args);
    reads++;
    return style + '\n';
  });

  const { FAMILY_TONE, FAMILY_SURFACE_CONTRACT } = require('../family-context');
  const { packById } = require('../packs');
  const { familyToolset } = require('../family-tools');
  assert.ok(FAMILY_TONE.startsWith(style + ' '));
  assert.match(FAMILY_TONE, /demande à l’enfant de préciser ce mot avant de choisir un outil/);
  assert.match(FAMILY_TONE, /sans le résultat correspondant/);
  assert.match(FAMILY_TONE, /Fun never overrides accuracy or the safety rules/);
  assert.ok(FAMILY_SURFACE_CONTRACT.endsWith(FAMILY_TONE));
  for (const id of ['kidx_nestor', 'kidx_reader']) {
    assert.ok(packById(id).childSafe);
    assert.ok(packById(id).systemPrompt.endsWith(FAMILY_TONE));
  }
  assert.ok(!packById('personal_operator').systemPrompt.includes(style));
  assert.equal(familyToolset({}), null);
  assert.deepEqual(familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'source_read,personal_memory' }).names, ['source_read']);
  assert.equal(reads, 1);
});
