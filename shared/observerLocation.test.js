'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePosition, resolvePosition, locationMetadata } = require('./observerLocation');

test('coordinates are a complete decimal pair; a genuine zero stays valid', () => {
  assert.equal(parsePosition({}), null);
  assert.deepEqual(parsePosition({ lat: '0', lon: 0 }), { lat: 0, lon: 0 });
  assert.deepEqual(parsePosition({ lat: ' 46.81 ', lon: '-71.21' }), { lat: 46.81, lon: -71.21 });
  for (const position of [{ lat: 1 }, { lon: 1 }, { lat: null, lon: null }, { lat: '', lon: 1 },
    { lat: ' ', lon: 1 }, { lat: false, lon: 1 }, { lat: [], lon: 1 }, { lat: ['1'], lon: 1 },
    { lat: 91, lon: 0 }, { lat: 0, lon: -181 }, { lat: Infinity, lon: 0 }, { lat: '0x10', lon: 0 }]) {
    assert.throws(() => parsePosition(position), { code: 'INVALID_POSITION', status: 400 });
  }
});

test('explicit coordinates outrank known and default locations', () => {
  assert.deepEqual(resolvePosition({ explicit: { lat: 0, lon: 0 }, known: { lat: 1, lon: 2 }, defaultLocationJson: 'invalid' }),
    { lat: 0, lon: 0, source: 'explicit', label: null });
});

test('known location outranks a configured default', () => {
  assert.equal(resolvePosition({ known: { lat: 1, lon: 2 }, defaultLocationJson: 'invalid' }).source, 'known');
});

test('a missing or unusable known location uses the named configured default', () => {
  const defaultLocationJson = JSON.stringify({ name: 'Example city', lat: 10, lon: 20 });
  for (const known of [null, {}, { lat: null, lon: null }, { lat: 91, lon: 0 }]) {
    const position = resolvePosition({ known, defaultLocationJson });
    assert.deepEqual(position, { lat: 10, lon: 20, source: 'default', label: 'Example city' });
    assert.deepEqual(locationMetadata(position), { source: 'default', label: 'Example city', defaulted: true });
    assert.doesNotMatch(JSON.stringify(locationMetadata(position)), /"lat"|"lon"/);
  }
  assert.equal(resolvePosition(), null);
});

test('invalid default configuration refuses without echoing its value', () => {
  for (const defaultLocationJson of ['not-json', 'null', '[]', '{}', '{"lat":999,"lon":2}']) {
    assert.throws(() => resolvePosition({ defaultLocationJson }), error => error.status === 503
      && error.code === 'INVALID_POSITION' && !error.message.includes(defaultLocationJson));
  }
});
