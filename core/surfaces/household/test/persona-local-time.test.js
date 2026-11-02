'use strict';

// Nestor knows the household's time on every turn, beside the request, not in the
// stable instructions the prompt cache keeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { localTimeContext, systemPromptFor } = require('../persona-prompt');

test('the turn context carries the household local time with its zone', () => {
  const at = new Date('2026-11-01T19:05:00Z');
  const line = localTimeContext(at, 'America/Toronto');
  assert.match(line, /^\n\nCurrent local time in the household: /);
  assert.match(line, /Sunday/);
  assert.match(line, /November 1, 2026/);
  assert.match(line, /14:05/);
  assert.match(line, /\(America\/Toronto\)\.$/);
  assert.match(localTimeContext(new Date('2026-07-01T04:30:00Z'), 'America/Toronto'), /00:30/, 'summer time, 24-hour');
});

test('the stable instructions never carry the clock', () => {
  assert.doesNotMatch(systemPromptFor(null, { latestUserText: 'Quelle heure est-il?' }), /Current local time/);
  const turn = fs.readFileSync(path.join(__dirname, '../persona-turn.js'), 'utf8');
  assert.match(turn, /systemPromptFor\(pack, \{ \.\.\.context, contextOnly: true \}\), localTimeContext\(\),/);
});
