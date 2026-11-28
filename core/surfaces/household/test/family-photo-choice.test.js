'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./fixtures/persona-journey.cjs');
const { createVisuals } = require('../visuals');

function fixture(reviewed = false) {
  const queries = [];
  const env = { SEARXNG_URL: 'https://search.invalid', HOUSEHOLD_IMAGE_FAMILY_SOURCES: 'web' };
  if (reviewed) env.HOUSEHOLD_FAMILY_PUBLIC_PICTURES_JSON = '[]';
  const visuals = createVisuals({ env, fetchImpl: async url => {
    queries.push(new URL(url).searchParams.get('q'));
    return { ok: true, json: async () => ({ results: [{ img_src: 'https://fixture.example/photo.png' }] }) };
  } });
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx', visuals, response: 'Réponse indépendante.' });
  return { h, queries };
}

test('a named public source preserves the animal with and without reviewed picture configuration', async () => {
  for (const reviewed of [true, false]) {
    const { h, queries } = fixture(reviewed);
    for (const qualifier of ['sur le Web', 'sur Internet']) {
      const out = await h.turn('Montre-moi une image de renard ' + qualifier + '.', 'voice');
      assert.equal(out.display[0].source, 'web');
    }
    assert.deepEqual(queries, ['animal un renard', 'animal un renard']);
    assert.equal(h.sent.length, 0);
  }
});

test('ordinary Family voice and text turns carry a photo subject only across adjacent source choices', async () => {
  const { h, queries } = fixture(true);
  assert.match((await h.turn('Montre-moi un renard.', 'voice')).reply.text, /Dans nos photos ou sur le Web/);
  assert.deepEqual(queries, []);
  assert.match((await h.turn('Dans nos photos.', 'text')).reply.text, /pas accessible/);
  assert.deepEqual(queries, []);
  assert.equal((await h.turn('Sur le Web.', 'voice')).display[0].source, 'web');
  assert.deepEqual(queries, ['animal un renard']);
  await h.turn('Pourquoi le ciel est bleu?', 'voice');
  assert.match((await h.turn('Sur le Web.', 'voice')).reply.text, /photo de quoi/);
  assert.deepEqual(queries, ['animal un renard']);
});

test('a private label never becomes an external query, including a later explicit source choice', async () => {
  const { h, queries } = fixture(true);
  assert.match((await h.turn('Montre-moi une photo de projet synthétique dans Immich.', 'voice')).reply.text, /pas accessible/);
  await h.turn('Montre-moi nos photos de projet synthétique.', 'voice');
  assert.match((await h.turn('Sur le Web.', 'voice')).reply.text, /catalogue/);
  assert.deepEqual(queries, []);
});
