/**
 * Request Logging Middleware
 * Logs all HTTP requests with timing and status information
 */

const logger = require('../config/logger');

/**
 * Morgan-like request logger using Winston
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  
  // Log request
  logger.http('Incoming request', {
    method: req.method,
    url: req.url,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('user-agent'),
  });
  
  // Capture response
  const originalSend = res.send;
  res.send = function(data) {
    res.send = originalSend;
    
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'http';
    
    logger.log(level, 'Request completed', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      contentLength: res.get('content-length') || 0,
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
    url: req.url,
    error: err.message,
    stack: err.stack,
    statusCode: err.statusCode || 500,
  });
  
  next(err);
}

module.exports = {
  requestLogger,
  errorLogger,
};
