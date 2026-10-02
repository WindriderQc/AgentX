'use strict';

/**
 * Similarity floors depend on the embedding model, so each nomic-calibrated
 * floor is overridable per instance while its code default stays unchanged.
 */

const { scoreFloor } = require('../../src/helpers/scoreFloor');

const ENV_KEYS = ['MEMORY_REVIEW_RAG_MIN_SCORE', 'MEMORY_REVIEW_DUPLICATE_SCORE', 'CHAT_RAG_MIN_SCORE'];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('scoreFloor', () => {
  it('accepts a 0-1 value and falls back otherwise', () => {
    expect(scoreFloor('0.45', 0.6)).toBe(0.45);
    expect(scoreFloor(0, 0.6)).toBe(0);
    expect(scoreFloor(undefined, 0.6)).toBe(0.6);
    expect(scoreFloor('', 0.6)).toBe(0.6);
    expect(scoreFloor(' ', 0.6)).toBe(0.6);
    expect(scoreFloor('1.2', 0.6)).toBe(0.6);
    expect(scoreFloor('-0.1', 0.6)).toBe(0.6);
    expect(scoreFloor('abc', 0.6)).toBe(0.6);
  });
});

describe('memory review dedup floors', () => {
  function loadDedup() {
    let dedup;
    jest.isolateModules(() => { dedup = require('../../src/services/memoryReview/dedupService'); });
    return dedup;
  }

  it('keeps the nomic defaults when unset', () => {
    const dedup = loadDedup();
    expect(dedup.RAG_MIN_SCORE).toBe(0.55);
    expect(dedup.DUPLICATE_SCORE).toBe(0.8);
  });

  it('reads instance overrides and applies them to searches and duplicate marks', async () => {
    process.env.MEMORY_REVIEW_RAG_MIN_SCORE = '0.5';
    process.env.MEMORY_REVIEW_DUPLICATE_SCORE = '0.7';
    const dedup = loadDedup();
    expect(dedup.RAG_MIN_SCORE).toBe(0.5);
    expect(dedup.DUPLICATE_SCORE).toBe(0.7);

    const ragClient = { searchSimilarChunks: jest.fn().mockResolvedValue([
      { score: 0.72, metadata: { documentId: 'existing' } }
    ]) };
    const { byId } = await dedup.searchCandidateDuplicates(
      [{ candidateId: 'c1', statement: 'Le souper est à 18 h.' }],
      { ragClient }
    );
    expect(ragClient.searchSimilarChunks.mock.calls[0][1].minScore).toBe(0.5);
    expect(byId.get('c1')).toHaveLength(2);
  });
});

describe('chat RAG context floor', () => {
  it('uses CHAT_RAG_MIN_SCORE for semantic searches only', async () => {
    const { buildRagContext } = require('../../src/services/chat/ragContextBuilder');
    const store = { searchSimilarChunks: jest.fn().mockResolvedValue([]) };
    process.env.CHAT_RAG_MIN_SCORE = '0.42';
    await buildRagContext('question', store, {});
    await buildRagContext('question', store, { ragOptions: { ragHybrid: true } });
    expect(store.searchSimilarChunks.mock.calls.map(([, options]) => options.minScore)).toEqual([0.42, 0.15]);
  });
});
