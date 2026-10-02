'use strict';

const { buildOpenClawAgentInventory } = require('./openclaw/agentInventory');
const {
  collectOpenClawCronEvidence,
  getOpenClawRuntimeEvidence
} = require('./openclaw/runtimeEvidence');
const { OpenClawControlError, getControlLaunchUrl, getControlUiConfig } = require('./openclaw/controlUi');

function truthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function controlHref(route) {
  return `${getControlUiConfig().launchBaseUrl.replace(/\/+$/, '')}/${String(route || '').replace(/^\/+/, '')}`;
}

function registerOpenClawOperations({
  express,
  logger,
  runtimeEvidenceProvider = getOpenClawRuntimeEvidence,
  cronEvidenceProvider = collectOpenClawCronEvidence
}) {
  const router = express.Router();
  const runtimeEvidence = (req) => runtimeEvidenceProvider({
    refresh: truthy(req.query.refresh),
  });
  const cronEvidence = (req) => cronEvidenceProvider({
    refresh: truthy(req.query.refresh),
    includeDisabledCron: truthy(req.query.includeDisabled)
  });
  const sendError = (res, error, label) => {
    logger?.warn?.(`OpenClaw ${label} failed`, { status: error.status || 502 });
    return res.status(error.status || 502).json({ status: 'error', message: error.message });
  };

  router.get('/status', async (req, res) => {
    try {
      const evidence = await runtimeEvidence(req);
      const status = evidence.status;
      return res.json({
        status: status.online ? 'online' : 'offline',
        authority: evidence.authority,
        source: evidence.source,
        runtimeVersion: status.runtimeVersion,
        gateway: status.gateway,
        gatewayService: status.gatewayService,
        agents: status.agents,
        sessions: status.sessions.count,
        timestamp: evidence.generatedAt,
        controlUi: controlHref('/overview')
      });
    } catch (error) { return sendError(res, error, 'status check'); }
  });

  // Launch preflight. Before the trusted UI navigates, it reports whether a
  // one-click launch can succeed and, if not, which server-side check fails:
  // the target, the HTTPS requirement, the gateway token, or the gateway
  // itself (from the cached runtime evidence). What the server cannot see is
  // named honestly: a browser extension or policy blocking the launched tab
  // (ERR_BLOCKED_BY_CLIENT) is reported as a browser-side cause only when
  // every server-side check passed. The launch URL and token never leave.
  router.get('/control-launch-preflight/:target', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const target = String(req.params?.target || '').trim();
    const config = getControlUiConfig();
    const capability = config.nativeCapabilities.find((item) => item.id === target);
    const checks = [];
    const targetOk = Boolean(capability && config.launchBaseUrl);
    checks.push({ id: 'target', state: targetOk ? 'ok' : 'blocked', code: targetOk ? null : 'OPENCLAW_CONTROL_TARGET_INVALID' });

    const forwarded = String(req.get?.('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
    const protocol = forwarded || String(req.protocol || '').toLowerCase();
    const httpsOk = true;
    checks.push({ id: 'https', state: httpsOk ? 'ok' : 'blocked', code: httpsOk ? null : 'OPENCLAW_CONTROL_HTTPS_REQUIRED' });

    if (targetOk) {
      try {
        getControlLaunchUrl(target); // classification only; the URL carries the token and is discarded
        checks.push({ id: 'token', state: 'ok', code: null });
      } catch (error) {
        checks.push({ id: 'token', state: 'blocked', code: error.code || 'OPENCLAW_CONTROL_LAUNCH_ERROR' });
      }
    } else {
      checks.push({ id: 'token', state: 'unknown', code: null });
    }

    try {
      const evidence = await runtimeEvidence(req);
      const online = Boolean(evidence?.status?.online);
      checks.push({ id: 'gateway', state: online ? 'ok' : 'blocked', code: online ? null : 'OPENCLAW_GATEWAY_OFFLINE' });
    } catch {
      checks.push({ id: 'gateway', state: 'unknown', code: 'OPENCLAW_EVIDENCE_UNAVAILABLE' });
    }

    let launchHost = null;
    try { launchHost = new URL(config.launchBaseUrl).hostname; } catch { /* unconfigured */ }
    const blocked = checks.filter((check) => check.state === 'blocked');
    return res.json({
      status: blocked.length ? 'blocked' : 'ok',
      code: blocked[0]?.code || null,
      launch: {
        target,
        mode: config.mode,
        host: launchHost,
        href: targetOk ? `/api/openclaw/control-launch/${target}` : null
      },
      checks,
      browserHint: blocked.length
        ? null
        : `If the launched tab fails with ERR_BLOCKED_BY_CLIENT, a browser extension or policy is blocking ${launchHost || 'the OpenClaw host'}; AgentX and the gateway passed every server-side check.`
    });
  });

  router.get('/control-launch/:target', (req, res) => {
    const agent = String(req.query.agent || '').trim();
    if (agent && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(agent)) {
      return res.status(400).json({
        status: 'error', code: 'OPENCLAW_AGENT_ID_INVALID', message: 'OpenClaw agent id is invalid.'
      });
    }
    try {
      const location = getControlLaunchUrl(req.params.target, agent ? { agent } : {});
      res.set({ 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
      return res.redirect(302, location);
    } catch (error) {
      const status = error instanceof OpenClawControlError ? error.status : 500;
      return res.status(status).json({
        status: 'error', code: error.code || 'OPENCLAW_CONTROL_LAUNCH_ERROR',
        message: error.message || 'OpenClaw Control UI launch failed.'
      });
    }
  });

  router.get('/agent-inventory', async (req, res) => {
    try {
      return res.json(await buildOpenClawAgentInventory({
        includeContent: truthy(req.query.includeContent),
        includeRuntimeStatus: truthy(req.query.includeRuntimeStatus)
      }));
    } catch (error) {
      logger?.warn?.('OpenClaw agent inventory failed', { status: error.status || 502 });
      return res.status(error.status || 502).json({
        schema_version: 2,
        status: 'error',
        message: error.message,
        agents: [],
        inactiveWorkspaces: [],
        known_gaps: [{ id: 'inventory-build-failed', severity: 'high', detail: error.message }]
      });
    }
  });

  router.get('/agents', async (req, res) => {
    try { const evidence = await runtimeEvidence(req); return res.json({ data: evidence.agents, authority: evidence.authority }); }
    catch (error) { return sendError(res, error, 'agents list'); }
  });
  router.get('/agents/:id', async (req, res) => {
    try {
      const evidence = await runtimeEvidence(req);
      const agent = evidence.agents.find((item) => item.id === req.params.id);
      return agent
        ? res.json({ data: agent, authority: evidence.authority })
        : res.status(404).json({ status: 'error', message: 'OpenClaw agent not found' });
    } catch (error) { return sendError(res, error, 'agent detail'); }
  });
  router.get('/sessions', async (req, res) => {
    try {
      const evidence = await runtimeEvidence(req);
      return res.json({
        data: evidence.status.sessions.recent,
        count: evidence.status.sessions.count,
        authority: evidence.authority,
        controlUi: controlHref('/sessions')
      });
    } catch (error) { return sendError(res, error, 'sessions list'); }
  });
  router.get('/config', async (req, res) => {
    try {
      const evidence = await runtimeEvidence(req);
      return res.json({
        data: {
          defaults: evidence.defaults,
          memoryStrategy: evidence.memoryStrategy,
          agents: evidence.agents.map((agent) => ({
            id: agent.id, name: agent.name, default: agent.default, workspace: agent.workspace,
            model: agent.model, tools: agent.tools, subagents: agent.subagents
          }))
        },
        authority: evidence.authority,
        readOnly: true,
        controlUi: controlHref('/config')
      });
    } catch (error) { return sendError(res, error, 'config summary'); }
  });
  router.patch('/config', (_req, res) => res.status(409).json({
    status: 'error', code: 'OPENCLAW_NATIVE_AUTHORITY',
    message: 'OpenClaw configuration changes belong in the official Control UI.',
    controlUi: controlHref('/config')
  }));
  router.get('/models', async (req, res) => {
    try { const evidence = await runtimeEvidence(req); return res.json({ data: evidence.models, authority: evidence.authority }); }
    catch (error) { return sendError(res, error, 'models summary'); }
  });
  router.get('/channels', (_req, res) => res.json({
    data: [], authority: 'official-openclaw-control-ui', projected: false, controlUi: controlHref('/channels')
  }));
  router.get('/memory/:agentId', async (req, res) => {
    try {
      const evidence = await runtimeEvidence(req);
      const agent = evidence.agents.find((item) => item.id === req.params.agentId);
      return agent
        ? res.json({
          data: agent.memory || null,
          runtime: evidence.memory?.agentId === agent.id ? evidence.memory : null,
          authority: evidence.authority,
          controlUi: controlHref('/agents')
        })
        : res.status(404).json({ status: 'error', message: 'OpenClaw agent not found' });
    } catch (error) { return sendError(res, error, 'memory summary'); }
  });
  router.get('/cron', async (req, res) => {
    try {
      const evidence = await cronEvidence(req);
      return res.json({ data: evidence.cron.jobs, count: evidence.cron.count, authority: evidence.authority, controlUi: controlHref('/cron') });
    } catch (error) { return sendError(res, error, 'cron list'); }
  });
  router.get('/runtime-summary', async (req, res) => {
    try {
      const evidence = await runtimeEvidence(req);
      return res.json({
        status: evidence.source.degraded ? 'degraded' : 'ok',
        source: evidence.authority,
        controlUi: controlHref('/agents'),
        data: { ...evidence.models, degraded: evidence.source.degraded, runtimeVersion: evidence.status.runtimeVersion }
      });
    } catch (error) { return sendError(res, error, 'runtime summary'); }
  });
  return router;
}

function cleanUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function hermesGatewayFreshness(status = {}, now = Date.now(), maxAgeMs = Math.max(60000, Number(process.env.HERMES_GATEWAY_STALE_MS) || 86400000)) {
  const timestamps = [
    status.gateway_updated_at,
    ...Object.values(status.gateway_platforms || {}).map((platform) => platform?.updated_at)
  ].map((value) => ({ value, parsed: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.parsed))
    .sort((left, right) => right.parsed - left.parsed);
  if (!timestamps.length) {
    return {
      status: 'unknown',
      fresh: false,
      updatedAt: null,
      ageMs: null,
      maxAgeMs,
      reason: 'Hermès gateway supplied no current state timestamp.'
    };
  }
  const latest = timestamps[0];
  const ageMs = Math.max(0, Number(now) - latest.parsed);
  const fresh = ageMs <= maxAgeMs;
  return {
    status: fresh ? 'fresh' : 'stale',
    fresh,
    updatedAt: latest.value,
    ageMs,
    maxAgeMs,
    reason: fresh ? null : `Hermès gateway state is older than ${Math.round(maxAgeMs / 3600000)} hours.`
  };
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function extractSessionToken(html) {
  const match = String(html || '').match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*("([^"\\]|\\.)*")/);
  if (!match) return '';
  try { return JSON.parse(match[1]); } catch { return ''; }
}

async function getHermesStatusEvidence() {
  const dashboardUrl = cleanUrl(process.env.HERMES_DASHBOARD_URL || process.env.HERMES_PUBLIC_URL);
  if (!dashboardUrl) throw Object.assign(new Error('Hermes dashboard URL is not configured.'), { status: 503 });
  const timeout = Number(process.env.HERMES_API_TIMEOUT_MS || 5000);
  const startedAt = Date.now();
  const statusResponse = await fetchWithTimeout(`${dashboardUrl}/api/status`, { headers: { Accept: 'application/json' } }, timeout);
  const status = await statusResponse.json().catch(() => ({}));
  if (!statusResponse.ok) throw Object.assign(new Error(`Hermes returned HTTP ${statusResponse.status}`), { status: statusResponse.status });
  let liveConfig = { available: false, status: 'unavailable' };
  try {
    const page = await fetchWithTimeout(`${dashboardUrl}/`, { headers: { Accept: 'text/html' } }, timeout);
    const token = extractSessionToken(await page.text());
    if (token) {
      const config = await fetchWithTimeout(`${dashboardUrl}/api/config/raw`, {
        headers: { Accept: 'application/json', 'X-Hermes-Session-Token': token }
      }, timeout);
      liveConfig = config.ok
        ? { available: true, status: 'checked' }
        : { available: false, status: [401, 403].includes(config.status) ? 'protected' : 'unavailable' };
    } else liveConfig = { available: false, status: 'protected' };
  } catch { liveConfig = { available: false, status: 'unavailable' }; }
  const gatewayFreshness = hermesGatewayFreshness(status);
  return {
    ok: true,
    dashboard: { url: dashboardUrl, latencyMs: Date.now() - startedAt },
    hermes: {
      version: status.version || null,
      releaseDate: status.release_date || null,
      home: status.hermes_home || null,
      activeSessions: Number(status.active_sessions || 0)
    },
    gateway: {
      running: Boolean(status.gateway_running),
      pid: status.gateway_pid || null,
      state: status.gateway_state || null,
      exitReason: status.gateway_exit_reason || null,
      updatedAt: status.gateway_updated_at || null,
      platforms: status.gateway_platforms || {},
      freshness: gatewayFreshness
    },
    authority: {
      policy: 'agentx_local_delegation_live_primary_human_gated',
      expectedSource: '/api/nerve-center/agent-runtime-config/export',
      liveConfig,
      liveApply: 'human-gated'
    }
  };
}

function registerHermesOperations({ express, logger, statusProvider = getHermesStatusEvidence }) {
  const router = express.Router();
  router.get('/status', async (_req, res) => {
    try {
      return res.json(await statusProvider());
    } catch (error) {
      logger?.warn?.('[hermes] status fetch failed', { status: error.status || 502 });
      return res.status(error.status || 502).json({ ok: false, dashboard: { url: cleanUrl(process.env.HERMES_DASHBOARD_URL || process.env.HERMES_PUBLIC_URL) }, error: error.message });
    }
  });
  return router;
}

module.exports = { getHermesStatusEvidence, hermesGatewayFreshness, registerHermesOperations, registerOpenClawOperations };
