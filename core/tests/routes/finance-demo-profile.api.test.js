'use strict';

process.env.AGENTX_PROFILE = 'demo';
const request = require('supertest');
const { app } = require('../../src/app');

describe('finance is unavailable in the demo profile', () => {
  test.each(['/api/finance/inbox', '/api/finance/transactions', '/api/finance/export.csv'])(
    'rejects %s with the demo-disabled code', async (path) => {
      const response = await request(app).get(path).expect(404);
      expect(response.body.code).toBe('AGENTX_DEMO_SURFACE_DISABLED');
    }
  );

  test('rejects finance writes before any route work', async () => {
    const response = await request(app).post('/api/finance/inbox/scan').send({}).expect(404);
    expect(response.body.code).toBe('AGENTX_DEMO_SURFACE_DISABLED');
  });

  test('hides the finance page', async () => {
    const response = await request(app).get('/finance').expect(404);
    expect(response.text).toContain('Not available in the Agent X demo profile.');
  });
});
