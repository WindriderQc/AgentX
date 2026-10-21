'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

async function openDad(pathname) {
  const app = { innerHTML: '' };
  const location = { pathname, search: '?view=workflows', hash: '#timeline' };
  const calls = { conversation: [], navigation: [], replaced: [] };
  let onReady;
  const window = {
    addEventListener() {},
    async mountConversation(options) {
      calls.conversation.push(options.space);
      app.innerHTML = '<main>Nestor conversation</main>';
    },
    HouseholdNavigation: { mount(_app, route) { calls.navigation.push(route); } }
  };
  const document = {
    getElementById(id) { return id === 'app' ? app : null; },
    addEventListener(name, callback) { if (name === 'DOMContentLoaded') onReady = callback; }
  };
  const history = {
    state: { from: 'bookmark' },
    replaceState(_state, _title, url) {
      calls.replaced.push(url);
      const next = new URL(url, 'https://example.test');
      Object.assign(location, { pathname: next.pathname, search: next.search, hash: next.hash });
    }
  };
  vm.runInNewContext(script, { window, document, history, location, console, URL });
  await onReady();
  return { app, location, calls };
}

test('Nestor opens from its canonical and trailing-slash URLs without submitting a turn', async () => {
  for (const initialPath of ['/dad', '/dad/']) {
    const { app, location, calls } = await openDad(initialPath);
    assert.equal(app.innerHTML, '<main>Nestor conversation</main>');
    assert.deepEqual(calls.conversation, ['personal']);
    assert.deepEqual(calls.navigation, ['/dad']);
    assert.equal(location.pathname, '/dad');
    assert.equal(location.search, '?view=workflows');
    assert.equal(location.hash, '#timeline');
    assert.deepEqual(calls.replaced, initialPath === '/dad/' ? ['/dad?view=workflows#timeline'] : []);
  }
});
