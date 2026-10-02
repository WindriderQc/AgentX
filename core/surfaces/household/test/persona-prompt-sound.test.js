'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { systemPromptFor } = require('../persona-prompt');

const SOUND = { id: 'elephant', kind: 'recording', label: { en: 'an elephant', fr: 'un éléphant' } };
const EFFECT = { id: 'dragon', kind: 'effect', label: { en: 'a dragon', fr: 'un dragon' } };

test('the sound introduction is written only in the turn language, French by default', () => {
  const french = systemPromptFor(null, { sound: SOUND, latestUserText: 'Est-ce que tu me ferais un son d\'éléphant?' });
  assert.match(french, /Son : un vrai enregistrement \(un éléphant\)/);
  assert.doesNotMatch(french, /Sound:/);
  const english = systemPromptFor(null, { sound: SOUND, latestUserText: 'Can you play the sound of an elephant?' });
  assert.match(english, /Sound: a real recording of an elephant/);
  assert.doesNotMatch(english, /Son :/);
  const unclear = systemPromptFor(null, { sound: EFFECT, latestUserText: 'Dragon!' });
  assert.match(unclear, /Son : un bruitage imaginaire \(un dragon\)/);
  assert.doesNotMatch(unclear, /Sound:/);
});
