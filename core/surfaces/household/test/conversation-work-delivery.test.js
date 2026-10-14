'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/conversation-work');
class Element {
  constructor() { this.children = []; this.dataset = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  remove() {}
  querySelector(selector) { return this.children.find(node => '.' + node.className === selector); }
}
function fixture(items) {
  const host = new Element(), stages = [], spoken = [], languages = [], conversation = { session: { sessionId: 'owner-session' }, state: 'listening',
    interject: async ({ text, language }, { onScheduled }) => { spoken.push(text); languages.push(language); onScheduled(); return true; } };
  global.document = { createElement: () => new Element() };
  const feed = create({ host, base: '/sessions', getConversation: () => conversation, api: async (url, options) => {
    if (url.includes('/receipt')) { const receipt = JSON.parse(options.body); stages.push(receipt.stage); return { claimToken: 'owned-claim' }; }
    return { items, cursor: 1, hasMore: false };
  }, pollMs: 60000 });
  return { host, feed, stages, spoken, languages, conversation };
}
const item = (id, automaticSpeech, classification = 'native_work') => ({ id, sessionId: 'owner-session', state: 'completed', classification,
  result: { text: id, version: 1, deliveryId: id, presentation: 'available', automaticSpeech } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a review is displayed without a second voice; explicit Listen still reads its exact retained result', async () => {
  const h = fixture([item('alternate-story', false, 'native_review')]);
  try {
    h.feed.follow('owner-session'); await tick(); await h.feed.naturalPause();
    assert.deepEqual(h.spoken, []); assert.deepEqual(h.stages, ['displayed']);
    h.host.children[0].children.find(node => node.type === 'button').onclick(); await tick();
    assert.deepEqual(h.spoken, ['alternate-story']); assert.deepEqual(h.stages, ['displayed', 'replay', 'started', 'completed']);
  } finally { h.feed.dispose(); delete global.document; }
});

test('a manual review cannot block the awaited work result, which is spoken once through the conversation queue', async () => {
  const h = fixture([item('review', false, 'native_review'), item('verified-work', true)]);
  try {
    h.feed.follow('owner-session'); await tick(); await h.feed.naturalPause(); await h.feed.poll();
    assert.deepEqual(h.spoken, ['verified-work']); assert.equal(h.stages.filter(stage => stage === 'claim').length, 1);
  } finally { h.feed.dispose(); delete global.document; }
});

test('an older review projection without the new flag cannot automatically speak', async () => {
  const h = fixture([item('older-review', undefined, 'native_review')]);
  try { h.feed.follow('owner-session'); await tick(); await h.feed.naturalPause(); assert.deepEqual(h.spoken, []); }
  finally { h.feed.dispose(); delete global.document; }
});

test('Core can authorize an outstanding verified result on an older review and it speaks once', async () => {
  const h = fixture([item('original-tool-result', true, 'native_review')]);
  try {
    h.feed.follow('owner-session'); await tick(); await h.feed.poll(); await h.feed.naturalPause();
    assert.deepEqual(h.spoken, ['original-tool-result']);
    assert.equal(h.stages.filter(stage => stage === 'claim').length, 1);
  } finally { h.feed.dispose(); delete global.document; }
});

test('automatic long explanations and explicit Listen both speak the complete retained result', async () => {
  const row = item('long-result', true), full = 'Première explication. '.repeat(100) + 'FIN';
  row.result.text = full;
  const h = fixture([row]);
  try {
    h.feed.follow('owner-session'); await tick(); await h.feed.naturalPause();
    assert.equal(h.spoken[0], full);
    assert.equal(h.host.children[0].children[1].textContent, full);
    assert.match(h.host.children[0].children[0].textContent, /presented/);
    h.host.children[0].children.find(node => node.type === 'button').onclick(); await tick();
    assert.equal(h.spoken[1], full);
    assert.deepEqual(h.stages, ['displayed', 'claim', 'started', 'completed', 'replay', 'started', 'completed']);
  } finally { h.feed.dispose(); delete global.document; }
});


test('a document result speaks its projected summary, displays everything and reads every word on Listen', async () => {
  const row = item('document-result', true);
  row.result.text = 'Authoritative native answer with presentation markers.';
  row.result.spokenText = 'Le document recommande deux étapes : préparer, puis vérifier.';
  row.result.displayText = row.result.spokenText + '\n\n' + 'Document complet. '.repeat(100) + 'FIN';
  row.result.readingText = row.result.displayText;
  row.result.language = 'fr';
  const h = fixture([row]);
  h.conversation.selection = { language: 'en' };
  try {
    h.feed.follow('owner-session'); await tick(); await h.feed.naturalPause();
    assert.deepEqual(h.spoken, [row.result.spokenText]);
    assert.equal(h.host.children[0].children[1].textContent, row.result.displayText);
    h.host.children[0].children.find(node => node.type === 'button').onclick(); await tick();
    assert.equal(h.spoken[1], row.result.readingText);
    assert.deepEqual(h.languages, ['fr', 'fr'], 'a later language choice cannot change the original result or its replay');
    assert.equal(h.stages.filter(stage => stage === 'claim').length, 1);
    assert.equal(h.stages.filter(stage => stage === 'replay').length, 1);
  } finally { h.feed.dispose(); delete global.document; }
});
