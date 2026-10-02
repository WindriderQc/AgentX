'use strict';

const unavailable = () => Object.assign(new Error('The native agent catalog or turn evidence is unavailable.'),
  { statusCode: 503, code: 'NESTOR_CONTINUITY_UNAVAILABLE' });

function createNestorClient({ env = process.env, fetchImpl = (...args) => fetch(...args) } = {}) {
  return async (request, signal) => {
    if (!['agents', 'turn'].includes(request?.operation)) throw unavailable();
    if (!env.OPENCLAW_GATEWAY_URL || !env.OPENCLAW_GATEWAY_TOKEN) throw unavailable();
    const url = new URL('/api/nestor/continuity', env.OPENCLAW_GATEWAY_URL.replace(/^ws/, 'http'));
    const timeout = AbortSignal.timeout(10000);
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}` },
      body: JSON.stringify(request) }).catch(() => { throw unavailable(); });
    if (!response.ok) throw unavailable();
    const result = await response.json().catch(() => { throw unavailable(); });
    if (result?.ok !== true || result.authority !== 'openclaw.nestor' || result.operation !== request.operation) throw unavailable();
    if (request.operation === 'agents' && !Array.isArray(result.agents)) throw unavailable();
    return result;
  };
}

module.exports = { createNestorClient };
