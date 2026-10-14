'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { workResultPresentation } = require('../work-result-presentation');
const { createWorkDelivery } = require('../../../src/services/conversationWorks/delivery');

test('a native document has a useful spoken summary and complete display and reading views', async () => {
  const summary = 'Voici le plan : préparer les données, vérifier les résultats, puis publier.';
  const document = 'Explication détaillée du document. '.repeat(100) + 'DERNIER MOT';
  const original = { kind: 'answer', text: summary + '\n<show kind="text" title="Plan">' + document + '</show>', receiptIds: ['retained-receipt'] };
  const copy = JSON.stringify(original);
  const view = workResultPresentation(original);
  assert.equal(view.spokenText, summary);
  assert.ok(view.displayText.includes(document));
  assert.ok(view.readingText.includes(summary));
  assert.ok(view.readingText.includes(document));
  assert.doesNotMatch(view.readingText, /<show/);

  const row = { _id: 'native-work', sessionId: 'owner-session', turnId: 'human-turn', state: 'completed',
    result: { payloadRef: 'retained-result', version: 3 }, delivery: { id: 'delivery-3', state: 'available' } };
  const delivery = createWorkDelivery({ repo: { read: async () => original },
    automaticSpeech: async () => true, presentResult: workResultPresentation });
  const projected = await delivery.projection(row);
  assert.equal(projected.result.text, original.text);
  assert.equal(projected.result.spokenText, summary);
  assert.equal(projected.result.displayText, view.displayText);
  assert.equal(projected.result.version, 3);
  assert.equal(projected.result.deliveryId, 'delivery-3');
  assert.equal(projected.result.presentation, 'available');
  assert.equal(JSON.stringify(original), copy, 'projection cannot rewrite the native answer');
});

test('long ordinary explanations remain complete and a document reading never includes a secret', () => {
  const explanation = 'Une explication que la conversation doit pouvoir entendre. '.repeat(100) + 'FIN';
  assert.equal(workResultPresentation({ text: explanation }).spokenText, explanation);
  const source = 'Voici les deux priorités.\n<show kind="list">1. Première\n2. Deuxième\n3. Troisième\n4. Dernière</show>'
    + '\n<show kind="secret">DO_NOT_SPEAK_THIS_SECRET</show>';
  const view = workResultPresentation({ text: source });
  for (const field of ['spokenText', 'readingText', 'displayText']) assert.doesNotMatch(view[field], /DO_NOT_SPEAK/);
  for (const word of ['Première', 'Deuxième', 'Troisième', 'Dernière']) assert.ok(view.readingText.includes(word));
  assert.doesNotMatch(view.spokenText, /Dernière/);
});

test('English list fallback speaks its useful items in English and keeps every item available', () => {
  const source = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((word, index) => `${index + 1}. ${word}`).join('\n');
  const view = workResultPresentation({ text: source }, { language: 'en' });
  assert.match(view.spokenText, /Alpha/);
  assert.doesNotMatch(view.spokenText, /écran|premiers/);
  assert.ok(view.displayText.includes('Echo'));
  assert.ok(view.readingText.includes('Echo'));
});
