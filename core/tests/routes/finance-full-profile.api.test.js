'use strict';

process.env.AGENTX_PROFILE = 'full';
const request = require('supertest');
const { app } = require('../../src/app');

describe('finance stays reachable in the full profile', () => {
  test('serves the inbox status', async () => {
    const response = await request(app).get('/api/finance/inbox');
    expect(response.headers['x-agentx-profile']).toBe('full');
    expect(response.body.code).not.toBe('AGENTX_DEMO_SURFACE_DISABLED');
    expect(response.status).toBe(200);
  });

  test('renders the finance page', async () => {
    const response = await request(app).get('/finance').expect(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
  });
});
