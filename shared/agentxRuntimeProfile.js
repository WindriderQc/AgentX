'use strict';

const DEFAULT_PROFILE = 'demo';
const DEMO_PROFILE = 'demo';
const FULL_PROFILE = 'full';

const DEMO_DISABLED_PREFIXES = Object.freeze([
  '/api/agent-ops',
  '/api/alerts',
  '/api/analytics/codex-subscription-value',
  '/api/analytics/codex-usage',
  '/api/analytics/federated',
  '/api/analytics/voice',
  '/api/buddy',
  '/api/cluster',
  '/api/consumers/nestor',
  '/api/data-toolbox',
  '/api/dsh',
  '/api/family',
  '/api/finance',
  '/api/household',
  '/api/images',
  '/api/hermes',
  '/api/hermes-openai',
  '/api/llmx',
  '/api/mcp',
  '/api/memory-review',
  '/api/nerve-center',
  '/api/nestor',
  '/api/ollama-watchdog',
  '/api/operations',
  '/api/openclaw',
  '/api/openclaw-ollama',
  '/api/panel',
  '/api/pipeline',
  '/api/planning',
  '/api/platform-events',
  '/api/profile',
  '/api/printer-vision',
  '/api/psyx',
  '/api/reports',
  '/api/runtime-bridges',
  '/api/secretary',
  '/api/todos',
  '/api/voice-personas',
  '/api/voix',
  '/mcp',
  '/agent-ops',
  '/backup',
  '/cluster-schedule',
  '/dad',
  '/data-toolbox',
  '/device-check',
  '/finance',
  '/images',
  '/kids',
  '/lecture',
  '/memory-review',
  '/nerve-center',
  '/panel',
  '/pipeline',
  '/planning',
  '/psyx',
  '/voice',
  '/voice-personas'
]);

function normalizeAgentXProfile(value) {
  return String(value || DEFAULT_PROFILE).trim().toLowerCase() === FULL_PROFILE
    ? FULL_PROFILE
    : DEFAULT_PROFILE;
}

function currentAgentXProfile(env = process.env) {
  return normalizeAgentXProfile(env.AGENTX_PROFILE);
}

function isDemoProfile(value = process.env.AGENTX_PROFILE) {
  return normalizeAgentXProfile(value) === DEMO_PROFILE;
}

function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}.`);
}

// Benchmark and profiling need Core's existing coordination handlers in both
// profiles. Their placement under Nerve Center does not make them operator UI.
// The yield point lets a running workload give way to interactive chat.
// Keep pin editing (including the Profiler's pin context proposal), manual swaps, maintenance, and the cockpit full-profile.
function isProductCoordination(path, method) {
  if (method === 'GET') {
    return path === '/api/nerve-center/host-preferences'
      || path === '/api/nerve-center/host-preferences/benchmark-claims/active';
  }
  if (method === 'POST') {
    return /^\/api\/nerve-center\/workload-admissions(?:\/[^/]+\/(?:heartbeat|recovery|release-receipt|yield-point))?$/.test(path)
      || /^\/api\/nerve-center\/workload-recoveries\/[^/]+\/(?:adopt|heartbeat|assert|transition|restore-hosts)$/.test(path)
      || /^\/api\/nerve-center\/host-preferences\/[^/]+\/(?:reload|benchmark-claim(?:\/[^/]+\/(?:heartbeat|release-receipt))?)$/.test(path);
  }
  return method === 'DELETE' && (
    /^\/api\/nerve-center\/(?:workload-admissions|workload-recoveries)\/[^/]+$/.test(path)
    || /^\/api\/nerve-center\/host-preferences\/[^/]+\/benchmark-claim\/[^/]+$/.test(path)
  );
}

function demoSurfaceDisabled(pathname, method = 'GET') {
  // Express routes are case-insensitive by default. Normalize only this
  // comparison; leave the original URL and opaque handler parameters intact.
  const path = String(pathname || '/').split('?')[0].toLowerCase();
  const verb = String(method).toUpperCase();
  if (isProductCoordination(path, verb === 'HEAD' ? 'GET' : verb)) return false;
  return DEMO_DISABLED_PREFIXES.some((prefix) => matchesPrefix(path, prefix));
}

function createAgentXProfileGuard(profile = currentAgentXProfile()) {
  const normalized = normalizeAgentXProfile(profile);
  return function agentXProfileGuard(req, res, next) {
    res.setHeader('X-AgentX-Profile', normalized);
    if (normalized !== DEMO_PROFILE || !demoSurfaceDisabled(req.path || req.url, req.method)) return next();

    const path = String(req.path || req.url || '').split('?')[0].toLowerCase();
    if (path.startsWith('/api/') || path === '/mcp') {
      return res.status(404).json({
        ok: false,
        error: 'This integration is not available in the Agent X demo profile.',
        code: 'AGENTX_DEMO_SURFACE_DISABLED'
      });
    }
    return res.status(404).type('text/plain').send('Not available in the Agent X demo profile.');
  };
}

module.exports = {
  DEFAULT_PROFILE,
  DEMO_PROFILE,
  FULL_PROFILE,
  DEMO_DISABLED_PREFIXES,
  normalizeAgentXProfile,
  currentAgentXProfile,
  isDemoProfile,
  demoSurfaceDisabled,
  createAgentXProfileGuard
};
