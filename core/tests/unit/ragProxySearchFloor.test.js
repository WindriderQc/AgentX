'use strict';

const mockSearch = jest.fn();

jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: () => ({ searchSimilarChunks: mockSearch })
}));
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const request = require('supertest');
const ragRouter = require('../../routes/rag');
const { defaultMinScore } = require('../../src/services/memoryReadService');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/rag', ragRouter);
  return instance;
}

describe('Core RAG proxy search', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockSearch.mockResolvedValue([{ text: 'synthetic fact', score: 0.8, metadata: {} }]);
  });

  test('applies the memory score floor when the caller does not choose one', async () => {
    const response = await request(app()).post('/api/rag/search').send({ query: 'synthetic question', topK: 3 });

    expect(response.status).toBe(200);
    expect(response.body.data.count).toBe(1);
    expect(mockSearch).toHaveBeenCalledWith('synthetic question',
      expect.objectContaining({ topK: 3, minScore: defaultMinScore() }));
  });

  test('keeps an explicit floor and bounds topK', async () => {
    await request(app()).post('/api/rag/search').send({ query: 'q', minScore: 0.2, topK: 500 });

    expect(mockSearch).toHaveBeenCalledWith('q', expect.objectContaining({ minScore: 0.2, topK: 20 }));
  });

  test('answers 400, not 500, for an empty query', async () => {
    const response = await request(app()).post('/api/rag/search').send({ query: '  ' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('MEMORY_QUERY_INVALID');
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
