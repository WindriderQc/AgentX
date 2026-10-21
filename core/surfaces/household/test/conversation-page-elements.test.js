'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '../public');
const markup = fs.readdirSync(publicDir).filter(name => /\.(js|html)$/.test(name))
  .map(name => fs.readFileSync(path.join(publicDir, name), 'utf8'))
  // The shared navigation renders the runtime pill.
  .concat(fs.readFileSync(path.join(__dirname, '../../../views/partials/nav.ejs'), 'utf8')).join('\n');
const page = fs.readFileSync(path.join(publicDir, 'conversation-page.js'), 'utf8');

// el(id) returns null for an element the page no longer renders; an unguarded
// write then stops the voice turn ("Cannot set properties of null").
test('every element the conversation page uses is still rendered, or guarded', () => {
  const guarded = new Set(['conversationSpeechReceipt']);
  const ids = [...new Set([...page.matchAll(/\bel\('([A-Za-z]+)'\)/g)].map(match => match[1]))];
  const missing = ids.filter(id => !guarded.has(id) && !new RegExp(`id="${id}"`).test(markup));
  assert.deepEqual(missing, []);
});

test('speech synthesis does not require the removed speech receipt', () => {
  assert.match(page, /const receipt = el\('conversationSpeechReceipt'\);\s*\n\s*if \(receipt && !signal\.aborted\)/);
});
