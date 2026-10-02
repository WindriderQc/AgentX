'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { voiceRecallOptions } = require('../voice-note-recall');

test('personal voice keeps casual topics out of one-word note lookup', () => {
  assert.deepEqual(voiceRecallOptions('Le hockey, pourquoi pas', true, 25), { limit: 4, minMatchedTerms: 2 });
  assert.deepEqual(voiceRecallOptions('Hockey.', true, 25), { limit: 4, minMatchedTerms: 2 });
});

test('an explicit personal question can still retrieve a note by one topic', () => {
  for (const utterance of ['Rappelle-moi mon budget', 'Que sais-tu de mes notes ?', 'Quel est mon budget ?']) {
    assert.deepEqual(voiceRecallOptions(utterance, true, 25), { limit: 4, minMatchedTerms: 1 });
  }
  assert.deepEqual(voiceRecallOptions('Hockey.', false, 25), { limit: 25 });
});
