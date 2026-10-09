'use strict';

// Log method, path, status and duration. The query string is never logged:
// it can carry search text, file paths or other user content.
function createRequestLog(log) {
  return function requestLog(req, res, next) {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const path = String(req.originalUrl || req.url || '').split('?')[0];
      log(`${req.method} ${path} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  };
}

module.exports = { createRequestLog };
