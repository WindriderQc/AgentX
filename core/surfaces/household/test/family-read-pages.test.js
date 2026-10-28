'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScreenServices, screenPolicy } = require('../screen-services');
const { allowedForFamilyDevice } = require('../family-device');
const { createReplyChannels, contract } = require('../reply-channels');
const { presentationEvidence } = require('../screen-context');
const app = { locals: { agentxProfile: 'full' } };
const services = [
  { id: 'earth', label: 'Earth', href: 'https://science.example/earth', mode: 'frame', family: true },
  { id: 'iss', label: 'ISS', href: 'https://science.example/iss', mode: 'frame', family: true },
  { id: 'private-system', label: 'Private', href: 'https://admin.example', mode: 'frame', family: true }
];
test('family catalogue exposes curated scenes, never owner pages or arbitrary services', () => {
  const catalog = createScreenServices({ app, env: {}, services }).family;
  assert.deepEqual(catalog.entries.map(x => x.id), ['ecosystem', 'earth', 'iss']);
  assert.equal(catalog.parse('pipeline'), null); assert.equal(catalog.parse('private-system'), null);
  assert.equal(catalog.url(catalog.parse('ecosystem play=network,memory')), '/diskx?app=ecosystem&view=screen&from=nestor&play=network%2Cmemory');
  const parser = createReplyChannels({ allowPages: true, pageCatalog: catalog });
  parser.push('Voici la visite. <show kind="page">ecosystem play=network</show><show kind="page">pipeline</show><show kind="page">https://evil.example</show>');
  assert.deepEqual(parser.end().display.map(x => x.body), ['ecosystem play=network']);
  assert.match(contract({ family: true, pages: true, pageCatalog: catalog }), /configured family views/);
  assert.equal(presentationEvidence([{ contract: 'agentx.presentation/v1', kind: 'page', status: 'visible', page: 'analytics', read: { id: 'owner-read' } }], catalog), null);
});
test('family pin permits only the ecosystem presentation and its exact assets', () => {
  const allowed = (method, path, query = {}) => allowedForFamilyDevice({ method, path, query });
  assert.equal(allowed('GET', '/diskx', { app: 'ecosystem', play: 'network' }), true);
  for (const query of [{}, { app: 'diskx' }, { app: ['ecosystem', 'diskx'] }]) assert.equal(allowed('GET', '/diskx', query), false);
  for (const path of ['/api/diskx/diskx.js', '/assets/diskx/ecosystem-page.js', '/assets/diskx/diskx.css']) assert.equal(allowed('GET', path), true);
  for (const path of ['/api/diskx/presentation', '/api/data-toolbox/storage', '/assets/diskx/diskx-page.js', '/api/voice-personas/private/screen-pages']) assert.equal(allowed('GET', path), false);
  assert.equal(allowed('POST', '/diskx', { app: 'ecosystem' }), false);
});
test('family CSP grants only its curated external scene origin', () => {
  const catalog = createScreenServices({ app, env: {}, services });
  let value = "default-src 'self'; frame-src 'self'";
  screenPolicy(catalog)({ method: 'GET', path: '/panel', query: {} }, {
    getHeader: () => value, setHeader: (_key, next) => { value = next; }
  }, () => {});
  assert.match(value, /https:\/\/science.example/); assert.doesNotMatch(value, /admin.example/);
});
