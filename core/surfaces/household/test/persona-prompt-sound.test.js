'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { systemPromptFor, turnDirective } = require('../persona-prompt');

const SOUND = { id: 'elephant', kind: 'recording', label: { en: 'an elephant', fr: 'un éléphant' } };
const EFFECT = { id: 'dragon', kind: 'effect', label: { en: 'a dragon', fr: 'un dragon' } };

test('the sound introduction is written only in the turn language, French by default', () => {
  const french = systemPromptFor(null, { sound: SOUND, latestUserText: 'Est-ce que tu me ferais un son d\'éléphant?' });
  assert.match(french, /Son : un vrai enregistrement \(un éléphant\) joue dès que tu as fini/);
  assert.doesNotMatch(french, /Sound:/);
  const english = systemPromptFor(null, { sound: SOUND, latestUserText: 'Can you play the sound of an elephant?' });
  assert.match(english, /Sound: a real recording of an elephant plays as soon as you finish/);
  assert.doesNotMatch(english, /Son :/);
  const unclear = systemPromptFor(null, { sound: EFFECT, latestUserText: 'Dragon!' });
  assert.match(unclear, /Son : un bruitage imaginaire \(un dragon\) joue/);
  assert.doesNotMatch(unclear, /Sound:/);
});

test('no timing phrase the model could recite to the child is left in the sound directive', () => {
  for (const [sound, text] of [[SOUND, "Fais-moi le bruit de l'éléphant"], [SOUND, 'Play the elephant sound'], [EFFECT, 'Dragon!']]) {
    const prompt = systemPromptFor(null, { sound, latestUserText: text });
    assert.doesNotMatch(prompt, /juste après|right after|est proposé|is offered/);
  }
});

test('the sound introduction is a directive of its own, absent from the turn reference data', () => {
  const context = { sound: SOUND, latestUserText: "Fais-moi le bruit de l'éléphant" };
  assert.match(turnDirective(context), /^Son : un vrai enregistrement \(un éléphant\) joue dès que tu as fini/);
  assert.doesNotMatch(systemPromptFor(null, { ...context, contextOnly: true }), /Son :/);
  assert.equal(turnDirective({ latestUserText: 'Bonjour' }), '');
});
