'use strict';

// The Household panel API (/api/panel): service, fleet, crew and readiness
// projections for the operator panel.

const { serviceHealth, projectedJson, fleetSummary } = require('./panel-sources');
const { upstreamJson } = require('./voix-client');
const { openClawPanelStatus, panelCrewReady } = require('./panel-status');

function registerPanelRoutes(app, {
  express, standardJsonParser, CORE_SELF_URL, knowledgeState, cleanText, envelope
}) {
  const panel = express.Router();
  panel.use(standardJsonParser);
  panel.get('/status', async (_req, res) => {
    const [services, voixStatus, openclaw, fleet] = await Promise.all([
      Promise.all([
        serviceHealth('Core', `${CORE_SELF_URL()}/health`),
        serviceHealth('Benchmark', String(process.env.BENCHMARK_SERVICE_URL || 'http://benchmark:3081').replace(/\/+$/, '') + '/health'),
        serviceHealth('RAG', String(process.env.RAG_SERVICE_URL || 'http://rag:3082').replace(/\/+$/, '') + '/health'),
        ...(process.env.DATAAPI_BASE_URL ? [serviceHealth('Data', String(process.env.DATAAPI_BASE_URL).replace(/\/+$/, '') + '/health')] : [])
      ]),
      upstreamJson('/health')
        .then((health) => ({ status: health?.status === 'ok' ? 'ok' : 'down', health }))
        .catch((error) => ({ status: 'down', error: error.message })),
      openClawPanelStatus(app.locals?.aioOpsRuntimeEvidence),
      projectedJson(
        `${CORE_SELF_URL()}/api/nerve-center/ecosystem`,
        fleetSummary,
        fleetSummary({})
      )
    ]);
    const serviceCount = services.filter((service) => service.status === 'ok').length;
    const agentx = {
      id: 'agentx',
      name: 'AgentX',
      role: 'Router · RAG · shared memory authority',
      status: serviceCount === services.length ? 'ok' : 'down',
      detail: `${serviceCount}/${services.length} platform services ready`,
      href: '/agent-ops'
    };
    const nestor = {
      id: 'nestor',
      name: 'Nestor',
      role: 'Family front door',
      status: agentx.status === 'ok' && fleet.status === 'ok' ? 'ok' : 'down',
      detail: knowledgeState.status.enabled
        ? `${knowledgeState.status.documentCount} approved knowledge document(s)`
        : 'child-safe lane · approved knowledge waiting',
      href: '#family-nestor'
    };
    const voix = {
      id: 'voix',
      name: 'VoiX',
      role: 'Private ears & voice',
      status: voixStatus.status,
      detail: voixStatus.status === 'ok'
        ? cleanText(voixStatus.health?.version || voixStatus.health?.serviceVersion || 'local speech ready', 120)
        : 'local speech unavailable',
      href: '/voice'
    };
    const crew = [nestor, openclaw, agentx, voix];
    const ready = panelCrewReady(crew, fleet);
    return envelope(res, {
      generatedAt: new Date().toISOString(),
      status: ready && !fleet.attention.length ? 'ok' : 'degraded',
      services,
      voix: voixStatus,
      crew,
      fleet,
      memory: {
        sharedAuthority: 'AgentX Memory Review',
        sharedHref: '/memory-review',
        familyNotebook: 'scoped household notebook',
        retiredHermesCorpus: 'Retained read-only for explicit Memory Review compatibility; no live Hermès service.'
      },
      knowledge: knowledgeState.status,
      reader: { status: 'ok', packId: 'kidx_reader' },
      secretary: { status: 'ok', store: 'pipelinetasks' },
      home: { status: 'not_configured', entities: [] }
    });
  });
  panel.post('/heartbeat', (req, res) => envelope(res, {
    accepted: true,
    deviceId: cleanText(req.body?.deviceId || 'house-panel', 120),
    at: new Date().toISOString()
  }, 202));
  app.use('/api/panel', panel);
}

module.exports = { registerPanelRoutes };
