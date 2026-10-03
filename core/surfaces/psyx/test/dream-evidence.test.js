'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { prepareDreamRequest, readDream, normalizeStoredPortrait } = require('../../../src/domains/psyx/dream');
const { createStateRepository, emptyState } = require('../../../src/domains/psyx/stateRepository');

const session = { id: '507f1f77bcf86cd799439011', messages: [
  { role: 'user', content: 'Je dors mal depuis la rentrée. Le soir, je suis épuisé.' },
  { role: 'assistant', content: 'Tu évites probablement les conflits.' }
] };
const answer = (quote, extra = {}) => ({ portrait: { sections: [{ key: 'health', statements: [
  { text: 'Le sommeil semble peser sur tes soirées.', evidence: [quote], ...extra }
] }] }, findings: [{ text: 'Une piste à vérifier.', evidence: [quote] }],
memory: [{ op: 'add', kind: 'hypotheses', text: 'Le sommeil pourrait contribuer à la fatigue.', evidence: [quote] }] });
const prepared = () => prepareDreamRequest({ state: emptyState(), conversations: [session] });

test('new dream quotes resolve to actual supplied user words with server-generated provenance', () => {
  const { evidenceSources } = prepared();
  const dream = readDream(answer('« Je dors mal depuis la rentrée. »'), { evidenceSources });
  const [item] = dream.sections[0].statements;
  assert.deepEqual(item.evidence, ['Je dors mal depuis la rentrée.']);
  assert.deepEqual(item.evidenceRefs, [{ kind: 'conversation', quote: 'Je dors mal depuis la rentrée.',
    conversationId: session.id, messageIndex: 0, key: '',
    textHash: crypto.createHash('sha256').update(session.messages[0].content).digest('hex') }]);
  assert.deepEqual(dream.findings[0].evidenceRefs, item.evidenceRefs);
  assert.deepEqual(dream.memory[0].evidenceRefs, item.evidenceRefs);
});

test('invented, paraphrased and assistant-authored evidence cannot support new portrait or memory', () => {
  for (const quote of ['Tu dors mal chaque nuit.', 'Trois séances montrent de la fatigue.', session.messages[1].content]) {
    const dream = readDream(answer(quote, { evidenceRefs: [{ kind: 'conversation', quote,
      textHash: 'a'.repeat(64), conversationId: session.id, messageIndex: 0 }] }), prepared());
    assert.deepEqual([dream.sections, dream.findings, dream.memory], [[], [], []], quote);
  }
});

test('a model-supplied reference never replaces the source verified by code', () => {
  const dream = readDream(answer('Le soir, je suis épuisé.', { evidenceRefs: [{ kind: 'mail',
    quote: 'Le soir, je suis épuisé.', textHash: 'b'.repeat(64), key: 'forged' }] }), prepared());
  assert.equal(dream.sections[0].statements[0].evidenceRefs[0].kind, 'conversation');
  assert.notEqual(dream.sections[0].statements[0].evidenceRefs[0].textHash, 'b'.repeat(64));
});

test('only the selected lane material can verify evidence, including whole messages and bounded sources', () => {
  const old = { id: 'old', messages: [{ role: 'user', content: 'Un ancien événement distinct. '.repeat(100) }] };
  const selected = prepareDreamRequest({ state: emptyState(), conversations: [old, session], maxCharacters: 1500,
    sources: [{ key: 'notes', title: 'Notes', text: 'Note disponible. EXCLUDED_NOTE' }], sourceCharacters: 16 });
  assert.equal(selected.coverage.conversations, 1);
  for (const quote of ['Un ancien événement distinct.', 'EXCLUDED_NOTE']) {
    assert.deepEqual(readDream(answer(quote), selected).sections, []);
  }
  assert.equal(readDream(answer('Je dors mal depuis la rentrée.'), selected).sections.length, 1);
});

test('profile, user-authored memory and owner sources are eligible; earlier model hypotheses are not', () => {
  const state = { ...emptyState(), profile: { about: 'Je travaille de nuit.' }, notes: [
    { id: 'mine', text: 'Je préfère le matin.', source: 'user' },
    { id: 'fixed', text: 'Je garde mon fils le mercredi.', source: 'dream', correctedBy: 'user' },
    { id: 'inferred', text: 'Tu as peur du rejet.', source: 'dream' }
  ] };
  const selected = prepareDreamRequest({ state, conversations: [session], sources: [
    { key: 'tasks', title: 'Tâches', text: 'Préparer la rencontre de parents.' }
  ] });
  for (const [quote, kind] of [['Je travaille de nuit.', 'profile'], ['Je préfère le matin.', 'memory'],
    ['Je garde mon fils le mercredi.', 'memory'], ['Préparer la rencontre de parents.', 'tasks']]) {
    assert.equal(readDream(answer(quote), selected).sections[0].statements[0].evidenceRefs[0].kind, kind);
  }
  assert.deepEqual(readDream(answer('Tu as peur du rejet.'), selected).sections, []);
});

test('old portraits retain their quotations without acquiring verified provenance', () => {
  const portrait = normalizeStoredPortrait({ updatedAt: '2026-10-01', sections: answer('ancienne preuve').portrait.sections });
  assert.deepEqual(portrait.sections[0].statements[0].evidenceRefs, []);
  assert.deepEqual(portrait.sections[0].statements[0].evidence, ['ancienne preuve']);
});

test('recorded outcomes and scored measures can support trends without recycling experiment hypotheses', () => {
  const state = { ...emptyState(), experiments: [{ hypothesis: 'Tu aurais peur du rejet.', action: 'Prendre une pause avant de répondre.',
    result: 'J’ai répondu plus calmement.', outcome: 'worked', createdAt: '2026-10-01' }],
  checkIns: [{ score: 7, phase: 'opening', at: '2026-10-01' }],
  assessments: [{ kind: 'phq9', score: 12, band: 'moderate', at: '2026-10-01' }] };
  const request = prepareDreamRequest({ state, conversations: [session] });
  for (const [quote, kind] of [['J’ai répondu plus calmement.', 'experiment'], ['"score":7', 'checkIn'], ['"score":12', 'assessment']]) {
    const dream = readDream(answer(quote), request);
    assert.equal(dream.sections[0].statements[0].evidenceRefs[0].kind, kind);
  }
  for (const quote of ['Tu aurais peur du rejet.', '"score":20', 'J’ai retrouvé un sommeil parfait.']) {
    assert.deepEqual(readDream(answer(quote), request).sections, []);
  }
});

test('verified references survive Mongo persistence for portraits, findings and dream memory', async () => {
  const mongo = await MongoMemoryServer.create();
  const client = await MongoClient.connect(mongo.getUri());
  try {
    const repository = createStateRepository({ collection: client.db('psyx').collection('psyxstates'), logger: {} });
    const dream = readDream(answer('Le soir, je suis épuisé.'), prepared());
    await repository.recordDream('u', { dream, resetAt: null });
    const state = await repository.read('u');
    const refs = dream.sections[0].statements[0].evidenceRefs;
    assert.deepEqual(state.portrait.sections[0].statements[0].evidenceRefs, refs);
    assert.deepEqual(state.portrait.findings[0].evidenceRefs, refs);
    assert.deepEqual(state.hypotheses[0].evidenceRefs, refs);
    const user = await repository.addItem('u', 'notes', { text: 'Ma propre note', evidenceRefs: refs });
    assert.deepEqual(user.item.evidenceRefs, [], 'user requests cannot manufacture verification');
  } finally { await client.close(); await mongo.stop(); }
});
