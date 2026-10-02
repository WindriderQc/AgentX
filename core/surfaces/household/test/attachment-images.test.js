'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const images = require('../public/attachment-images');

const file = (name, type, size) => ({ name, type, size });

test('photos may be large at selection; documents keep the 2 MB limit', () => {
  assert.equal(images.accepts(file('IMG_1.jpg', 'image/jpeg', 12 * 1024 * 1024)), true);
  assert.equal(images.accepts(file('IMG_2.heic', '', 9 * 1024 * 1024)), true);
  assert.equal(images.accepts(file('huge.jpg', 'image/jpeg', 51 * 1024 * 1024)), false);
  assert.equal(images.accepts(file('notes.pdf', 'application/pdf', 3 * 1024 * 1024)), false);
  assert.equal(images.accepts(file('notes.pdf', 'application/pdf', 1024)), true);
});

test('a reduced copy keeps the aspect ratio within the longest edge and becomes a JPEG name', () => {
  assert.deepEqual(images.fitWithin(4032, 3024, 2048), { width: 2048, height: 1536 });
  assert.deepEqual(images.fitWithin(3024, 4032, 2048), { width: 1536, height: 2048 });
  assert.deepEqual(images.fitWithin(800, 600, 2048), { width: 800, height: 600 });
  assert.equal(images.reducedName('IMG_0042.HEIC'), 'IMG_0042.jpg');
});

test('a JPEG or PNG under the limit is sent as is, without decoding', async () => {
  const small = file('small.jpg', 'image/jpeg', 500 * 1024);
  assert.equal(await images.reduce(small), small);
});
