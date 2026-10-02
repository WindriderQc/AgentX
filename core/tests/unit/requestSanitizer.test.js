const express = require('express');
const request = require('supertest');
const { createRequestSanitizer } = require('../../src/middleware/requestSanitizer');

function buildApp(logger) {
  const app = express();
  app.use(express.json());
  app.use(createRequestSanitizer({ logger }));
  app.post('*', (req, res) => res.json(req.body));
  return app;
}

const toolBody = {
  model: 'synthetic-model',
  tools: [{
    type: 'function',
    function: {
      name: 'lookup',
      parameters: { $schema: 'http://json-schema.org/draft-07/schema#', $ref: '#/definitions/args' }
    }
  }]
};

describe('request sanitizer', () => {
  let logger;
  beforeEach(() => { logger = { warn: jest.fn() }; });

  test.each([
    '/api/openclaw-ollama/api/chat',
    '/api/hermes-openai/v1/chat/completions'
  ])('forwards inference proxy bodies unchanged on %s', async (path) => {
    const response = await request(buildApp(logger)).post(path).send(toolBody).expect(200);
    expect(response.body).toEqual(toolBody);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('still strips MongoDB operators from other routes', async () => {
    const response = await request(buildApp(logger))
      .post('/api/chat')
      .send({ filter: { $where: 'sleep(1000)' } })
      .expect(200);
    expect(response.body).toEqual({ filter: { _where: 'sleep(1000)' } });
    expect(logger.warn).toHaveBeenCalledWith('Sanitized malicious input', expect.objectContaining({ path: '/api/chat' }));
  });

  test('does not exempt look-alike prefixes', async () => {
    const response = await request(buildApp(logger))
      .post('/api/openclaw-ollama-evil/api/chat')
      .send({ $gt: 1 })
      .expect(200);
    expect(response.body).toEqual({ _gt: 1 });
  });
});
