'use strict';

const VERSION = '1.7.6';
const { CodingTaskPreparation } = require('./coding-task-preparation');

const { cleanBaseUrl } = require('./common');
const { registerHermesProtocol } = require('./hermes/protocol');
const { registerOpenClawProtocol } = require('./openclaw/protocol');
const { createConversationHostResolver, parseConversationHosts, parseNoThinkModels } = require('./openclaw/conversationHosts');
const { createAioOpsEvidenceService } = require('./evidence-service');
const { registerEcosystemSnapshotMcp } = require('./ecosystem-snapshot-mcp');
const { registerHermesOperations, registerOpenClawOperations } = require('./operations');
const { dshStudioConfig, registerDshStudioOperations, validateDshStudioEnvironment } = require('./dsh/studio');
const {
  buildRuntimeConfigExport,
  resolveOpenClawProviderBaseUrl,
  validateRuntimeConfigs
} = require('./runtime-config');
const { registerAgentOps } = require('./agent-ops/routes');
const {
  PipelineAttributionLeaseManager,
  registerPipelineAttributionRoutes
} = require('./pipeline-attribution');
const {
  CodingDispatchControl,
  registerCodingDispatchControlRoutes
} = require('./coding-dispatch-control');
const {
  CodingDeliveryControl,
  registerCodingDeliveryControlRoutes
} = require('./coding-delivery-control');
const { SecretaryMailControl } = require('./secretary-mail-control');

function validateEnvironment() {
  for (const key of ['CORE_PUBLIC_URL', 'HERMES_DASHBOARD_URL', 'HERMES_PUBLIC_URL', 'OPENCLAW_GATEWAY_URL', 'OPENCLAW_CONTROL_UI_PUBLIC_URL', 'DSH_STUDIO_PUBLIC_URL']) {
    if (process.env[key]) cleanBaseUrl(process.env[key]);
  }
  if (process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL) {
    resolveOpenClawProviderBaseUrl(process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL);
  }
  for (const prefix of ['OPENCLAW_INVENTORY']) {
    const target = String(process.env[`${prefix}_SSH_TARGET`] || '').trim();
    if (target && !/^[a-z0-9_.-]+@[a-z0-9_.:-]+$/i.test(target)) {
      throw new Error(`${prefix}_SSH_TARGET is invalid`);
    }
    const port = String(process.env[`${prefix}_SSH_PORT`] || '').trim();
    if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      throw new Error(`${prefix}_SSH_PORT is invalid`);
    }
  }
  const dispatcherTarget = String(process.env.CODING_DISPATCHER_SSH_TARGET || '').trim();
  if (dispatcherTarget && !/^[a-z0-9_.-]+@[a-z0-9_.:-]+$/i.test(dispatcherTarget)) {
    throw new Error('CODING_DISPATCHER_SSH_TARGET is invalid');
  }
  const dispatcherRoot = String(process.env.CODING_DISPATCHER_REMOTE_ROOT || '').trim();
  if (dispatcherRoot && (!/^\/[a-z0-9._/-]+$/i.test(dispatcherRoot) || dispatcherRoot.includes('/../'))) {
    throw new Error('CODING_DISPATCHER_REMOTE_ROOT is invalid');
  }
  const context = String(process.env.HERMES_AUTHORITY_CONTEXT || '').trim();
  if (context && (!/^\d+$/.test(context) || Number(context) < 1)) {
    throw new Error('HERMES_AUTHORITY_CONTEXT is invalid');
  }
  parseConversationHosts(process.env.OPENCLAW_CONVERSATION_HOSTS);
  parseNoThinkModels(process.env.OPENCLAW_CONVERSATION_NO_THINK_MODELS);
  validateDshStudioEnvironment();
}

function requestCoreBaseUrl(req) {
  const configured = String(process.env.CORE_PUBLIC_URL || '').trim();
  if (configured) return cleanBaseUrl(configured);
  return cleanBaseUrl(`${req.protocol || 'http'}://${String(req.get('host') || 'localhost:3080').split(',')[0].trim()}`);
}

