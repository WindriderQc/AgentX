'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedForFamilyDevice: allowed } = require('../family-device');
const image = '/api/photos/frame/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/image';
test('pinned family devices read only the configured frame endpoints', () => {
  for (const path of ['/api/photos/frame/status', '/api/photos/frame/next', image]) {
    assert.equal(allowed({ method: 'GET', path }), true, path);
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal(allowed({ method, path }), false, method + path);
  }
  for (const path of ['/api/photos', '/api/photos/search', '/api/photos/random', '/api/photos/frame',
    '/api/photos/frame/next/extra', '/api/photos/frame/invalid/image', image + '/metadata',
    '/api/voice-personas/private/agents', '/dad', '/api/photos/albums']) {
    assert.equal(allowed({ method: 'GET', path }), false, path);
  }
});
