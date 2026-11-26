'use strict';

const mockStatusForSource = jest.fn();
const mockSearchSingle = jest.fn();
const mockGetRagStatus = jest.fn();
const mockSearchRag = jest.fn();

jest.mock('../../src/services/memoryAdapters', () => ({
  statusForSource: (...args) => mockStatusForSource(...args),
  searchSingle: (...args) => mockSearchSingle(...args),
}));

jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: () => ({
    getStatus: (...args) => mockGetRagStatus(...args),
    searchSimilarChunks: (...args) => mockSearchRag(...args),
  }),
}));

const {
  getMemoryStatus,
  searchMemory,
} = require('../../src/services/nestorConsumerMemoryService');

describe('Nestor consumer memory adapters', () => {
  beforeEach(() => jest.clearAllMocks());

  it('searches the product-owned Core and RAG sources', async () => {
    mockSearchSingle.mockImplementation(async (source) => (
      [{ source, text: `${source} result`, score: 0.8, ref: `${source}:1` }]
    ));
    mockSearchRag.mockResolvedValue([{ text: 'rag result', score: 0.9, metadata: { documentId: 'doc-1' } }]);

    const result = await searchMemory({
      sources: ['agentx', 'rag'],
      query: 'routing contract',
      k: 5,
    });

    expect(result.bySource.agentx).toHaveLength(1);
    expect(result.bySource.rag[0]).toEqual(expect.objectContaining({ source: 'rag', ref: 'doc-1' }));
    expect(result.warnings).toEqual([]);
  });

  it('keeps RAG fact time, recording time and search time distinct on current owner results', async () => {
    const validFrom = '2024-08-10T14:00:00.000Z';
    const recordedAt = '2024-09-01T09:00:00.000Z';
    const readAt = '2025-02-02T10:00:00.000Z';
    mockSearchRag.mockResolvedValue([
      { text: 'Corrected fact', metadata: { documentId: 'current', validFrom, recordedAt,
        scope: 'owner', sensitivity: 'private', sourceRefs: [{ system: 'fixture', id: 'private-sentinel' }] } },
      { text: 'Replaced fact', metadata: { documentId: 'retired', invalidatedAt: validFrom, supersededBy: 'current' } },
      { text: 'Undated fact', metadata: { recordedAt, updatedAt: readAt } },
      { text: 'Legacy fact', metadata: {} },
      { text: 'Malformed metadata', metadata: { validFrom: 'http://private-sentinel', recordedAt } },
    ]);
    const result = await searchMemory({ source: 'rag', query: 'fact' }, { now: () => readAt });
    expect(result.generatedAt).toBe(readAt);
    expect(result.results.map(({ text, validFrom, recordedAt }) => [text, validFrom, recordedAt])).toEqual([
      ['Corrected fact', validFrom, recordedAt], ['Undated fact', null, recordedAt],
      ['Legacy fact', null, null], ['Malformed metadata', null, recordedAt],
    ]);
    expect(result.bySource.rag).toEqual(result.results);
    expect(result.results[0]).toMatchObject({ ref: 'current', scope: 'owner', sensitivity: 'private' });
    expect(JSON.stringify(result)).not.toContain('private-sentinel');
    expect(mockSearchRag.mock.calls[0][1]).not.toHaveProperty('includeHistory');
  });

  it('identifies a bounded excerpt and keeps the last Unicode character intact', async () => {
    mockSearchRag.mockResolvedValue([{ text: 'a'.repeat(3999) + '🌓' }, { text: 'b'.repeat(4000) }]);
    const { results } = await searchMemory({ source: 'rag', query: 'fixture' });
    expect(results[0]).toMatchObject({ text: 'a'.repeat(3999), truncated: true });
    expect(results[1].text).toHaveLength(4000);
    expect(results[1]).not.toHaveProperty('truncated');
  });

  it('rejects unknown sources and oversized queries', async () => {
    await expect(searchMemory({ source: 'unknown', query: 'x' }))
      .rejects.toEqual(expect.objectContaining({ code: 'UNKNOWN_MEMORY_SOURCE' }));
    await expect(searchMemory({ source: 'agentx', query: 'x'.repeat(2001) }))
      .rejects.toEqual(expect.objectContaining({ code: 'MEMORY_QUERY_TOO_LARGE' }));
  });

  it('returns fail-soft status for every requested source', async () => {
    mockStatusForSource.mockImplementation(async (source) => {
      if (source === 'agentx') throw new Error('offline');
      return { source, available: true };
    });
    mockGetRagStatus.mockResolvedValue({
      healthy: true,
      documentCount: 4,
      vectorStore: { healthy: true, url: 'http://private-rag:6333' },
    });
    const result = await getMemoryStatus(['agentx', 'rag']);
    expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
    expect(result.readOnly).toBe(true);
    expect(result.sources.rag.available).toBe(true);
    expect(JSON.stringify(result)).not.toContain('http://private-rag:6333');
    expect(result.sources.rag.vectorStore).not.toHaveProperty('url');
    expect(result.sources.agentx.available).toBe(false);
    expect(result.warnings[0]).toEqual(expect.objectContaining({ source: 'agentx' }));
  });
});
