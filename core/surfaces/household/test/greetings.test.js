'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { greetingFor, wakeReply, partOfDay } = require('../public/greetings');

test('Nestor greets warmly, in French by default, and says how to wake him in wake-word mode', () => {
  assert.equal(greetingFor({ space: 'family', hour: 9, pick: () => 0 }), 'Bon matin la famille ! Je t’écoute !');
  assert.equal(greetingFor({ space: 'family', hour: 9, wakeWord: true, pick: () => 0 }),
    'Bon matin la famille ! Dis « Hey Nestor » quand tu veux me parler.');
  assert.equal(greetingFor({ space: 'personal', hour: 20, pick: () => 0 }), 'Bonsoir ! Qu’est-ce que je peux faire pour toi ? Je t’écoute !');
  assert.equal(greetingFor({ space: 'personal', language: 'en', hour: 14, pick: () => 0 }), 'Hi! Here I am. What are we tackling? I’m listening!');
  assert.doesNotMatch(greetingFor(), /I am ready|Je suis prêt/);
});

test('the same greeting or wake reply never comes twice in a row', () => {
  let previous = '';
  for (let i = 0; i < 6; i += 1) {
    const next = greetingFor({ space: 'family', hour: 14, previous, pick: () => 0 });
    assert.notEqual(next, previous);
    previous = next;
  }
  let reply = '';
  for (let i = 0; i < 6; i += 1) {
    const next = wakeReply({ previous: reply, pick: () => 0.99 });
    assert.notEqual(next, reply);
    reply = next;
  }
  assert.ok(['Yes?', 'I’m listening!', 'I’m here!', 'Tell me!'].includes(wakeReply({ language: 'en' })));
});

test('the time of day picks the opening', () => {
  assert.deepEqual([6, 12, 19, 2].map(partOfDay), ['morning', 'day', 'evening', 'night']);
});
