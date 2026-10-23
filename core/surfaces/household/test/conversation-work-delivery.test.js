'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/conversation-work');
class Element {
  constructor() { this.children = []; this.dataset = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  remove() {}
  setAttribute(name, value) { (this.attributes ||= {})[name] = value; }
  querySelector(selector) { return this.children.find(node => '.' + node.className === selector); }
}
function fixture(items) {
  const host = new Element(), stages = [], shown = [], spoken = [], languages = [], conversation = { session: { sessionId: 'owner-session' }, state: 'listening',
    interject: async ({ text, language }, { onScheduled, preserveLanguage }) => { assert.equal(preserveLanguage, true); spoken.push(text); languages.push(language); onScheduled(); return true; } };
  global.document = { createElement: () => new Element() };
  const feed = create({ host, onShow: block => shown.push(block), base: '/sessions', getConversation: () => conversation, api: async (url, options) => {
    if (url.includes('/receipt')) { const receipt = JSON.parse(options.body); stages.push(receipt.stage); return { claimToken: 'owned-claim' }; }
    return { items, cursor: 1, hasMore: false };
  }, pollMs: 60000 });
  return { host, get cards() { return host.children.filter(node => node.className === 'conversation-work-card'); }, feed, stages, shown, spoken, languages, conversation };
}
const item = (id, automaticSpeech, classification = 'native_work') => ({ id, sessionId: 'owner-session', state: 'completed', classification,
  result: { text: id, version: 1, deliveryId: id, presentation: 'available', automaticSpeech } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a review is displayed without a second voice; explicit Listen still reads its exact retained result', async () => {
  const h = fixture([item('alternate-story', false, 'native_review')]);
  try {
    h.feed.follow('owner-session'); await tick(); await h.feed.naturalPause();
    assert.deepEqual(h.spoken, []); assert.deepEqual(h.stages, ['displayed']);
    h.cards[0].children.find(node => node.type === 'button').onclick(); await tick();
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
    assert.equal(h.cards[0].children.find(node => node.className === 'conversation-work-answer').textContent, full);
    assert.match(h.cards[0].children.find(node => node.className === 'conversation-work-status').textContent, /presented/);
    h.cards[0].children.find(node => node.type === 'button').onclick(); await tick();
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
    assert.equal(h.cards[0].children.find(node => node.className === 'conversation-work-answer').textContent, row.result.displayText);
    h.cards[0].children.find(node => node.type === 'button').onclick(); await tick();
    assert.equal(h.spoken[1], row.result.readingText);
    assert.deepEqual(h.languages, ['fr', 'fr'], 'a later language choice cannot change the original result or its replay');
    assert.equal(h.stages.filter(stage => stage === 'claim').length, 1);
    assert.equal(h.stages.filter(stage => stage === 'replay').length, 1);
  } finally { h.feed.dispose(); delete global.document; }
});


test('background page displays are restored once per result version while speech remains separate', async () => {
  const row = item('native-page', true); row.result.display = [{ kind: 'page', body: 'pipeline' }];
  const h = fixture([row]);
  try {
    h.feed.follow('owner-session'); await tick(); await h.feed.poll();
    assert.deepEqual(h.shown, row.result.display);
    assert.deepEqual(h.spoken, ['native-page']);
    h.feed.reset(); h.feed.follow('owner-session'); await tick();
    assert.equal(h.shown.length, 2, 'restoring a conversation restores its page');
  } finally { h.feed.dispose(); delete global.document; }
});
