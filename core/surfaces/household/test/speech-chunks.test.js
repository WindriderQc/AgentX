'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextSpeechChunkLength: nextLength } = require('../public/browser-conversation');

function streamed(tokens) {
  let pending = '', first = true;
  const chunks = [];
  for (const token of tokens) {
    pending += token;
    let length;
    while ((length = nextLength(pending, first))) {
      chunks.push(pending.slice(0, length)); pending = pending.slice(length); first = false;
    }
  }
  return { chunks, pending };
}

test('a short completed opening streams while subsequent fragments keep useful prosodic context', () => {
  const result = streamed(['Oui ! ', 'OK. ', 'Bien. ', 'Voici la suite de notre conversation. ']);
  assert.deepEqual(result.chunks, ['Oui ! ', 'OK. Bien. Voici la suite de notre conversation. ']);
  assert.equal(result.pending, '');
});

test('split decimals, network addresses, initials and titles do not create false openings', () => {
  for (const tokens of [
    ['La valeur est 3.', '14 aujourd’hui. '],
    ['Le serveur est 192.', '168.2.', '99 et il répond. '],
    ['Le site est https://agentx.', 'example.test et il répond. '],
    ['M. ', 'Tremblay arrive bientôt. '],
    ['Dr. ', 'Smith is here. '],
    ['J. ', 'R. ', 'arrive bientôt. ']
  ]) {
    const result = streamed(tokens);
    assert.deepEqual(result.chunks, [tokens.join('')]);
    assert.equal(result.pending, '');
  }
});

test('closing Markdown and quotes remain attached to the completed short phrase', () => {
  const text = '🦉 **« Salut ! »** ';
  for (const tokens of [[text], Array.from(text)]) {
    const result = streamed(tokens);
    assert.equal(result.chunks.join('').trim(), text.trim());
    assert.equal(result.pending.trim(), '');
  }
});

test('long prose starts before a distant final period and retains every character', () => {
  const text = 'Une longue explication ' + 'avec plusieurs mots '.repeat(30) + 'se termine ici. ';
  const result = streamed([text]);
  assert.ok(result.chunks.length > 1);
  assert.ok(result.chunks.every(chunk => chunk.length <= 241));
  assert.equal(result.chunks.join('') + result.pending, text);
});

test('quoted media references and their tail wait for final sanitation without leaking paths', () => {
  const intro = 'Voilà ! ';
  const media = 'MEDIA:"/private/' + 'a folder with spaces. '.repeat(30) + 'voice.mp3" Bonne écoute.';
  const result = streamed(Array.from(intro + media));
  assert.deepEqual(result.chunks, [intro.trim()]);
  assert.equal(result.pending, ' ' + media);
});
