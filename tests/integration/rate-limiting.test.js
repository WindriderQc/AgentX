const request = require('supertest');

function loadFreshApp() {
  jest.resetModules();
  return require('../../src/app').app;
}

describe('Rate Limiting Middleware', () => {
  it('includes rate limit headers in response', async () => {
    const app = loadFreshApp();
    const res = await request(app).get('/api/conversations');

    expect(res.headers).toHaveProperty('ratelimit-limit');
    expect(res.headers).toHaveProperty('ratelimit-remaining');
    expect(res.headers).toHaveProperty('ratelimit-reset');
  });

  it('enforces chat rate limit', async () => {
    const app = loadFreshApp();

    for (let i = 0; i < 20; i += 1) {
      const res = await request(app)
        .post('/api/chat')
        .send({ message: 'Test without model' });
      expect(res.status).not.toBe(429);
    }

    const limited = await request(app)
      .post('/api/chat')
      .send({ message: 'Test without model' });
    expect(limited.status).toBe(429);
  });

  it('enforces strict limiter on analyze-failures', async () => {
    const app = loadFreshApp();

    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post('/api/prompts/nonexistent/analyze-failures')
        .send({ version: 1 });
      expect(res.status).not.toBe(429);
    }

    const limited = await request(app)
      .post('/api/prompts/nonexistent/analyze-failures')
      .send({ version: 1 });
    expect(limited.status).toBe(429);
  });

  it('enforces general API rate limit', async () => {
    const app = loadFreshApp();

    for (let i = 0; i < 100; i += 1) {
      const res = await request(app).get('/api/conversations');
      expect(res.status).not.toBe(429);
    }

    const limited = await request(app).get('/api/conversations');
    expect(limited.status).toBe(429);
  });
});
