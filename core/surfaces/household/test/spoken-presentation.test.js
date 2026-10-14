'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../../public/js/voice/spoken-presentation');

test('explicit readings are recognized across the supported request languages', () => {
  for (const request of ['Lis-moi la réponse complète', 'Peux-tu me lire le texte?', 'Read the complete response', 'Could you read this aloud?']) {
    assert.equal(P.readingRequested(request), true);
  }
  assert.equal(P.readingRequested('Explique-moi ce texte'), false);
});
