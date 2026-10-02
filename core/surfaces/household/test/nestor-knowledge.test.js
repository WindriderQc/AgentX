'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const knowledge = require('../nestor-knowledge');

function activeConfig() {
  return {
    schemaVersion: 1,
    status: 'active',
    corpusId: 'family-test-v1',
    retrieval: {
      enabled: true,
      topK: 3,
      minScore: 0.7,
      timeoutMs: 1000,
      maxContextCharacters: 1200
    },
    documents: [{
      relativePath: 'approved/family-guide.md',
      sha256: 'a'.repeat(64),
      lanes: ['family', 'reader']
    }]
  };
}

test('distributable config contains no personal corpus and leaves retrieval disabled', () => {
  const config = knowledge.loadConfig();
  const status = knowledge.publicStatus(config);
  assert.equal(status.status, 'disabled_pending_approved_corpus');
  assert.equal(status.enabled, false);
  assert.equal(status.documentCount, 0);
  assert.deepEqual(status.laneCounts, { operator: 0, family: 0, reader: 0 });
  assert.match(status.corpusFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(status.legacySourcesEligible, false);
  assert.equal(status.pathsIncluded, false);
  assert.equal(status.contentIncluded, false);
});

test('config validation rejects traversal, loose hashes, and empty activation', () => {
  const config = activeConfig();
  assert.doesNotThrow(() => knowledge.validateConfig(config));
  assert.throws(() => knowledge.validateConfig({
    ...config,
    documents: [{ relativePath: '../secret.md', sha256: 'a'.repeat(64), lanes: ['family'] }]
  }), /traversal-free/);
  assert.throws(() => knowledge.validateConfig({
    ...config,
    documents: [{ relativePath: 'guide.md', sha256: 'abc', lanes: ['family'] }]
  }), /exact SHA-256/);
  assert.throws(() => knowledge.validateConfig({ ...config, documents: [] }), /non-empty corpus/);
});

test('disabled retrieval performs no RAG request', async () => {
  let calls = 0;
  const active = knowledge.loadConfig();
  const config = {
    ...active,
    status: 'disabled_pending_approved_corpus',
    retrieval: { ...active.retrieval, enabled: false }
  };
  const result = await knowledge.retrieve(
    { config, status: knowledge.publicStatus(config) },
    'kidx_nestor',
    'What is our plan?',
    { memory: { search: async () => { calls += 1; } } }
  );
  assert.equal(calls, 0);
  assert.equal(result.used, false);
  assert.equal(result.status, 'disabled_pending_approved_corpus');
});

test('active retrieval uses an exact corpus source and rejects legacy or wrong-lane results', async () => {
  const config = activeConfig();
  const source = knowledge.corpusSource(config);
  const document = knowledge.stableDocument(config.documents[0]);
  const documentId = knowledge.documentId(config, document);
  let requestBody;
  const result = await knowledge.retrieve(
    { config, status: knowledge.publicStatus(config) },
    'kidx_nestor',
    'What is our plan?',
    {
      memory: { search: async (_query, options) => {
        requestBody = options;
        return [
                { text: 'LEGACY SECRET', metadata: { source: 'agent-artifacts', tags: ['nestor-lane-family'] } },
                { text: 'OPERATOR ONLY', metadata: { source, tags: ['nestor-lane-operator'] } },
                { text: 'WRONG ID', metadata: { source, tags: ['nestor-lane-family', `nestor-sha256-${document.sha256}`], documentId: 'doc-wrong' } },
                { text: 'WRONG HASH TAG', metadata: { source, tags: ['nestor-lane-family'], documentId } },
                { text: 'Family-approved fact.', metadata: { source, tags: ['nestor-lane-family', `nestor-sha256-${document.sha256}`], documentId } }
              ];
      } }
    }
  );
  assert.deepEqual(requestBody.filters, { source, tags: ['nestor-lane-family'] });
  assert.equal(result.status, 'ready');
  assert.equal(result.used, true);
  assert.equal(result.sourceCount, 1);
  assert.match(result.context, /Family-approved fact/);
  assert.doesNotMatch(result.context, /LEGACY SECRET|OPERATOR ONLY|WRONG ID|WRONG HASH TAG/);
});

test('RAG failure degrades the turn without making legacy content eligible', async () => {
  const config = activeConfig();
  const result = await knowledge.retrieve(
    { config, status: knowledge.publicStatus(config) },
    'kidx_reader',
    'papillon',
    { memory: { search: async () => { throw new Error('offline'); } } }
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.used, false);
  assert.equal(result.context, '');
  assert.equal(result.corpusFingerprint, knowledge.manifestFingerprint(config));
});

function householdConfig(overrides = {}) {
  return {
    ...activeConfig(),
    householdDocuments: { source: 'maison', lanes: ['family'], topK: 3, minScore: 0.65, ...overrides }
  };
}

test('household documents config is optional and validated', () => {
  assert.doesNotThrow(() => knowledge.validateConfig(householdConfig()));
  assert.throws(() => knowledge.validateConfig(householdConfig({ source: 'nestor-corpus' })), /RAG source name/);
  assert.throws(() => knowledge.validateConfig(householdConfig({ lanes: ['kitchen'] })), /invalid lanes/);
  assert.throws(() => knowledge.validateConfig(householdConfig({ minScore: 0.2 })), /0.3-1/);
  assert.doesNotThrow(() => knowledge.validateConfig(householdConfig({ minScore: 0.45 })));
  assert.doesNotThrow(() => knowledge.validateConfig(householdConfig({ followLinks: 0 })));
  assert.throws(() => knowledge.validateConfig(householdConfig({ followLinks: 5 })), /followLinks must be 0-3/);
});

test('a note linked from a relevant household document joins the context below the floor, with the same labels', async () => {
  const config = householdConfig();
  const calls = [];
  const household = { source: 'maison', scope: 'household', sensitivity: 'normal', documentId: '/mnt/datalake/RAG/Docs/Maison/four.md' };
  const memory = {
    async search(query, options) {
      calls.push(options);
      if (options.filters.source !== 'maison') return [];
      return [
        { text: 'Synthetic oven note.', score: 0.8, metadata: household },
        { text: 'Synthetic linked warranty.', score: 0.4, linkedFrom: household.documentId,
          metadata: { ...household, documentId: '/mnt/datalake/RAG/Docs/Maison/garantie-four.md' } },
        { text: 'Synthetic linked owner note must stay out.', score: 0.4, linkedFrom: household.documentId,
          metadata: { ...household, scope: 'owner' } }
      ];
    }
  };
  const result = await knowledge.retrieve({ config, status: knowledge.publicStatus(config) }, 'kidx_nestor', 'four', { memory });
  assert.equal(calls[1].followLinks, 2);
  assert.match(result.context, /Household document \(garantie-four\.md\):\nSynthetic linked warranty\./);
  assert.doesNotMatch(result.context, /must stay out/);
});

test('household documents enter family context only with their source, household/normal labels and score', async () => {
  const config = householdConfig();
  const calls = [];
  const household = { source: 'maison', scope: 'household', sensitivity: 'normal', documentId: '/mnt/datalake/RAG/Docs/Maison/lave-vaisselle.pdf' };
  const memory = {
    async search(query, options) {
      calls.push(options);
      if (options.filters.source !== 'maison') return [];
      return [
        { text: 'Synthetic warranty until 2028.', score: 0.8, metadata: household },
        { text: 'Synthetic owner note must stay out.', score: 0.9, metadata: { ...household, scope: 'owner' } },
        { text: 'Synthetic unlabelled note must stay out.', score: 0.9, metadata: { source: 'maison' } },
        { text: 'Synthetic other source must stay out.', score: 0.9, metadata: { ...household, source: 'agent-artifacts' } },
        { text: 'Synthetic weak match must stay out.', score: 0.5, metadata: household }
      ];
    }
  };
  const state = { config, status: knowledge.publicStatus(config) };
  const result = await knowledge.retrieve(state, 'kidx_nestor', 'garantie', { memory });
  assert.equal(result.used, true);
  assert.equal(result.sourceCount, 1);
  assert.match(result.context, /Household document \(lave-vaisselle\.pdf\):\nSynthetic warranty until 2028\./);
  assert.doesNotMatch(result.context, /must stay out/);
  assert.deepEqual(calls[1].filters, { source: 'maison', scope: 'household', sensitivity: 'normal' });
  assert.equal(calls[1].minScore, 0.65);

  calls.length = 0;
  const reader = await knowledge.retrieve(state, 'kidx_reader', 'garantie', { memory });
  assert.equal(calls.length, 1, 'a lane outside householdDocuments.lanes makes no household request');
  assert.doesNotMatch(reader.context, /Household document/);
});

test('a household documents failure keeps the approved corpus result', async () => {
  const config = householdConfig();
  const memory = {
    async search(query, options) {
      if (options.filters.source === 'maison') throw new Error('synthetic outage');
      return [];
    }
  };
  const result = await knowledge.retrieve({ config, status: knowledge.publicStatus(config) }, 'kidx_nestor', 'garantie', { memory });
  assert.equal(result.status, 'empty');
  assert.equal(result.error, undefined);
});

test('repeated household passages fill one slot and extra candidates take the others', async () => {
  const config = householdConfig({ topK: 2 });
  const household = { source: 'maison', scope: 'household', sensitivity: 'normal', documentId: '/docs/Maison/plan.pdf' };
  let requested = null;
  const memory = {
    async search(query, options) {
      if (options.filters.source !== 'maison') return [];
      requested = options.topK;
      return [
        { text: 'Synthetic footer on every page.', score: 0.71, metadata: household },
        { text: 'Synthetic  footer on every PAGE.', score: 0.71, metadata: household },
        { text: 'Synthetic footer on every page.', score: 0.71, metadata: household },
        { text: 'Synthetic wall finish legend.', score: 0.69, metadata: household },
        { text: 'Synthetic lighting legend beyond topK.', score: 0.68, metadata: household }
      ];
    }
  };
  const result = await knowledge.retrieve({ config, status: knowledge.publicStatus(config) }, 'kidx_nestor', 'finis', { memory });
  assert.equal(requested, 6);
  assert.equal(result.sourceCount, 2);
  assert.equal(result.context.match(/Synthetic footer/gi).length, 1);
  assert.match(result.context, /Synthetic wall finish legend\./);
  assert.doesNotMatch(result.context, /beyond topK/);
});
