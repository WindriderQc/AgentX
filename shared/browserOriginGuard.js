'use strict';

const { getPublicUrls } = require('./browserPublicUrls');

// Browsers on a foreign site must neither read nor mutate AgentX APIs. CORS
// reflects only AgentX's own browser origins, and a state-changing request a
// browser marks as cross-site is refused. Requests without these browser
// headers (curl, harnesses, service-to-service calls) are unaffected.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const ALLOWED_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';

function allowedBrowserOrigins(urls = Object.values(getPublicUrls())) {
  const origins = new Set();
  for (const value of urls) {
    let url;
    try { url = new URL(String(value || '')); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    origins.add(url.origin);
    const port = url.port ? `:${url.port}` : '';
    for (const host of LOOPBACK_HOSTS) origins.add(`${url.protocol}//${host}${port}`);
  }
  return origins;
}

function appendVary(res, field) {
  const current = String(res.getHeader('Vary') || '');
  const fields = current.split(',').map((item) => item.trim()).filter(Boolean);
  if (fields.includes('*') || fields.some((item) => item.toLowerCase() === field.toLowerCase())) return;
  res.setHeader('Vary', [...fields, field].join(', '));
}

function createBrowserOriginGuard(options = {}) {
  const allowed = options.allowedOrigins
    ? new Set(options.allowedOrigins)
    : allowedBrowserOrigins(options.publicUrls);

  return function browserOriginGuard(req, res, next) {
    const method = String(req.method || 'GET').toUpperCase();
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (!SAFE_METHODS.has(method) && fetchSite === 'cross-site') {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        ok: false,
        status: 'error',
        code: 'CROSS_SITE_REQUEST_REJECTED',
        message: 'AgentX refuses state-changing requests sent by a browser from another site.',
      }));
      return;
    }

    appendVary(res, 'Origin');
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return next();

    res.setHeader('Access-Control-Allow-Origin', origin);
    if (method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      const requested = req.headers['access-control-request-headers'];
      if (requested) {
        res.setHeader('Access-Control-Allow-Headers', requested);
        appendVary(res, 'Access-Control-Request-Headers');
      }
      res.statusCode = 204;
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }
    return next();
  };
}

module.exports = { allowedBrowserOrigins, createBrowserOriginGuard };
