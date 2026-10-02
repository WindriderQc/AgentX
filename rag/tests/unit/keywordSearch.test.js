'use strict';

const { keywordSearch, scoreChunk, tokenizeQuery } = require('../../src/services/keywordSearch');

// ═══════════════════════════════════════════════════════════
// scoreChunk — BM25-like scoring
// ═══════════════════════════════════════════════════════════

describe('scoreChunk', () => {
  it('returns 0 for no matching terms', () => {
    expect(scoreChunk('the quick brown fox', ['elephant'])).toBe(0);
  });

  it('scores higher for more term occurrences', () => {
    const single = scoreChunk('the server crashed once', ['server']);
    const double = scoreChunk('the server hit another server', ['server']);
    expect(double).toBeGreaterThan(single);
  });

  it('scores higher when term appears earlier (position bonus)', () => {
    const early = scoreChunk('server was down and nothing else mattered at all in the log', ['server']);
    const late = scoreChunk('nothing else mattered at all in the log but the server was down', ['server']);
    expect(early).toBeGreaterThan(late);
  });

  it('handles multiple query terms', () => {
    const oneMatch = scoreChunk('the server runs fast', ['server']);
    const twoMatches = scoreChunk('the server runs fast', ['server', 'fast']);
    expect(twoMatches).toBeGreaterThan(oneMatch);
  });

  it('escapes regex special characters in terms', () => {
    // Should not throw or misbehave with regex-special chars
    const score = scoreChunk('price is $100.00 total', ['$100']);
    expect(score).toBeGreaterThan(0);
  });

  it('returns 0 for empty query terms', () => {
    expect(scoreChunk('some text', [])).toBe(0);
  });

  it('matches whole words only, not substrings', () => {
    expect(scoreChunk('the main idea', ['ia'])).toBe(0);
    expect(scoreChunk('serverless functions', ['server'])).toBe(0);
    expect(scoreChunk('l\'ia générative', ['ia'])).toBeGreaterThan(0);
  });

  it('treats accented letters as part of a word', () => {
    expect(scoreChunk('une décision rapide', ['cision'])).toBe(0);
    expect(scoreChunk('une décision rapide', ['décision'])).toBeGreaterThan(0);
    expect(scoreChunk('le café est prêt', ['caf'])).toBe(0);
  });
});

describe('tokenizeQuery', () => {
  it('keeps two-letter terms such as IA and AI', () => {
    expect(tokenizeQuery('IA locale')).toEqual(['ia', 'locale']);
    expect(tokenizeQuery('AI agents')).toEqual(['ai', 'agents']);
  });

  it('drops two-letter stopwords and single characters', () => {
    expect(tokenizeQuery('le rôle de la IA à la maison')).toEqual(['rôle', 'ia', 'maison']);
    expect(tokenizeQuery('what is a model')).toEqual(['what', 'model']);
  });

  it('strips surrounding punctuation', () => {
    expect(tokenizeQuery('"IA", (décision)? serveur.')).toEqual(['ia', 'décision', 'serveur']);
  });
});

// ═══════════════════════════════════════════════════════════
// keywordSearch — full-text search across vector store
// ═══════════════════════════════════════════════════════════