function register(api) {
  if (api.contractVersion < 2
    || api.runtimeServices?.contractVersion !== 1) {
    throw new Error('aio-ops-runtime-bridges requires AgentX trusted-extension contract v2');
  }
  validateEnvironment();
  const { app, express, logger, mongoose, runtimeServices, standardJsonParser } = api;
  const evidence = createAioOpsEvidenceService();
  const conversationHosts = createConversationHostResolver(process.env.OPENCLAW_CONVERSATION_HOSTS);
  const noThinkModels = parseNoThinkModels(process.env.OPENCLAW_CONVERSATION_NO_THINK_MODELS);
  const pipelineAttribution = new PipelineAttributionLeaseManager({
    taskReader: async (pipelineId) => {
      const db = mongoose?.connection?.db;
      if (!db) throw new Error('MongoDB is unavailable');
      return db.collection('pipelinetasks').findOne(
        { pipelineId },
        {
          projection: {
            _id: 0,
            pipelineId: 1,
            status: 1,
            assignee: 1,
            automationAttemptCount: 1,
            codingCapacity: 1,
            'automationLease.leaseId': 1,
            'automationLease.attempt': 1,
            'automationLease.expiresAt': 1,
            'automationAttempts.attempt': 1,
            'automationAttempts.finalState': 1
          }
        }
      );
    },
    snapshotProvider: () => runtimeServices.routing.getEffectiveSnapshot({
      includeCatalog: false,
      includeArtifactIdentity: true
    })
  });
  const codingDispatchControl = new CodingDispatchControl({ inferenceStatus: () => pipelineAttribution.status().active });
  const codingPreparation = runtimeServices.pipeline
    ? new CodingTaskPreparation({ pipeline: runtimeServices.pipeline }) : null;
  const codingDeliveryControl = new CodingDeliveryControl({
    taskReader: async () => {
      const db = mongoose?.connection?.db;
      if (!db) throw new Error('MongoDB is unavailable');
      return db.collection('pipelinetasks').aggregate([
        { $match: { 'automation.mode': 'review_only' } },
        { $sort: { updatedAt: -1, pipelineId: -1 } },
        { $limit: 50 },
        {
          $project: {
            _id: 0,
            pipelineId: 1,
            title: 1,
            status: 1,
            risk: 1,
            createdAt: 1,
            updatedAt: 1,
            automation: 1,
            automationAttempts: 1,
            feedback: { $slice: [{ $ifNull: ['$feedback', []] }, -12] }
          }
        }
      ]).toArray();
    }
  });
  app.locals = app.locals || {};
  app.locals.aioOpsRuntimeEvidence = evidence;
  // Household renders the Dad desk; this extension owns the OpenClaw host boundary.
  app.locals.aioOpsSecretaryMail = new SecretaryMailControl();
  app.locals.trustedRuntimeNavItems = [
    ...(Array.isArray(app.locals.trustedRuntimeNavItems) ? app.locals.trustedRuntimeNavItems : []),
    // Two distinct doors, each naming its provider so Product surfaces never
    // present a private runtime as a Product page. Product validates this
    // bounded contract and republishes it through /api/config so Benchmark and
    // RAG render the same launchers as Core.
    ...(process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL && process.env.OPENCLAW_GATEWAY_TOKEN ? [{
      id: 'openclaw-runtime', label: 'OpenClaw', href: '/api/openclaw/control-launch/overview', icon: 'fa-paw',
      owner: 'AIOps', description: 'Official OpenClaw Control UI, the protected agent desk. Opens in its own tab.'
    }] : []),
    ...(dshStudioConfig().configured ? [{
      id: 'dsh-studio', label: 'DSH Studio', href: '/api/dsh/control-launch', icon: 'fa-terminal',
      owner: 'AIOps', description: 'Isolated coding studio launched through AgentX. Opens in its own tab.'
    }] : []),
  ];

  registerEcosystemSnapshotMcp({
    app,
    standardJsonParser,
    projectionProvider: evidence.getAgentOpsProjection
  });

  app.use('/api/openclaw-ollama', registerOpenClawProtocol({
    express, runtimeServices, pipelineAttribution, logger, noThinkModels,
    resolveConversationTarget: async model => await app.locals?.aioOpsConversationTarget?.(model)
      || conversationHosts(model)
  }));
  app.use('/api/hermes-openai', registerHermesProtocol({ express, runtimeServices, logger }));
  app.use('/api/openclaw', registerOpenClawOperations({
    express,
    logger,
    runtimeEvidenceProvider: evidence.getOpenClawRuntimeEvidence,
    cronEvidenceProvider: ({ includeDisabledCron, refresh }) => evidence.getOpenClawCronEvidence({ includeDisabled: includeDisabledCron, refresh })
  }));
  app.use('/api/dsh', registerDshStudioOperations({ express }));
  app.use('/api/hermes', registerHermesOperations({ express, logger, statusProvider: evidence.getHermesStatusEvidence }));
  app.use('/api/agent-ops', registerAgentOps({ express, logger, projectionProvider: evidence.getAgentOpsProjection,
    // The Team view joins each agent with the persona that presents it.
    personaProvider: runtimeServices.personas
      ? async () => (await runtimeServices.personas.list()).filter(row => row.uiConfig?.layoutConfig?.kind === 'personality')
        .map(row => ({ ...require('../../surfaces/household/persona-catalog').snapshot(row), edited: row.uiConfig.layoutConfig.source?.edited === true }))
      : null }));
  app.use(
    '/api/runtime-bridges/pipeline-attribution',
    standardJsonParser,
    registerPipelineAttributionRoutes({ express, manager: pipelineAttribution, logger })
  );
  app.use(
    '/api/runtime-bridges/coding-dispatch',
    standardJsonParser,
    registerCodingDispatchControlRoutes({
      express, control: codingDispatchControl, preparation: codingPreparation, logger
    })
  );
  app.use(
    '/api/runtime-bridges/coding-delivery',
    standardJsonParser,
    registerCodingDeliveryControlRoutes({
      express, control: codingDeliveryControl, logger
    })
  );

  const runtimeConfig = express.Router();
  runtimeConfig.get('/export', async (req, res, next) => {
    try {
      const data = await buildRuntimeConfigExport(runtimeServices, {
        coreBaseUrl: requestCoreBaseUrl(req),
        includeCandidates: req.query.includeCandidates !== 'false'
      });
      return res.json({ status: 'success', data });
    } catch (error) { return next(error); }
  });
  runtimeConfig.post('/validate', async (req, res, next) => {
    try {
      const expected = await buildRuntimeConfigExport(runtimeServices, {
        coreBaseUrl: requestCoreBaseUrl(req),
        includeCandidates: req.query.includeCandidates !== 'false'
      });
      return res.json({
        status: 'success',
        data: { expected, validation: validateRuntimeConfigs(expected, req.body || {}) }
      });
    } catch (error) { return next(error); }
  });
  app.use('/api/nerve-center/agent-runtime-config', runtimeConfig);

  app.get('/api/runtime-bridges/status', (_req, res) => res.json({
    status: 'success',
    data: {
      owner: 'aio-ops',
      extension: 'aio-ops-runtime-bridges',
      version: VERSION,
      coreRuntimeContract: runtimeServices.contractVersion,
      inProcessEvidence: { contractVersion: evidence.contractVersion },
      routes: ['ecosystem-snapshot-mcp', 'openclaw-ollama', 'hermes-openai', 'agent-runtime-config', 'openclaw-operations', 'dsh-studio', 'hermes-operations', 'agent-ops', 'pipeline-attribution', 'coding-dispatch', 'coding-delivery']
    }
  }));
}

module.exports = {
  id: 'aio-ops-runtime-bridges',
  version: VERSION,
  capabilities: [
    'agent-runtime-config',
    'hermes-runtime-bridge',
    'openclaw-runtime-bridge',
    'dsh-studio-launcher',
    'runtime-operations-projection',
    'agent-ops-readonly-projection',
    'ecosystem-snapshot-mcp',
    'in-process-runtime-evidence',
    'pipeline-runtime-attribution',
    'coding-dispatch-one-shot-control',
    'coding-delivery-operator-inbox',
    'secretary-mail-host-control'
  ],
  register,
  validateEnvironment
};
