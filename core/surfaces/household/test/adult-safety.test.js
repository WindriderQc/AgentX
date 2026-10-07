'use strict';

// In the owner's personal conversation a danger word alone does not replace
// the answer; a sentence describing a present danger still does. Children's
// conversations, self-harm and abuse keep the immediate reply.

const assert = require('node:assert/strict');
const test = require('node:test');
const { assessSafety, escalationReply } = require('../persona-prompt');

const adult = text => assessSafety(text, { adult: true });

test('a danger word in an ordinary adult request leaves the answer to the agent, with a note', () => {
  for (const text of ['Y a-t-il une urgence dans mes courriels ?', 'Quel est le niveau de danger des orages demain ?',
    'Is there any emergency in my inbox?', 'Ajoute « extincteur de feu » à la liste.']) {
    const safety = adult(text);
    assert.equal(safety.deterministicEscalation, false, text);
    assert.deepEqual(safety.flagIds.filter(id => id === 'immediate_danger'), ['immediate_danger'], 'the flag is still recorded');
    assert.match(safety.advisoryNote, /begin by telling him to call 911 now\. Otherwise answer his request normally/);
  }
});

test('an adult sentence describing a present danger still gets the immediate reply', () => {
  for (const text of ['C’est une urgence, appelle une ambulance', 'Il y a le feu dans la cuisine', 'Je saigne beaucoup',
    'Mon fils est en danger', 'I can’t breathe', 'Appelle le 911']) {
    const safety = adult(text.replace(/’/g, "'"));
    assert.equal(safety.deterministicEscalation, true, text);
    assert.equal(safety.advisoryNote, '');
    assert.match(escalationReply({ childSafe: false }, safety), /appelle le 911 maintenant/);
  }
});

test('self-harm and abuse are immediate for an adult too, whatever other words appear', () => {
  assert.equal(adult('Je veux mourir').deterministicEscalation, true);
  const mixed = adult('Il me menace, est-ce une urgence ?');
  assert.equal(mixed.deterministicEscalation, true);
  assert.equal(mixed.advisoryNote, '');
});

test('a child conversation keeps the immediate reply on a danger word alone', () => {
  for (const safety of [assessSafety('Y a-t-il une urgence ?'), assessSafety('Y a-t-il une urgence ?', { adult: false })]) {
    assert.equal(safety.deterministicEscalation, true);
    assert.equal(safety.advisoryNote, '');
  }
});

test('a request without any flag has no note', () => {
  const safety = adult('Quel temps fait-il ?');
  assert.deepEqual(safety.flagIds, []);
  assert.equal(safety.advisoryNote, '');
});
