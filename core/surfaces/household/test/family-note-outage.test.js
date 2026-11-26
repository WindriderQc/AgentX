'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./fixtures/persona-journey.cjs');

test('local Family can explain tides or report a note outage through the same turn path', async () => {
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx', failContext: key => {
    if (key === 'note_search') throw new Error('synthetic note outage');
  } });
  for (const question of ['Explique-moi les marées.', 'Quelle note est-ce que je t’avais demandé de garder ?']) {
    const out = await h.turn(question, 'voice');
    assert.equal(out.reply.text, 'Réponse synthétique.');
    assert.match(h.sent.at(-1).request, /Family notes could not be read/);
    assert.doesNotMatch(h.sent.at(-1).request, /Saved notes:/);
  }
  assert.equal(h.state.recordedNotes.length, 0);
});
