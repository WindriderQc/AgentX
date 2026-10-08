'use strict';

// The Household panel API (/api/panel): service, fleet, crew and readiness
// projections for the operator panel.

const { serviceHealth, projectedJson, fleetSummary } = require('./panel-sources');
const { upstreamJson } = require('./voix-client');
const { agentxCrew, openClawPanelStatus, panelCrewReady } = require('./panel-status');
const { createVoiceStatus, voiceLine } = require('./voice-status');

function registerPanelRoutes(app, {
  express, standardJsonParser, CORE_SELF_URL, knowledgeState, cleanText, envelope
}) {
  const panel = express.Router();
  panel.use(standardJsonParser);
  const voiceStatus = createVoiceStatus({ readCatalog: () => upstreamJson('/api/voices') });
  panel.get('/status', async (_req, res) => {
    const [services, voixStatus, openclaw, fleet, voices] = await Promise.all([
      Promise.all([
        serviceHealth('Core', `${CORE_SELF_URL()}/health`),
        serviceHealth('Benchmark', String(process.env.BENCHMARK_SERVICE_URL || 'http://benchmark:3081').replace(/\/+$/, '') + '/health'),
        serviceHealth('RAG', String(process.env.RAG_SERVICE_URL || 'http://rag:3082').replace(/\/+$/, '') + '/health'),
        // Data is optional: its row shows its real state, marked optional.
        ...(process.env.DATAAPI_BASE_URL ? [serviceHealth('Data', String(process.env.DATAAPI_BASE_URL).replace(/\/+$/, '') + '/health')
          .then((service) => ({ ...service, optional: true }))] : [])
      ]),
      upstreamJson('/health')
        .then((health) => ({ status: health?.status === 'ok' ? 'ok' : 'down', health }))
        .catch((error) => ({ status: 'down', error: error.message })),
      openClawPanelStatus(app.locals?.aioOpsRuntimeEvidence),
      projectedJson(
        `${CORE_SELF_URL()}/api/nerve-center/ecosystem`,
        fleetSummary,
        fleetSummary({})
      ),
      voiceStatus()
    ]);
    const agentx = agentxCrew(services);
    const nestor = {
      id: 'nestor',
      name: 'Nestor',
      role: 'Family front door',
      status: agentx.status !== 'down' && fleet.status === 'ok' ? 'ok' : 'down',
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
        ? [cleanText(voixStatus.health?.version || voixStatus.health?.serviceVersion || 'local speech ready', 120), voiceLine(voices)].filter(Boolean).join(' · ')
        : 'local speech unavailable',
      href: '/voice'
    };
    const crew = [nestor, openclaw, agentx, voix];
    const ready = panelCrewReady(crew, fleet);
    return envelope(res, {
      generatedAt: new Date().toISOString(),
      status: ready && !fleet.attention.length ? 'ok' : 'degraded',
      services,
      voix: { ...voixStatus, engines: voices },
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
