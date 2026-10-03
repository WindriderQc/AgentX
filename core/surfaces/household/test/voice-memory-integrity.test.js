'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVoixMemoryTurn } = require('../voice-memory-turns');

const payload = () => ({ schemaVersion: 1, sessionId: 'synthetic-session', turnId: 'synthetic-turn',
  eventId: 'voix:synthetic-session:synthetic-turn', sequence: 1, completedAt: '2026-01-01T00:00:00Z',
  userText: ' Original é 🦉 '.repeat(650), assistantText: ' Réponse complète 🦉 '.repeat(650) });

test('completed voice capture preserves Unicode, whitespace and tails beyond the old preview limits', () => {
  const original = payload(), turn = normalizeVoixMemoryTurn(original);
  assert.ok(original.userText.length > 4000 && original.assistantText.length > 5000);
  assert.equal(turn.userText, original.userText);
  assert.equal(turn.assistantText, original.assistantText);
});

test('Core bounds and exact native identities refuse before capture instead of shortening or aliasing', () => {
  for (const field of ['userText', 'assistantText']) {
    assert.equal(normalizeVoixMemoryTurn({ ...payload(), [field]: 'x'.repeat(16000) })[field].length, 16000);
    assert.throws(() => normalizeVoixMemoryTurn({ ...payload(), [field]: 'x'.repeat(16001) }),
      error => error.statusCode === 413 && error.code === 'VOIX_MEMORY_TEXT_TOO_LARGE');
  }
  for (const change of [{ sessionId: 's'.repeat(121) }, { turnId: 't'.repeat(121) },
    { sessionId: ' synthetic-session ' }, { eventId: payload().eventId + ' ' }, { userText: 123 }, { assistantText: '  ' }]) {
    assert.throws(() => normalizeVoixMemoryTurn({ ...payload(), ...change }), error => error.code === 'VOIX_MEMORY_TURN_INVALID');
  }
});
