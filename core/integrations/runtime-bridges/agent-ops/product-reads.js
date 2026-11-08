'use strict';

const { fetchJson } = require('./projection');
const { addCanonicalEnvelope } = require('../../../src/middleware/responseEnvelopeCompatibility');

function createProductReads({ baseUrl, nativeReads, options = {} }) {
  return async route => {
    const name = route === '/api/nerve-center/ecosystem' ? 'ecosystem'
      : route === '/api/budget/status' ? 'budget' : null;
    const read = name && nativeReads?.[name];
    if (typeof read !== 'function') return fetchJson(baseUrl, route, options);
    const startedAt = Date.now(), timeoutMs = options.timeoutMs || 5000;
    let timer, timedOut = false;
    try {
      const data = await Promise.race([
        Promise.resolve().then(read),
        new Promise((_, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(new Error('deadline')); }, timeoutMs);
        })
      ]);
      // Match the JSON boundary of the existing HTTP routes (dates, omitted
      // undefined fields and detached objects), not a second domain projection.
      const body = JSON.parse(JSON.stringify(data));
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || (name === 'budget' && (body.period !== '24h' || !Number.isFinite(body.total_requests)))) {
        throw new Error('No canonical product body');
      }
      return { ok: true, statusCode: 200, body, durationMs: Date.now() - startedAt, error: null };
    } catch {
      if (timedOut) return { ok: false, statusCode: null, body: null, durationMs: Date.now() - startedAt,
        error: `Core read timed out after ${timeoutMs}ms` };
      const message = name === 'ecosystem' ? 'Ecosystem snapshot is unavailable.' : 'Budget status unavailable';
      return { ok: false, statusCode: name === 'ecosystem' ? 503 : 500,
        body: name === 'ecosystem' ? addCanonicalEnvelope({ status: 'error',
          code: 'ECOSYSTEM_SNAPSHOT_UNAVAILABLE', message }) : { error: message },
        durationMs: Date.now() - startedAt, error: message };
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createProductReads };
