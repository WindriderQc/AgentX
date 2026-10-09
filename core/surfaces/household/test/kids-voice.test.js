'use strict';

// #261: Kids Room and Lecture read aloud with Nestor's personality voice, so an
// instance voice for him applies there as it does in Famille. They use the
// voice ladder the conversations already use, not a list of their own.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const personaCatalog = require('../persona-catalog');
const P = require('../public/persona-presentation');

const nestor = personaCatalog.generatedPersonas().find(row => row.name === 'nestor');
const snapshotWith = env => {
  const previous = process.env.HOUSEHOLD_PERSONA_VOICES;
  if (env === undefined) delete process.env.HOUSEHOLD_PERSONA_VOICES; else process.env.HOUSEHOLD_PERSONA_VOICES = env;
  try { return personaCatalog.snapshot({ ...nestor, version: 1, _id: 'catalog' }); }
  finally { if (previous === undefined) delete process.env.HOUSEHOLD_PERSONA_VOICES; else process.env.HOUSEHOLD_PERSONA_VOICES = previous; }
};
const keys = choices => choices.map(choice => `${choice.provider}|${choice.voice}`);

test('with Nestor on the conversation, the ladder starts with his voice and honours an instance voice', () => {
  const catalog = snapshotWith(undefined), instance = snapshotWith(JSON.stringify({ nestor: 'voxcpm|synthetic_voice' }));
  assert.deepEqual(keys(P.speechChoices(catalog, 'fr', { selections: {} })), ['kokoro|am_michael:0.50+ff_siwis:0.50']);
  assert.deepEqual(keys(P.speechChoices(catalog, 'en', { selections: {} })), ['kokoro|am_michael']);
  // The instance voice first, then the catalog voice it replaced.
  assert.deepEqual(keys(P.speechChoices(instance, 'fr', { selections: {} })), ['voxcpm|synthetic_voice', 'kokoro|am_michael:0.50+ff_siwis:0.50']);
  assert.deepEqual(keys(P.speechChoices(instance, 'en', { selections: {} })), ['voxcpm|synthetic_voice', 'kokoro|am_michael']);
});

test('a reading voice chosen on the browser still wins, per language', () => {
  const instance = snapshotWith(JSON.stringify({ '*': 'voxcpm|synthetic_voice' }));
  const reading = { selections: { fr: 'kokoro|ff_siwis' } };
  assert.deepEqual(keys(P.speechChoices(instance, 'fr', reading)), ['kokoro|ff_siwis', 'voxcpm|synthetic_voice', 'kokoro|am_michael:0.50+ff_siwis:0.50']);
  assert.deepEqual(keys(P.speechChoices(instance, 'en', reading)), ['voxcpm|synthetic_voice', 'kokoro|am_michael']);
});

test('a conversation without a personality keeps the former reading default', () => {
  assert.deepEqual(keys(P.speechChoices(null, 'fr', { selections: {} })), ['kokoro|ff_siwis']);
  assert.deepEqual(keys(P.speechChoices(undefined, 'en', { selections: {} })), ['kokoro|af_heart']);
});

test('Kids Room and Lecture create Nestor conversations and speak through the shared ladder', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(app, /body: JSON\.stringify\(\{ packId, scopeId, modeId, personaId: 'nestor' \}\)/);
  assert.match(app, /window\.PersonaPresentation\.speechChoices\(state\.session\?\.persona, profile\.language, \{ selections: readingVoices \}\)/);
  // No second, fixed voice choice beside the ladder.
  assert.doesNotMatch(app, /voice: profile\.nativeVoice/);
  // Both pages go through the same speak(); the ladder's script loads before the page script.
  assert.match(app, /await speak\(result\.reply, language\);/);
  assert.match(app, /await speak\(lastReply, 'fr'\);/);
  assert.ok(html.indexOf('persona-presentation.js') > 0 && html.indexOf('persona-presentation.js') < html.indexOf('/app.js'));
});
