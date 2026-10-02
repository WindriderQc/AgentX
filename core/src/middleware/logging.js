/**
 * Request Logging Middleware
 * Logs all HTTP requests with timing and status information
 */

const logger = require('../../config/logger');

/**
 * Request path without its query string. Query strings can carry user text
 * (search terms, GET /api/chat/stream messages), so logs keep only the path.
 */
function requestPath(req) {
  return String(req.originalUrl || req.url || '').split('?', 1)[0];
}

/**
 * Morgan-like request logger using Winston
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  // Capture service-to-service caller identity (if present)
  const serviceCaller = req.get('x-service-caller') || null;

  // Log request
  logger.http('Incoming request', {
    method: req.method,
    url: requestPath(req),
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('user-agent'),
    correlationId: req.correlationId,
    ...(serviceCaller && { serviceCaller }),
  });

  // Capture response
  const originalSend = res.send;
  res.send = function(data) {
    res.send = originalSend;

    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'http';

    logger.log(level, 'Request completed', {
      method: req.method,
      url: requestPath(req),
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      contentLength: res.get('content-length') || 0,
      correlationId: req.correlationId,
      ...(serviceCaller && { serviceCaller }),
    });

    return res.send(data);
  };

  next();
}

/**
 * Error logging middleware
 */
function errorLogger(err, req, res, next) {
  logger.error('Request error', {
    method: req.method,
    url: requestPath(req),
    error: err.message,
    stack: err.stack,
    statusCode: err.statusCode || 500,
    correlationId: req.correlationId,
  });

  next(err);
}

module.exports = {
  requestLogger,
  errorLogger,
  requestPath,
};
