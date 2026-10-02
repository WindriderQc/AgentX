/**
 * Route tests for the non-dedup janitor endpoints (analyze, suggest, policies).
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../services/janitorAI', () => ({
  callAI: jest.fn(),
  ACTIONS: { triage: {}, resolve_duplicates: {}, analyze_path: {}, chat: {} }
}));

jest.mock('../../services/janitorStrategy', () => ({
  getPolicy: jest.fn(),
  buildDuplicatePlan: jest.fn()
}));

jest.mock('../../services/janitorService', () => {
  const actual = jest.requireActual('../../services/janitorService');
  return {
    ...actual,
    analyzeDirectory: jest.fn(),
    buildSuggestions: jest.fn(),
    executeCleanup: jest.fn(),
    resolveAllowedPath: jest.fn()
  };
});

const janitorService = require('../../services/janitorService');
const janitorAI = require('../../services/janitorAI');
const janitorStrategy = require('../../services/janitorStrategy');
const janitorRoutes = require('../../routes/janitor.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.locals.db = {};
  app.use('/api/v1/janitor', janitorRoutes);
  app.use((err, req, res, _next) => {
    res.status(500).json({ status: 'error', message: err.message });
  });
  return app;
}

describe('POST /api/v1/janitor/analyze', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 400 when path is missing', async () => {
    const res = await request(buildApp()).post('/api/v1/janitor/analyze').send({});
    expect(res.status).toBe(400);
  });

  test('returns 403 for blocked path', async () => {
    janitorService.resolveAllowedPath.mockResolvedValue({ ok: false, reason: 'Blocked by safety policy' });
    const res = await request(buildApp()).post('/api/v1/janitor/analyze').send({ path: '/etc' });
    expect(res.status).toBe(403);
  });

  test('returns analysis data for allowed path', async () => {
    janitorService.resolveAllowedPath.mockResolvedValue({ ok: true, path: '/mnt/datalake/test', realPath: '/mnt/datalake/test' });
    janitorService.analyzeDirectory.mockResolvedValue({
      path: '/mnt/datalake/test', total_files: 10, scanned_files: 8,
      total_size: 5000, duplicates_count: 2, wasted_space: 1000,
      duplicate_groups: [], _fileMap: new Map()
    });

    const res = await request(buildApp()).post('/api/v1/janitor/analyze').send({ path: '/mnt/datalake/test' });
    expect(res.status).toBe(200);
    expect(res.body.data.total_files).toBe(10);
    expect(res.body.data._fileMap).toBeUndefined(); // internal map stripped
  });
});

describe('POST /api/v1/janitor/suggest', () => {
  beforeEach(() => jest.clearAllMocks());

  test('incomplete policy reports decisions and produces no duplicate suggestion', async () => {
    janitorService.resolveAllowedPath.mockResolvedValue({
      ok: true,
      realPath: '/mnt/datalake/test'
    });
    janitorService.analyzeDirectory.mockResolvedValue({
      duplicate_groups: [{ hash: 'sha', count: 2, size: 100 }],
      _fileMap: new Map([['sha', [
        { path: '/mnt/datalake/test/a', mtime: 1 },
        { path: '/mnt/datalake/test/b', mtime: 2 }
      ]]])
    });
    janitorService.buildSuggestions.mockReturnValue([]);
    janitorStrategy.getPolicy.mockResolvedValue({ duplicateSurvivor: null });
    janitorStrategy.buildDuplicatePlan.mockReturnValue({
      status: 'awaiting_policy',
      decisions_required: [{ field: 'duplicateSurvivor' }],
      proposals: []
    });

    const res = await request(buildApp()).post('/api/v1/janitor/suggest').send({
      path: '/mnt/datalake/test',
      policies: ['delete_duplicates']
    });

    expect(res.status).toBe(200);
    expect(res.body.data.strategy_status).toBe('awaiting_policy');
    expect(res.body.data.decisions_required).toEqual([{ field: 'duplicateSurvivor' }]);
    expect(res.body.data.suggestions).toEqual([]);
    expect(res.body.data.confirmation_token).toBeUndefined();
    expect(janitorService.buildSuggestions).toHaveBeenCalledWith(
      expect.any(Object), []
    );
  });
});

describe('POST /api/v1/janitor/execute', () => {
  beforeEach(() => jest.clearAllMocks());

  test('is retired and cannot invoke cleanup', async () => {
    const res = await request(buildApp()).post('/api/v1/janitor/execute').send({
      files: ['/mnt/datalake/a.txt'], confirmation_token: 'caller-minted', dry_run: false
    });
    expect(res.status).toBe(404);
    expect(janitorService.executeCleanup).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/janitor/policies', () => {
  test('returns policy list', async () => {
    const res = await request(buildApp()).get('/api/v1/janitor/policies');
    expect(res.status).toBe(200);
    expect(res.body.data.policies.length).toBeGreaterThan(0);
  });
});

describe('POST /api/v1/janitor/ai', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 400 when action is missing', async () => {
    const res = await request(buildApp()).post('/api/v1/janitor/ai').send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/action required/);
  });

  test('returns 400 for unknown action', async () => {
    const res = await request(buildApp()).post('/api/v1/janitor/ai').send({ action: 'hack' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid action/);
  });

  test('calls AI and returns result', async () => {
    janitorAI.callAI.mockResolvedValue({
      action: 'chat',
      result: { text: 'Your storage looks healthy.' },
      model: 'qwen2.5:7b',
      duration_ms: 500
    });

    const res = await request(buildApp()).post('/api/v1/janitor/ai').send({
      action: 'chat',
      context: { message: 'how is my storage?' }
    });

    expect(res.status).toBe(200);
    expect(res.body.data.result.text).toContain('healthy');
    expect(janitorAI.callAI).toHaveBeenCalledWith('chat', { message: 'how is my storage?' });
  });

  test('returns 503 when Ollama is unreachable', async () => {
    janitorAI.callAI.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(buildApp()).post('/api/v1/janitor/ai').send({
      action: 'chat',
      context: { message: 'hello' }
    });

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/AI service unavailable/);
  });
});
