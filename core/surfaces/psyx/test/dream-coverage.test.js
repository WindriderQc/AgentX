'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareDreamRequest, normalizeStoredPortrait } = require('../../../src/domains/psyx/dream');
const { emptyState } = require('../../../src/domains/psyx/stateRepository');
const { createDreamer } = require('../src/dreamer');
const { createCoreProvider } = require('../src/provider');

function sessions(count, characters = 5500) {
  return Array.from({ length: count }, (_, index) => ({ id: `session-${index}`,
    updatedAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString(),
    messages: [{ role: 'user', content: `START_${index} ${'x'.repeat(characters)} END_${index}` }] }));
}

test('dream coverage counts selected sessions and preserves each selected message whole', () => {
  const conversations = sessions(20);
  const prepared = prepareDreamRequest({ state: emptyState(), conversations, maxCharacters: 60000, wide: false });
  const text = prepared.messages[1].content;
  const included = conversations.filter(session => text.includes(session.messages[0].content));
  assert.ok(included.length > 0 && included.length < conversations.length);
  assert.deepEqual([prepared.coverage.conversations, prepared.coverage.availableConversations, prepared.coverage.messages,
    prepared.coverage.availableMessages, prepared.coverage.complete], [included.length, 20, included.length, 20, false]);
  assert.ok(text.length <= 60000);
  assert.ok(text.includes(conversations.at(-1).messages[0].content));
});

test('an oversized recent session includes whole recent messages and declares the partial session', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `MESSAGE_${index} ${'x'.repeat(500)} END_${index}` }));
  const prepared = prepareDreamRequest({ state: emptyState(), conversations: [{ id: 'c', messages }], maxCharacters: 3000 });
  const text = prepared.messages[1].content;
  const included = messages.filter(message => text.includes(message.content));
  assert.ok(included.length > 0 && included.length < messages.length);
  assert.equal(prepared.coverage.partialConversations, 1);
  assert.equal(prepared.coverage.messages, included.length);
  assert.equal(prepared.coverage.complete, false);
  assert.ok(text.includes(messages.at(-1).content));
});

test('a recent message larger than the local dream budget is refused instead of sliced', () => {
  const conversations = sessions(1, 80000);
  assert.throws(() => prepareDreamRequest({ state: emptyState(), conversations, maxCharacters: 60000 }), { code: 'PSYX_DREAM_CONTEXT_TOO_LARGE' });
  const wide = prepareDreamRequest({ state: emptyState(), conversations, maxCharacters: 300000 });
  assert.ok(wide.messages[1].content.includes(conversations[0].messages[0].content));
  assert.equal(wide.coverage.complete, true);
});

test('limited source text is identified as partial and old portraits never gain invented coverage', () => {
  const prepared = prepareDreamRequest({ state: emptyState(), conversations: sessions(1, 10),
    sources: [{ key: 'notes', title: 'Notes', text: 'n'.repeat(1000) }], sourceCharacters: 100 });
  assert.deepEqual(prepared.coverage.sourceCoverage, [{ key: 'notes', includedCharacters: 100, availableCharacters: 1000, complete: false }]);
  const portrait = normalizeStoredPortrait({ updatedAt: '2026-10-01', covers: { conversations: 20, through: '2026-10-01' } });
  assert.equal(portrait.covers.availableConversations, null);
  assert.equal(portrait.covers.complete, null);
});

test('complete collected text cannot hide incomplete source collection from the dream or portrait', () => {
  const collection = { collectedItems: 300, availableItems: 450, complete: false, reason: 'collection_limit' };
  const prepared = prepareDreamRequest({ state: emptyState(), conversations: sessions(1, 10),
    sources: [{ key: 'notes', title: 'Notes', text: 'A complete collected note.', collection }] });
  assert.equal(prepared.coverage.sourceCoverage[0].complete, true);
  assert.deepEqual(prepared.coverage.sourceCoverage[0].collection, collection);
  assert.ok(prepared.messages[1].content.includes('collected 300/450 items; collection not established complete'));
  const portrait = normalizeStoredPortrait({ updatedAt: '2026-10-01', covers: prepared.coverage });
  assert.deepEqual(portrait.covers.sourceCoverage[0].collection, collection);
});

test('the portrait labels incomplete collection even when all conversation and collected text were supplied', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/dream.js'), 'utf8'), context);
  const label = vm.runInContext(`dreamCoverageLabel({ conversations: 1, availableConversations: 1,
    messages: 2, availableMessages: 2, complete: true, sourceCoverage: [{ key: 'notes', complete: true,
    collection: { collectedItems: 300, availableItems: 450, complete: false } }] })`, context);
  assert.ok(label.includes('couverture partielle'));
  assert.ok(label.includes('300/450 recueillis'));
});

test('the stored dream coverage follows the actual fallback lane and retains unavailable sources', async () => {
  let recorded, request;
  const state = emptyState();
  const conversations = sessions(20);
  const dreamer = createDreamer({ config: { dream: {} }, logger: {}, locationFor: () => 'frontier',
    sources: { gather: async () => ({ sources: [], unavailable: ['mail'] }) },
    provider: { async complete(input) { request = input; return { location: 'local', content: JSON.stringify({
      portrait: { sections: [{ key: 'situation', statements: [{ text: 'Hypothèse synthétique.', evidence: [input.local.evidenceSources[0].text.slice(0, 240)] }] }] }
    }) }; } },
    stateRepository: { read: async () => state, recordDream: async (_user, input) => { recorded = input; return { entry: { id: 'd' } }; } },
    conversationRepository: { listTranscripts: async () => conversations }
  });
  try {
    dreamer.request('u');
    for (let attempt = 0; attempt < 100 && !recorded; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(recorded);
    assert.equal(request.messages[1].content.includes(conversations[0].messages[0].content), true);
    assert.equal(request.local.messages[1].content.includes(conversations[0].messages[0].content), false);
    assert.equal(recorded.covers.availableConversations, 20);
    assert.equal(recorded.covers.conversations, request.local.coverage.conversations);
    assert.equal(recorded.location, 'local');
    assert.deepEqual(recorded.covers.unavailableSources, ['mail']);
    assert.equal(normalizeStoredPortrait({ updatedAt: '2026-10-01', covers: recorded.covers }).covers.complete, false);
  } finally { dreamer.stop(); }
});

test('frontier failure cannot send an oversized wide dream to the local route', async () => {
  let calls = 0;
  const provider = createCoreProvider({ inference: { execute: async () => { calls++; } } }, {
    config: { frontier: { agent: 'psyx' } }, logger: {}, frontier: { available: () => true, run: async () => { throw new Error('down'); } }
  });
  await assert.rejects(provider.complete({ location: 'frontier', messages: [{ role: 'system', content: 'S' }],
    local: { error: { code: 'PSYX_DREAM_CONTEXT_TOO_LARGE', message: 'Refused' } } }), { code: 'PSYX_DREAM_CONTEXT_TOO_LARGE' });
  assert.equal(calls, 0);
});
