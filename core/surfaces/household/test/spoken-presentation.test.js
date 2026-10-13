'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../../public/js/voice/spoken-presentation');

test('ordinary reply boundaries include three sentences or 600 characters and introduce beyond either', () => {
  for (const text of ['Une. Deux. Trois.', 'a'.repeat(600), 'Dr. Exemple parle. Il dit 3.5. Merci.']) {
    assert.equal(P.isLongReply(text), false, text);
    assert.equal(P.ordinarySpeech(text), text);
  }
  for (const text of ['Une. Deux. Trois. Quatre.', 'a'.repeat(601), 'Une. Deux. Trois. Quatrième phrase en cours']) {
    assert.equal(P.isLongReply(text), true);
    assert.match(P.ordinarySpeech(text), /texte complet est à l’écran/);
    assert.equal(P.ordinarySpeech(text, { readAloud: true }), text);
  }
  assert.match(P.ordinarySpeech('a'.repeat(601), { language: 'en' }), /complete text is on screen/);
});

test('explicit readings and safety resources bypass ordinary summary limits', () => {
  const full = 'Une longue explication. '.repeat(500) + ' Appelle le 988.';
  assert.equal(P.ordinarySpeech(full), full);
  assert.equal(P.ordinarySpeech('a'.repeat(1000), { preserveSafety: true }), 'a'.repeat(1000));
  for (const request of ['Lis-moi la réponse complète', 'Peux-tu me lire le texte?', 'Read the complete response', 'Could you read this aloud?']) {
    assert.equal(P.readingRequested(request), true);
  }
  assert.equal(P.readingRequested('Explique-moi ce texte'), false);
});

test('streamed and complete prose have the same short introduction and retain every word on screen', () => {
  const text = 'Voici le contexte. '.repeat(100) + 'FIN';
  for (const size of [1, 7, 109, text.length]) {
    const said = [], shown = [];
    const p = P.create({ onSay: value => said.push(value), onShow: value => shown.push(value) });
    for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size));
    p.end(); p.end(); p.push('late');
    assert.equal(said.join(''), P.ordinarySpeech(text));
    assert.equal(shown.at(-1), text);
  }
});

test('late safety content is fully audible even after a long ordinary answer crossed the threshold', () => {
  const said = [], shown = [], prefix = 'Contexte complet. '.repeat(100), suffix = ' Appelle le 988.';
  const p = P.create({ onSay: value => said.push(value), onShow: value => shown.push(value) });
  p.push(prefix); p.push(suffix); p.end();
  assert.ok(said.join('').endsWith(prefix + suffix));
  assert.equal(shown.at(-1), prefix + suffix);
});
