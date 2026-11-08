'use strict';

const request = require('supertest');
const { app } = require('../../src/app');
const InferenceLog = require('../../models/InferenceLog');
const Alert = require('../../models/Alert');
const memoryReview = require('../../src/services/memoryReview/memoryReviewService');
const reports = require('../../routes/reports');
const budgets = require('../../routes/budget');
const { dadBriefing } = require('../../surfaces/household/briefing');
const { projectionCache, projectionInFlight } = require('../../surfaces/household/panel-sources');

describe('native Household briefing and budget composition', () => {
  let previousUrl, previousMail, digest, reportRead, budgetRead;

  beforeAll(async () => {
    await InferenceLog.create({ host: 'http://synthetic.example.test', model: 'synthetic-local',
      caller: 'chat', status: 'success', tokensIn: 12, tokensOut: 3, durationMs: 100 });
  });
  beforeEach(() => {
    projectionCache.clear(); projectionInFlight.clear();
    previousUrl = process.env.CORE_INTERNAL_URL; delete process.env.CORE_INTERNAL_URL;
    previousMail = app.locals.aioOpsSecretaryMail;
    app.locals.aioOpsSecretaryMail = { contractVersion: 1,
      backlog: async () => ({ unlabelled: 0 }), catchup: async () => ({}) };
    digest = jest.spyOn(memoryReview, 'buildDigest').mockImplementation(async options => ({
      runId: 'synthetic-review', pending: 2, total: 2,
      ...(options?.includeStatements === false ? {} : { statements: ['PRIVATE_STATEMENT'] })
    }));
    reportRead = jest.spyOn(reports, 'buildMorningBrief');
    budgetRead = jest.spyOn(budgets, 'buildBudgetStatus');
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('self transport unavailable'));
  });
  afterEach(() => {
    jest.restoreAllMocks(); projectionCache.clear(); projectionInFlight.clear();
    app.locals.aioOpsSecretaryMail = previousMail;
    if (previousUrl === undefined) delete process.env.CORE_INTERNAL_URL;
    else process.env.CORE_INTERNAL_URL = previousUrl;
  });

  test('real Core and Household endpoints keep the same briefing DTO and actual 24h budget without self-fetch', async () => {
    const report = (await request(app).get('/api/reports/morning-brief').expect(200)).body;
    const budget = (await request(app).get('/api/budget/status').expect(200)).body;
    const brief = (await request(app).get('/api/secretary/briefing').expect(200)).body.data;
    const desk = (await request(app).get('/api/secretary/desk').expect(200)).body.data;
    expect(brief).toEqual({ ...dadBriefing(report, []), generatedAt: expect.any(String),
      lifeAtlas: { pending: 0, href: '/atlas/#proposals' } });
    expect(desk.operations).toEqual(brief.operations);
    expect(desk.utilization).toMatchObject({ status: 'clear', period: budget.period,
      localRequests: budget.local_requests, localTokens: budget.local_tokens, localHealth: budget.budget_health,
      cloudRequests: budget.cloud_requests, cloudTokens: budget.cloud_tokens, cloudHealth: budget.cloud_health });
    expect(budget).toMatchObject({ period: '24h', total_requests: 1, total_prompt_tokens: 12, total_completion_tokens: 3 });
    expect(reportRead).toHaveBeenCalledTimes(1); // briefing and desk share the existing cache
    expect(budgetRead).toHaveBeenCalledWith();
    for (const [options] of digest.mock.calls) expect(options).toEqual({ includeStatements: false });
    expect(JSON.stringify({ brief, desk })).not.toContain('PRIVATE_STATEMENT');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('Household keeps fixed default read arguments regardless of client query fields', async () => {
    const { data } = (await request(app).get('/api/secretary/desk?period=7d&hours=168&scope=family&principal=owner').expect(200)).body;
    expect(data.utilization.period).toBe('24h');
    expect(reportRead).toHaveBeenCalledWith(); expect(budgetRead).toHaveBeenCalledWith();
    expect(digest).toHaveBeenCalledWith({ includeStatements: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('partial report collector errors keep the existing Core and Household projections and redact collector text', async () => {
    jest.spyOn(Alert, 'countDocuments').mockImplementation(() => { throw new Error('PRIVATE_COLLECTOR_ERROR'); });
    const report = (await request(app).get('/api/reports/morning-brief').expect(200)).body;
    expect(report.data.alerts).toMatchObject({ active: null, error: 'unavailable' });
    const brief = (await request(app).get('/api/secretary/briefing').expect(200)).body.data;
    expect(brief.operations).toEqual(dadBriefing(report, []).operations);
    expect(brief.memoryReview.pending).toBe(2);
    expect(JSON.stringify(brief)).not.toContain('PRIVATE_COLLECTOR_ERROR');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each(['report', 'budget'])('a native %s failure stays partial without HTTP retry', async failed => {
    (failed === 'report' ? reportRead : budgetRead).mockRejectedValue(new Error('PRIVATE_READ_ERROR'));
    const { data } = (await request(app).get('/api/secretary/desk').expect(200)).body;
    expect(data.operations.status).toBe(failed === 'report' ? 'unavailable' : 'clear');
    expect(data.utilization.status).toBe(failed === 'budget' ? 'unavailable' : 'clear');
    expect(JSON.stringify(data)).not.toContain('PRIVATE_READ_ERROR');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an explicitly configured Core retains HTTP and its DTO even when native readers are installed', async () => {
    process.env.CORE_INTERNAL_URL = 'http://remote-core.example.test/base/';
    reportRead.mockImplementation(() => { throw new Error('native report must not run'); });
    budgetRead.mockImplementation(() => { throw new Error('native budget must not run'); });
    global.fetch.mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/status')
      ? { period: '24h', total_requests: 8, budget_health: 'red', cloud_health: 'red', cloud_requests: 8 }
      : { status: 'success', data: { report: 'morning-brief', period: '24h', alerts: { active: 1, critical: 1 } } })));
    const { data } = (await request(app).get('/api/secretary/desk').expect(200)).body;
    expect(data.operations.status).toBe('critical'); expect(data.utilization.cloudRequests).toBe(8);
    expect(reportRead).not.toHaveBeenCalled(); expect(budgetRead).not.toHaveBeenCalled();
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://remote-core.example.test/base/api/reports/morning-brief', 'http://remote-core.example.test/base/api/budget/status'
    ]);
  });

  test('family-pinned devices cannot reach private reads or invoke the native producers', async () => {
    const pin = await request(app).post('/api/household/family-device/pin').send({ label: 'Synthetic family device' }).expect(201);
    const cookie = pin.headers['set-cookie'][0].split(';')[0];
    for (const url of ['/api/secretary/briefing', '/api/secretary/desk', '/api/reports/morning-brief', '/api/budget/status']) {
      const response = await request(app).get(url).set('Cookie', cookie).expect(403);
      expect(response.body.code).toBe('FAMILY_DEVICE_PINNED');
    }
    expect(reportRead).not.toHaveBeenCalled(); expect(budgetRead).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled(); expect(global.fetch).not.toHaveBeenCalled();
  });
});