describe('keywordSearch', () => {
  function makeMockStore(documents, chunksByDoc) {
    return {
      listDocuments: jest.fn(async () => ({ documents, total: documents.length })),
      getDocumentChunks: jest.fn(async (docId) => chunksByDoc[docId] || [])
    };
  }

  const docs = [
    { documentId: 'doc-1', source: 'test', title: 'Doc 1' },
    { documentId: 'doc-2', source: 'test', title: 'Doc 2' }
  ];

  const chunks = {
    'doc-1': [
      { text: 'The MongoDB server handles all persistent storage needs.', chunkIndex: 0 },
      { text: 'Redis is used for caching temporary session data.', chunkIndex: 1 }
    ],
    'doc-2': [
      { text: 'The MongoDB cluster spans three replica nodes.', chunkIndex: 0 },
      { text: 'Backup scripts run every night at midnight.', chunkIndex: 1 }
    ]
  };

  it('returns results matching query terms', async () => {
    const store = makeMockStore(docs, chunks);
    const results = await keywordSearch(store, 'MongoDB server', { topK: 10 });

    expect(results.length).toBeGreaterThan(0);
    // Should find chunks mentioning "mongodb" or "server"
    expect(results.every(r => r.score > 0)).toBe(true);
    expect(results.every(r => r.metadata.searchType === 'keyword')).toBe(true);
  });

  it('ranks best matches first', async () => {
    const store = makeMockStore(docs, chunks);
    const results = await keywordSearch(store, 'MongoDB server', { topK: 10 });

    // First result should be doc-1 chunk-0 (contains both "MongoDB" and "server")
    expect(results[0].metadata.documentId).toBe('doc-1');
    expect(results[0].metadata.chunkIndex).toBe(0);
  });

  it('returns empty array when no terms match', async () => {
    const store = makeMockStore(docs, chunks);
    const results = await keywordSearch(store, 'quantum entanglement', { topK: 10 });

    expect(results).toEqual([]);
  });

  it('returns empty array when the query holds only stopwords', async () => {
    const store = makeMockStore(docs, chunks);
    const results = await keywordSearch(store, 'is at', { topK: 10 });

    expect(results).toEqual([]);
  });

  it('respects topK limit', async () => {
    const store = makeMockStore(docs, chunks);
    const results = await keywordSearch(store, 'the', { topK: 1 });

    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('normalizes scores to 0-1 range', async () => {
    const store = makeMockStore(docs, chunks);
    const results = await keywordSearch(store, 'MongoDB', { topK: 10 });

    for (const result of results) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it('returns empty array when store has no documents', async () => {
    const store = makeMockStore([], {});
    const results = await keywordSearch(store, 'test query', { topK: 10 });

    expect(results).toEqual([]);
  });

  it('finds two-letter terms and accented words as whole words', async () => {
    const store = makeMockStore([docs[0]], { 'doc-1': [
      { text: 'L\'IA locale tourne sur le serveur.', chunkIndex: 0 },
      { text: 'The main idea is simple.', chunkIndex: 1 },
      { text: 'Une décision a été prise.', chunkIndex: 2 }
    ] });
    const ia = await keywordSearch(store, 'IA?', { topK: 10 });
    expect(ia.map(r => r.metadata.chunkIndex)).toEqual([0]);
    const decision = await keywordSearch(store, '"Décision"', { topK: 10 });
    expect(decision.map(r => r.metadata.chunkIndex)).toEqual([2]);
  });

  it('propagates store errors to the caller', async () => {
    const store = {
      listDocuments: jest.fn(async () => { throw new Error('qdrant down'); }),
      getDocumentChunks: jest.fn()
    };
    await expect(keywordSearch(store, 'MongoDB', { topK: 10 })).rejects.toThrow('qdrant down');
  });

  it('returns empty array when getDocumentChunks is not supported', async () => {
    const store = {
      listDocuments: jest.fn(async () => ({ documents: docs, total: 2 }))
      // No getDocumentChunks method
    };
    const results = await keywordSearch(store, 'MongoDB', { topK: 10 });

    expect(results).toEqual([]);
  });

  it('gracefully handles chunks with missing text', async () => {
    const badChunks = {
      'doc-1': [
        { text: null, chunkIndex: 0 },
        { text: 'valid chunk text here', chunkIndex: 1 },
        null
      ]
    };
    const store = makeMockStore([docs[0]], badChunks);
    const results = await keywordSearch(store, 'valid chunk', { topK: 10 });

    expect(results.length).toBe(1);
    expect(results[0].metadata.chunkIndex).toBe(1);
  });

  it('includes proper metadata in results', async () => {
    const store = makeMockStore(docs, chunks);
    const results = await keywordSearch(store, 'MongoDB', { topK: 10 });

    expect(results.length).toBeGreaterThan(0);
    const first = results[0];
    expect(first.metadata).toMatchObject({
      documentId: expect.any(String),
      chunkIndex: expect.any(Number),
      source: 'test',
      searchType: 'keyword'
    });
  });
});
