'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./fixtures/persona-journey.cjs');
const { profile } = require('../public/persona-presentation');

for (const backend of ['agentx', 'openclaw']) {
  for (const packId of ['kidx_nestor', 'kidx_reader', 'personal_operator']) {
    test(`${packId} on ${backend} follows the conversation and an explicit choice`, async () => {
      const { turn, sent } = harness({ packId, backend, response: 'OK', conversationEnv: { HOUSEHOLD_DEFAULT_LANGUAGE: 'fr' } });
      for (const [text, selection, expected] of [
        ['OK', 'auto', 'fr'], ['Hello', 'auto', 'en'], ['OK', 'auto', 'en'],
        ['Hello', 'fr', 'fr'], ['Bonjour', 'en', 'en'], ['Bonjour', 'auto', 'fr']
      ]) {
        const data = await turn(text, 'voice', { language: selection });
        assert.match(sent.at(-1).request, expected === 'en' ? /Reply in English/ : /Réponds en français/);
        assert.equal(data.reply.language, expected);
      }
    });
  }
}
test('a fresh browser follows the conversation and a second installation can start in English', async () => {
  assert.equal(profile({}).language, 'auto');
  assert.equal(profile({ language: 'fr' }).language, 'fr');
  const { turn, sent } = harness({ packId: 'kidx_nestor', backend: 'agentx', response: 'OK',
    conversationEnv: { HOUSEHOLD_DEFAULT_LANGUAGE: 'en' } });
  assert.equal((await turn('OK', 'voice')).reply.language, 'en');
  assert.match(sent[0].request, /Reply in English/);
});
