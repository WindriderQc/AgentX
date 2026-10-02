'use strict';

jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');
const { forAudience } = require('../../src/services/memoryReadService');
const knowledge = require('../../surfaces/household/nestor-knowledge');
const { handleMcpMessage } = require('../../src/services/mcpSkillBus');
const { buildRagContext } = require('../../src/services/chat/ragContextBuilder');

afterEach(() => jest.resetAllMocks());

test('Core grants owner recall across scopes and excludes private, PsyX and unclassified data from family recall', async () => {
  const rows = [
    { text: 'Synthetic family fact', metadata: { scope: 'household', sensitivity: 'normal' } },
    { text: 'Synthetic private household fact', metadata: { scope: 'household', sensitivity: 'private' } },
    { text: 'Synthetic owner fact', metadata: { scope: 'owner', sensitivity: 'private' } },
    { text: 'Synthetic PsyX fact', metadata: { source: 'psyx', scope: 'private_domain', sensitivity: 'highly_private' } },
    { text: 'Synthetic historical unclassified fact', metadata: {} }
  ];
  fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, data: { results: rows } }) });
  const family = forAudience('household');
  expect(await family.search('Synthetic fact', {
    audience: 'owner', filters: { source: 'synthetic', scope: 'private_domain', sensitivity: 'highly_private' }
  })).toEqual([rows[0]]);
  expect(JSON.parse(fetch.mock.calls[0][1].body).filters).toEqual({
    source: 'synthetic', scope: 'household', sensitivity: 'normal'
  });
  expect(await forAudience('owner').search('Synthetic fact')).toEqual(rows);
  const tool = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'rag_search', arguments: { query: 'Synthetic fact', audience: 'owner',
      filters: { scope: 'owner', sensitivity: 'private' } } }
  }, { memory: family });
  expect(tool.result.structuredContent.results).toEqual([rows[0]]);
  const context = await buildRagContext('Synthetic fact', {}, { memory: family });
  expect(context.ragContext).toContain('Synthetic family fact');
  expect(context.ragContext).not.toMatch(/private|PsyX|unclassified/);
  expect(() => forAudience('unknown')).toThrow('server-selected');
});

test('the approved family corpus still excludes private matches before building conversation context', async () => {
  const config = {
    schemaVersion: 1, corpusId: 'synthetic-family', status: 'active',
    retrieval: { enabled: true, topK: 4, minScore: 0.3, timeoutMs: 1000, maxContextCharacters: 1200 },
    documents: [{ relativePath: 'synthetic.md', sha256: 'a'.repeat(64), lanes: ['family'] }]
  };
  const metadata = { source: knowledge.corpusSource(config),
    documentId: knowledge.documentId(config, config.documents[0]),
    tags: ['nestor-lane-family', `nestor-sha256-${'a'.repeat(64)}`] };
  const results = [
    { text: 'Synthetic permitted fact', metadata: { ...metadata, scope: 'household', sensitivity: 'normal' } },
    { text: 'Synthetic private fact must stay out', metadata: { ...metadata, scope: 'owner', sensitivity: 'private' } },
    { text: 'Synthetic unclassified fact must stay out', metadata }
  ];
  fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ data: { results } }) });
  const result = await knowledge.retrieve({ config, status: knowledge.publicStatus(config) },
    'kidx_nestor', 'Synthetic fact', { memory: forAudience('household') });
  expect(result).toMatchObject({ status: 'ready', used: true, sourceCount: 1 });
  expect(result.context).toContain('Synthetic permitted fact');
  expect(result.context).not.toContain('must stay out');
  expect(fetch.mock.calls[0][1].timeout).toBe(1000);
});

test('memory reads apply a similarity floor unless the caller chooses one or uses hybrid scores', async () => {
  const { defaultMinScore, DEFAULT_MIN_SCORE } = require('../../src/services/memoryReadService');
  const ragClient = { searchSimilarChunks: jest.fn().mockResolvedValue([]) };
  const owner = forAudience('owner', { ragClient });
  await owner.search('Synthetic fact');
  await owner.search('Synthetic fact', { minScore: 0.2 });
  await owner.search('Synthetic fact', { hybrid: true });
  const [floored, explicit, hybrid] = ragClient.searchSimilarChunks.mock.calls.map(call => call[1]);
  expect(floored.minScore).toBe(DEFAULT_MIN_SCORE);
  expect(explicit.minScore).toBe(0.2);
  expect(hybrid).not.toHaveProperty('minScore');
  expect(defaultMinScore('0.72')).toBe(0.72);
  expect(defaultMinScore('2')).toBe(DEFAULT_MIN_SCORE);
  expect(defaultMinScore('')).toBe(DEFAULT_MIN_SCORE);
});
