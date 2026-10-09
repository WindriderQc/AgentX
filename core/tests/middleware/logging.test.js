'use strict';

jest.mock('../../config/logger', () => ({
  http: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
}));

const logger = require('../../config/logger');
const { requestLogger, errorLogger, requestPath } = require('../../src/middleware/logging');

function createReq(originalUrl) {
  return {
    method: 'GET',
    originalUrl,
    url: originalUrl,
    ip: '127.0.0.1',
    correlationId: 'corr-1',
    get: () => undefined,
  };
}

describe('request logging', () => {
  beforeEach(() => jest.clearAllMocks());

  it('strips the query string from a request path', () => {
    expect(requestPath(createReq('/api/history/search?query=private%20words'))).toBe('/api/history/search');
    expect(requestPath(createReq('/health'))).toBe('/health');
    expect(requestPath({ url: '/x?y=1' })).toBe('/x');
    expect(requestPath({})).toBe('');
  });

  it('logs 4xx/5xx completions without the query string', () => {
    const req = createReq('/api/chat/stream?message=secret%20text');
    const originalSend = jest.fn(() => 'sent');
    const res = { statusCode: 500, send: originalSend, get: () => '12' };
    const next = jest.fn();

    requestLogger(req, res, next);
    expect(next).toHaveBeenCalled();
    res.send('body');

    expect(originalSend).toHaveBeenCalledWith('body');
    expect(logger.http).toHaveBeenCalledWith('Incoming request', expect.objectContaining({ url: '/api/chat/stream' }));
    expect(logger.log).toHaveBeenCalledWith('warn', 'Request completed', expect.objectContaining({
      method: 'GET',
      url: '/api/chat/stream',
      statusCode: 500,
      correlationId: 'corr-1',
    }));
    const logged = JSON.stringify([logger.http.mock.calls, logger.log.mock.calls]);
    expect(logged).not.toContain('secret');
  });

  it('logs request errors without the query string', () => {
    const req = createReq('/api/search?q=private');
    const err = Object.assign(new Error('boom'), { statusCode: 502 });
    const next = jest.fn();

    errorLogger(err, req, {}, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(logger.error).toHaveBeenCalledWith('Request error', expect.objectContaining({
      url: '/api/search',
      error: 'boom',
      statusCode: 502,
    }));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private');
  });
});
