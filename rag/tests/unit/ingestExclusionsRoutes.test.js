'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/nasFileIndexState', () => ({
  listExcludedFiles: jest.fn(),
  restoreExcludedFile: jest.fn()
}));

const state = require('../../src/services/nasFileIndexState');
const router = require('../../routes/ingestExclusions.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rag', router);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('excluded files routes', () => {
  it('lists excluded files', async () => {
    state.listExcludedFiles.mockResolvedValue([{ path: '/notes/a.md', excludedAt: null }]);
    const res = await request(buildApp()).get('/api/rag/ingestion/excluded');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ files: [{ path: '/notes/a.md', excludedAt: null }], count: 1 });
  });

  it('returns 503 when MongoDB is unavailable', async () => {
    state.listExcludedFiles.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/rag/ingestion/excluded');
    expect(res.status).toBe(503);
  });

  it('restores an excluded file so the next scan ingests it', async () => {
    state.restoreExcludedFile.mockResolvedValue(1);
    const res = await request(buildApp())
      .post('/api/rag/ingestion/excluded/restore')
      .send({ path: '/notes/a.md' });
    expect(res.status).toBe(200);
    expect(state.restoreExcludedFile).toHaveBeenCalledWith('/notes/a.md');
    expect(res.body.data).toEqual({ path: '/notes/a.md', restored: 1 });
  });

  it('rejects a missing path and reports an unknown one', async () => {
    const missing = await request(buildApp()).post('/api/rag/ingestion/excluded/restore').send({});
    expect(missing.status).toBe(400);
    expect(state.restoreExcludedFile).not.toHaveBeenCalled();

    state.restoreExcludedFile.mockResolvedValue(0);
    const unknown = await request(buildApp())
      .post('/api/rag/ingestion/excluded/restore')
      .send({ path: '/notes/never.md' });
    expect(unknown.status).toBe(404);
  });
});
