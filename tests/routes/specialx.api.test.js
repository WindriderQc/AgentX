const request = require('supertest');
const express = require('express');

let mockIsAuthenticated = false;

jest.mock('../../config/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../../src/middleware/auth', () => ({
  optionalAuth: (req, res, next) => {
    if (mockIsAuthenticated) {
      res.locals.user = { userId: 'test-user' };
    }
    next();
  },
  requireAuth: (req, res, next) => {
    if (mockIsAuthenticated) {
      res.locals.user = { userId: 'test-user' };
      return next();
    }

    return res.status(401).json({
      status: 'error',
      message: 'Authentication required'
    });
  }
}));

jest.mock('../../src/middleware/workspace', () => ({
  optionalWorkspaceContext: (req, _res, next) => {
    req.workspace = null;
    next();
  }
}));

jest.mock('../../models/SpecialX', () => ({}));
jest.mock('../../models/AutomationRun', () => ({
  find: jest.fn()
}));
jest.mock('../../src/services/automationRunnerService', () => ({
  getAutomationRunnerService: jest.fn(() => ({
    getStatus: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    tick: jest.fn(),
    enqueueTask: jest.fn()
  }))
}));
jest.mock('../../src/services/modelRouter', () => ({
  HOSTS: {},
  getRoutingStatus: jest.fn(),
  getFailoverStatus: jest.fn(() => ({})),
  switchHost: jest.fn(),
  resetToPrimary: jest.fn()
}));

const AutomationTask = require('../../models/AutomationTask');
const AutomationRun = require('../../models/AutomationRun');

jest.mock('../../models/AutomationTask', () => ({
  findById: jest.fn(),
  findOne: jest.fn()
}));

function createQueryChain(result) {
  return {
    select: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result)
  };
}

const app = express();
app.use(express.json());
app.use('/api/specialx', require('../../routes/specialx'));

describe('SpecialX task routes', () => {
  beforeEach(() => {
    mockIsAuthenticated = false;
    jest.clearAllMocks();
  });

  it('returns compact task status for unauthenticated polling', async () => {
    AutomationTask.findById.mockReturnValue(createQueryChain({
      _id: '507f1f77bcf86cd799439011',
      type: 'repo_summary',
      status: 'completed',
      lease: { leasedAt: new Date('2026-03-10T10:00:00.000Z') },
      startedAt: new Date('2026-03-10T10:00:00.000Z'),
      completedAt: new Date('2026-03-10T10:01:00.000Z'),
      lastError: null,
      resultRunId: {
        _id: '507f191e810c19729de860ea',
        summary: 'Summary ready',
        output: { markdown: '# Done' },
        artifacts: [{ name: 'report.md', kind: 'markdown', content: '# Done' }]
      }
    }));

    const response = await request(app)
      .get('/api/specialx/tasks/507f1f77bcf86cd799439011')
      .expect(200);

    expect(response.body).toEqual({
      _id: '507f1f77bcf86cd799439011',
      type: 'repo_summary',
      status: 'completed',
      claimedAt: '2026-03-10T10:00:00.000Z',
      completedAt: '2026-03-10T10:01:00.000Z',
      result: {
        runId: '507f191e810c19729de860ea',
        summary: 'Summary ready',
        output: { markdown: '# Done' },
        artifacts: [{ name: 'report.md', kind: 'markdown', content: '# Done' }]
      },
      error: null
    });
  });

  it('preserves the authenticated detail route on the same path', async () => {
    mockIsAuthenticated = true;

    AutomationTask.findOne.mockReturnValue(createQueryChain({
      _id: '507f1f77bcf86cd799439011',
      type: 'repo_summary',
      status: 'dead_letter'
    }));
    AutomationRun.find.mockReturnValue(createQueryChain([
      { _id: '507f191e810c19729de860ea', status: 'failed' }
    ]));

    const response = await request(app)
      .get('/api/specialx/tasks/507f1f77bcf86cd799439011')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.task.status).toBe('dead_letter');
    expect(response.body.data.runs).toHaveLength(1);
  });
});
