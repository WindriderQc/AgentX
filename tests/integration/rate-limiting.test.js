const request = require('supertest');

jest.mock('../../src/services/chatService', () => ({
  handleChatRequest: jest.fn(async () => ({
    response: 'ok',
    model: 'test-model',
    target: 'test',
    routing: null,
    ragUsed: false,
    ragSources: []
  }))
}));

function loadFreshApp() {
  const app = require('../../src/app').app;
  return app;
}

describe('Rate Limiting Middleware', () => {
  it('includes rate limit headers in response', async () => {
    const app = loadFreshApp();
    const res = await request(app)
      .get('/api/conversations')
      .set('X-Test-Client', 'rl-headers');

    expect(res.headers).toHaveProperty('ratelimit-limit');
    expect(res.headers).toHaveProperty('ratelimit-remaining');
    expect(res.headers).toHaveProperty('ratelimit-reset');
  });

  it('enforces chat rate limit', async () => {
    const app = loadFreshApp();

    for (let i = 0; i < 20; i += 1) {
      const res = await request(app)
        .post('/api/chat')
        .set('X-Test-Client', 'rl-chat')
        .send({ model: 'test-model', message: 'Test message' });
      expect(res.status).not.toBe(429);
    }

    const limited = await request(app)
      .post('/api/chat')
      .set('X-Test-Client', 'rl-chat')
      .send({ model: 'test-model', message: 'Test message' });
    expect(limited.status).toBe(429);
  });

  it('enforces strict limiter on analyze-failures', async () => {
    const app = loadFreshApp();

    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post('/api/prompts/nonexistent/analyze-failures')
        .set('X-Test-Client', 'rl-strict')
        .send({ version: 1 });
      expect(res.status).not.toBe(429);
    }

    const limited = await request(app)
      .post('/api/prompts/nonexistent/analyze-failures')
      .set('X-Test-Client', 'rl-strict')
      .send({ version: 1 });
    expect(limited.status).toBe(429);
  });

  it('enforces general API rate limit', async () => {
    const app = loadFreshApp();

    for (let i = 0; i < 100; i += 1) {
      const res = await request(app)
        .get('/api/conversations')
        .set('X-Test-Client', 'rl-general');
      expect(res.status).not.toBe(429);
    }

    const limited = await request(app)
      .get('/api/conversations')
      .set('X-Test-Client', 'rl-general');
    expect(limited.status).toBe(429);
  });
});
