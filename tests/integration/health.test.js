const request = require('supertest');
const { app } = require('../../src/app');

describe('Health Check API', () => {
  it('should return 200 or 503 for /health endpoint', async () => {
    // Note: The status depends on the systemHealth object which defaults to checking/null.
    // In test environment, mongodb/ollama might not be connected, so it might return 503.
    // But we just want to ensure the endpoint responds.
    const res = await request(app).get('/health');
    expect([200, 503]).toContain(res.statusCode);
    expect(res.body).toHaveProperty('status');
  });

  it('should return config at /api/config', async () => {
    const res = await request(app).get('/api/config');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('ollama');
    expect(res.body.ollama).toHaveProperty('host');
  });
});
