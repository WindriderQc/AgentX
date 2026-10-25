'use strict';
const { observerView } = require('../../src/services/iss/observerView');
const observer = { lat: 12.34, lon: -56.78 };
const env = { ISS_VIEW_URL: 'https://viewer.example/iss#passages' };

test('location transfer requires explicit viewer support and stays out of the HTTP URL', () => {
  expect(observerView(observer, env).observerSynchronized).toBe(false);
  const view = observerView(observer, { ...env, ISS_VIEW_OBSERVER_MODE: 'fragment-v1' });
  const url = new URL(view.url);
  expect(view.observerSynchronized).toBe(true);
  expect(url.hash).toBe('#passages?observer=v1:12.34,-56.78');
  url.hash = '';
  expect(url.href).toBe('https://viewer.example/iss');
});

test('zero is valid and insecure or credential-bearing viewers are refused', () => {
  expect(observerView({ lat: 0, lon: 0 }, { ...env, ISS_VIEW_OBSERVER_MODE: 'fragment-v1' }).url).toContain('v1:0.00,0.00');
  for (const ISS_VIEW_URL of ['', 'http://example.test', 'https://user:secret@example.test', 'garbage']) {
    expect(observerView(observer, { ISS_VIEW_URL, ISS_VIEW_OBSERVER_MODE: 'fragment-v1' })).toBeNull();
  }
});
