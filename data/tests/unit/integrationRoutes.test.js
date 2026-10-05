/**
 * Route tests for integration webhook endpoints.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

const integrationRoutes = require('../../routes/integrations.routes');
const errorHandler = require('../../middleware/errorHandler');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const toArrayFn = jest.fn().mockResolvedValue(overrides.docs || []);
  const col = {
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        limit: jest.fn(() => ({ toArray: toArrayFn }))
      }))
    })),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'int1' })
  };

  app.locals.db = { collection: jest.fn(() => col), _col: col };
  app.use('/api/v1/integrations', integrationRoutes);
  app.use(errorHandler);
  return app;
}

describe('Integration Routes', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('POST /api/v1/integrations/webhooks/clickup', () => {
    test('logs ClickUp webhook', async () => {
      const res = await request(buildApp())
        .post('/api/v1/integrations/webhooks/clickup')
        .send({ event: 'taskCreated', task_id: '123' })
        .expect(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('POST /api/v1/integrations/webhooks/:source', () => {
    test('logs generic webhook', async () => {
      const res = await request(buildApp())
        .post('/api/v1/integrations/webhooks/github')
        .send({ action: 'push', repo: 'test' })
        .expect(200);
      expect(res.body.ok).toBe(true);
    });

    test('stores a string data field as parsed JSON under its source', async () => {
      const app = buildApp();
      await request(app)
        .post('/api/v1/integrations/webhooks/github')
        .send({ data: '{"key":"val"}' })
        .expect(200);
      expect(app.locals.db._col.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'github', body: { data: { key: 'val' } } })
      );
    });
  });
});
