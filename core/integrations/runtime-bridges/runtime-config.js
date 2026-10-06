'use strict';

const { normalizeAgentsSection } = require('./openclaw/remoteConfigProjection');
const { loadGuardedAgentPolicies } = require('./openclaw/modelPolicy');
const { OPENCLAW_ROUTE_SCOPE, coreRoutedProviderIds } = require('./openclaw/localProviders');

const EXECUTION_POLICIES = Object.freeze({
  daily: Object.freeze({ responseMode: 'native', thinkingMode: 'auto', visibleFinalRequired: true }),
  codingSpecialist: Object.freeze({
    responseMode: 'final_only', thinkingMode: 'off', visibleFinalRequired: true, recommendedOutputTokens: 4096
  }),
  masterBrain: Object.freeze({
    responseMode: 'explicit_thinking', thinkingMode: 'on', visibleFinalRequired: true, recommendedOutputTokens: 4096
  })
});


function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

const CLOUD_AUTHORITY_PREFIXES = Object.freeze([
  'anthropic/',
  'google/',
  'mistral/',
  'openai/',
  'openai-codex/',
  'openrouter/',
  'xai/'
]);

function isCloudAuthorityModel(modelName) {
  const normalized = String(modelName || '').trim().toLowerCase();
  if (!normalized) return false;
  if (CLOUD_AUTHORITY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  return /^(?:claude-|gemini-|gpt-|o[134](?:-|$))/.test(normalized);
}

function cleanBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  return raw || 'http://localhost:3080';
}

function resolveOpenClawProviderBaseUrl(value, coreBaseUrl) {
  const configured = String(value || '').trim();
  const candidate = configured || `${cleanBaseUrl(coreBaseUrl)}${OPENCLAW_ROUTE_SCOPE}`;
  if (candidate.includes('?') || candidate.includes('#')) {
    throw new Error('OPENCLAW_AGENTX_PROVIDER_BASE_URL must not include a query or fragment');
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('OPENCLAW_AGENTX_PROVIDER_BASE_URL must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('OPENCLAW_AGENTX_PROVIDER_BASE_URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('OPENCLAW_AGENTX_PROVIDER_BASE_URL must not include credentials');
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  if (normalizedPath !== OPENCLAW_ROUTE_SCOPE) {
    throw new Error(`OPENCLAW_AGENTX_PROVIDER_BASE_URL must end at ${OPENCLAW_ROUTE_SCOPE}`);
  }
  parsed.pathname = OPENCLAW_ROUTE_SCOPE;
  return parsed.toString().replace(/\/+$/, '');
}

function shortName(modelName) {
  return String(modelName || 'unknown')
    .toLowerCase()
    .replace(/[:/]/g, '-')
    .replace(/\.(?=\d)/g, '')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
}

function thinkingStatus(contract) {
  const thinking = contract?.capabilities?.thinking || {};
  const qualified = thinking.supported === true
    && contract?.qualification?.qualified === true
    && thinking.visibleFinalAnswer?.qualified === true;
  return {
    qualified,
    source: thinking.source || 'unqualified',
    qualificationState: contract?.qualification?.state || 'unknown'
  };
}

function laneFromTask(role, taskType, snapshot) {
  const task = snapshot.tasks?.[taskType] || null;
  const warnings = [];
  if (!task?.model) warnings.push(`No effective model is configured for task ${taskType}.`);
  if (!task?.hostUrl && !String(task?.model || '').includes('/')) {
    warnings.push(`No effective host is configured for task ${taskType}.`);
  }
  if (!task?.contextSize) warnings.push(`Context is unresolved for ${task?.model || taskType}.`);
  const contractContext = positiveInteger(
    task?.inferenceContract?.contextBudget?.validatedWindowTokens
      || task?.inferenceContract?.contextBudget?.windowTokens
  );
  let contextSize = positiveInteger(task?.contextSize);
  let contextSource = task?.contextSource || 'unresolved';
  if (contractContext && contextSize && contractContext !== contextSize && task?.pinAligned) {
    warnings.push(
      `Pinned ${role} context ${contextSize} differs from inference-contract context ${contractContext}; preserving the operator pin.`
    );
  } else if (contractContext && contractContext !== contextSize) {
    contextSize = contractContext;
    contextSource = `inference_contract_${task?.inferenceContract?.contextBudget?.resolvedSource || 'resolved'}`;
  }
  return {
    role,
    taskType,
    taskModel: task?.configuredModel || task?.model || null,
    model: task?.model || null,
    hostKey: task?.hostKey || null,
    hostUrl: task?.hostUrl || null,
    contextSize,
    contextSource,
    pinAligned: task?.pinAligned === true,
    pinnedModel: task?.pinAligned ? task.model : null,
    primaryPinnedModel: task?.hostPreference?.pinnedModels?.[0]?.model || null,
    keepAlive: task?.keepAlive ?? null,
    autoRestore: task?.hostPreference?.pinnedModels?.find((pin) => pin.model === task?.model)?.autoRestore ?? null,
    hostPreference: task?.hostPreference || null,
    contextInfo: task?.contextInfo || null,
    executionPolicy: EXECUTION_POLICIES[role],
    capabilityContract: task?.inferenceContract || null,
    warnings
  };
}

function toOpenClawModel(lane) {
  const thinking = thinkingStatus(lane.capabilityContract);
  const model = {
    id: lane.model,
    name: shortName(lane.model),
    reasoning: thinking.qualified,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: positiveInteger(lane.executionPolicy?.recommendedOutputTokens) || 8192,
    _source: {
      agentxRuntimeConfig: true,
      role: lane.role,
      taskType: lane.taskType,
      host: lane.hostUrl,
      hostKey: lane.hostKey,
      contextSource: lane.contextSource,
      pinAligned: lane.pinAligned,
      thinkingSource: thinking.source,
      thinkingQualified: thinking.qualified,
      thinkingQualificationState: thinking.qualificationState,
      executionPolicy: lane.executionPolicy
    }
  };
  if (lane.contextSize) {
    model.contextWindow = lane.contextSize;
    model.params = { num_ctx: lane.contextSize };
  }
  return model;
}

function modelConfig(model, context, baseUrl, { local = true } = {}) {
  const config = { default: model, provider: 'custom', base_url: baseUrl, api_key: 'no-key-required' };
  if (context) config.context_length = context;
  if (local && context) config.ollama_num_ctx = context;
  return config;
}

function buildHermesExport(lanes, coreBaseUrl) {
  const baseUrl = `${coreBaseUrl}/api/hermes-openai/v1`;
  const authorityModel = String(process.env.HERMES_AUTHORITY_MODEL || '').trim() || lanes.daily.model;
  const authorityIsCloud = isCloudAuthorityModel(authorityModel);
  const authorityContext = positiveInteger(process.env.HERMES_AUTHORITY_CONTEXT)
    || (!authorityIsCloud ? lanes.daily.contextSize : null);
  return {
    proxyBaseUrl: baseUrl,
    defaultModelConfig: modelConfig(authorityModel, authorityContext, baseUrl, { local: !authorityIsCloud }),
    localFallbackModelConfig: modelConfig(lanes.daily.model, lanes.daily.contextSize, baseUrl),
    codingSpecialistModelConfig: modelConfig(lanes.codingSpecialist.model, lanes.codingSpecialist.contextSize, baseUrl),
    masterBrainModelConfig: modelConfig(lanes.masterBrain.model, lanes.masterBrain.contextSize, baseUrl),
    authority: {
      policy: authorityIsCloud ? 'requires_explicit_openclaw_source' : 'local_via_agentx_proxy',
      expectedBaseUrl: baseUrl,
      expectedModel: authorityModel,
      expectedContext: authorityContext,
      localFallbackModel: lanes.daily.model,
      localFallbackContext: lanes.daily.contextSize,
      liveConfigValidation: 'protected_human_gated',
      credentialPolicy: authorityIsCloud
        ? 'provider credentials belong to OpenClaw; select an explicit OpenClaw execution source'
        : 'no provider credential required for local inference'
    },
    notes: [
      'The command gateway points to the AgentX protocol adapter; it never points directly at a provider or model host.',
      'The local fallback is derived from AgentX effective routing and resident context truth.',
      'Configuration validation is read-only and live application remains human-gated.'
    ]
  };
}

function buildOpenClawExport(lanes, apiBase) {
  const models = [];
  const seen = new Set();
  for (const lane of [lanes.daily, lanes.codingSpecialist, lanes.masterBrain]) {
    if (!lane?.model || seen.has(lane.model)) continue;
    seen.add(lane.model);
    models.push(toOpenClawModel(lane));
  }
  return {
    providerId: 'ollama',
    provider: { apiBase, api: 'ollama', authHeader: false, apiKey: 'ollama-local', models },
    credential: {
      source: 'trusted-lan',
      required: false,
      profileId: null,
      routeScope: OPENCLAW_ROUTE_SCOPE,
      valueExported: false
    },
    defaults: {
      primary: lanes.daily.model ? `ollama/${lanes.daily.model}` : null,
      codingSpecialist: lanes.codingSpecialist.model ? `ollama/${lanes.codingSpecialist.model}` : null,
      masterBrain: lanes.masterBrain.model ? `ollama/${lanes.masterBrain.model}` : null
    },
    agentModelPolicy: {
      source: 'supplied sanitized OpenClaw agents configuration',
      paths: ['agents.defaults.model.primary', 'agents.defaults.model.fallbacks', 'agents.entries.*.model.primary', 'agents.entries.*.model.fallbacks', 'agents.list.*.model.primary', 'agents.list.*.model.fallbacks'],
      cloudPrimaryRequiresLocalFallback: true,
      scope: 'ordinary native agent turns; guarded dispatcher routes forbid fallback',
      guardedExecution: loadGuardedAgentPolicies(),
      missingLocalFallbackStatus: 'degraded',
      mutation: 'read_only_validation'
    },
    contextOverrides: [],
    notes: [
      'Patch the existing provider block and keep every local request behind AgentX routing.',
      `The trusted-LAN ${OPENCLAW_ROUTE_SCOPE} adapter requires no internal bearer token; ollama-local is a non-secret SDK placeholder.`,
      'Cloud provider credentials and the OpenClaw Gateway token remain owned by OpenClaw; this export does not change them.',
      'contextWindow and params.num_ctx are derived from AgentX effective routing and HostPreference truth.',
      'Do not add direct model-host providers for AgentX-owned local inference.'
    ]
  };
}

function parseParameterB(modelName, parameterSize) {
  const fromSize = String(parameterSize || '').match(/(\d+(?:\.\d+)?)\s*B/i);
  if (fromSize) return Number(fromSize[1]);
  const fromName = String(modelName || '').match(/(?:^|[:/_-])(\d+(?:\.\d+)?)b(?:$|[:/_-])/i);
  return fromName ? Number(fromName[1]) : null;
}

function masterBrainCandidates(snapshot, lanes) {
  return (snapshot.catalog || [])
    .map((entry) => ({
      model: entry.model,
      host: entry.hostUrl,
      parameterB: parseParameterB(entry.model, entry.parameterSize),
      quantization: entry.quantization,
      family: entry.family,
      currentMaster: entry.model === lanes.masterBrain.model,
      dailyModel: entry.model === lanes.daily.model
    }))
    .filter((entry) => !entry.dailyModel
      && (!lanes.daily.hostUrl || !entry.host || entry.host === lanes.daily.hostUrl)
      && (entry.currentMaster || (entry.parameterB != null && entry.parameterB >= 30)))
    .sort((left, right) => Number(right.currentMaster) - Number(left.currentMaster)
      || (right.parameterB || 0) - (left.parameterB || 0))
    .slice(0, 12);
}

async function buildRuntimeConfigExport(runtimeServices, options = {}) {
  const snapshot = await runtimeServices.routing.getEffectiveSnapshot({
    includeCatalog: options.includeCandidates !== false,
    // This export is an operator authority, not a lightweight discovery view.
    // Keep its capability verdict bound to the same exact live artifact identity
    // used by the reserved Pipeline alias gate.
    includeArtifactIdentity: true
  });
  const coreBaseUrl = cleanBaseUrl(options.coreBaseUrl || process.env.CORE_PUBLIC_URL);
  const openClawProviderBaseUrl = resolveOpenClawProviderBaseUrl(
    options.openClawProviderBaseUrl ?? process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL,
    coreBaseUrl
  );
  const lanes = {
    daily: laneFromTask('daily', 'daily_operator', snapshot),
    codingSpecialist: laneFromTask('codingSpecialist', 'code_generation', snapshot),
    masterBrain: laneFromTask('masterBrain', 'master_brain', snapshot)
  };
  const result = {
    generatedAt: snapshot.generatedAt,
    sourceOfTruth: {
      routing: '/api/router/config',
      hostPreferences: '/api/nerve-center/host-preferences',
      agentRuntimeExport: '/api/nerve-center/agent-runtime-config/export',
      trustedContract: 'agentx-effective-routing-snapshot-v1'
    },
    coreBaseUrl,
    lanes,
    hermes: buildHermesExport(lanes, coreBaseUrl),
    openclaw: buildOpenClawExport(lanes, openClawProviderBaseUrl),
    warnings: Object.values(lanes).flatMap((lane) => lane.warnings)
  };
  if (options.includeCandidates !== false) result.masterBrainCandidates = masterBrainCandidates(snapshot, lanes);
  return result;
}

function providerUrl(provider) {
  return provider?.apiBase || provider?.baseURL || provider?.baseUrl || provider?.url || null;
}

function sameUrl(left, right) {
  return String(left || '').replace(/\/+$/, '') === String(right || '').replace(/\/+$/, '');
}

function diffField(path, current, expected) {
  return { path, current: current === undefined ? null : current, expected };
}

function compareHermesConfig(currentConfig, expectedHermes) {
  if (!currentConfig) return { status: 'not_checked', drift: [], missing: ['hermesConfig'] };
  const current = currentConfig.model
    && typeof currentConfig.model === 'object'
    && !Array.isArray(currentConfig.model)
    ? currentConfig.model
    : currentConfig;
  const expected = expectedHermes.defaultModelConfig;
  const checks = [
    ['model.default', current.default ?? current.model, expected.default],
    ['model.provider', current.provider, expected.provider],
    ['model.base_url', current.base_url, expected.base_url],
    ['model.context_length', positiveInteger(current.context_length), expected.context_length],
    ['model.ollama_num_ctx', positiveInteger(current.ollama_num_ctx), expected.ollama_num_ctx]
  ].filter(([, , wanted]) => wanted !== undefined && wanted !== null);
  const drift = checks.filter(([, actual, wanted]) => actual !== wanted)
    .map(([path, actual, wanted]) => diffField(path, actual, wanted));
  return { status: drift.length ? 'drift' : 'ok', drift };
}

function compareOpenClawConfig(currentConfig, expectedOpenClaw) {
  if (!currentConfig) return { status: 'not_checked', drift: [], missing: ['openclawConfig'] };
  const providers = currentConfig.models?.providers || {};
  const ids = [expectedOpenClaw.providerId];
  const candidates = ids.filter((id) => providers[id]).map((id) => ({ id, provider: providers[id] }));
  if (!candidates.length) {
    return { status: 'drift', drift: [diffField(`models.providers.${expectedOpenClaw.providerId}`, null, 'provider present')] };
  }
  const drift = [];
  for (const candidate of candidates) {
    if (!sameUrl(providerUrl(candidate.provider), expectedOpenClaw.provider.apiBase)) {
      drift.push(diffField(
        `models.providers.${candidate.id}.apiBase`,
        providerUrl(candidate.provider),
        expectedOpenClaw.provider.apiBase
      ));
    }
  }
  for (const expected of expectedOpenClaw.provider.models) {
    const match = candidates.map((candidate) => ({
      candidate,
      model: (candidate.provider.models || []).find((model) => model?.id === expected.id)
    })).find((row) => row.model);
    if (!match) {
      drift.push(diffField(`models.providers.${expectedOpenClaw.providerId}.models[${expected.id}]`, null, 'model entry present'));
      continue;
    }
    if (expected.contextWindow != null && positiveInteger(match.model.contextWindow) !== expected.contextWindow) {
      drift.push(diffField(
        `models.providers.${match.candidate.id}.models[${expected.id}].contextWindow`,
        positiveInteger(match.model.contextWindow), expected.contextWindow
      ));
    }
    if (expected.params?.num_ctx != null && positiveInteger(match.model.params?.num_ctx) !== expected.params.num_ctx) {
      drift.push(diffField(
        `models.providers.${match.candidate.id}.models[${expected.id}].params.num_ctx`,
        positiveInteger(match.model.params?.num_ctx), expected.params.num_ctx
      ));
    }
  }
  const agentsRoot = currentConfig.agents && !Array.isArray(currentConfig.agents)
    ? currentConfig.agents
    : currentConfig;
  const normalizedAgents = normalizeAgentsSection(agentsRoot);
  const agentPath = agentsRoot?.entries && typeof agentsRoot.entries === 'object'
    && !Array.isArray(agentsRoot.entries) ? 'agents.entries' : 'agents.list';
  const agents = Array.isArray(currentConfig.agents)
    ? currentConfig.agents
    : Array.isArray(normalizedAgents?.list) ? normalizedAgents.list : null;
  const defaultsModel = agentsRoot?.defaults?.model || currentConfig.defaults?.model || {};
  const localProviderIds = coreRoutedProviderIds(providers, [expectedOpenClaw.providerId]);
  const localModel = (value) => localProviderIds.has(String(value || '').split('/')[0]);
  const localCatalogModel = (value) => {
    const [providerId, ...modelParts] = String(value || '').split('/');
    const modelId = modelParts.join('/');
    return localProviderIds.has(providerId)
      && Boolean(modelId)
      && Array.isArray(providers[providerId]?.models)
      && providers[providerId].models.some((entry) => String(entry?.id || '') === modelId);
  };
  if (!agents) {
    return {
      status: drift.length ? 'drift' : 'not_checked',
      drift,
      missing: ['agents.entries or agents.list'],
      agentModels: { status: 'not_checked', checked: 0, degraded: 0, agents: [], issues: [] }
    };
  }
  const agentModels = agents.map((agent, index) => {
    const id = String(agent?.id || `index-${index}`);
    const model = agent?.model && typeof agent.model === 'object'
      ? agent.model
      : (typeof agent?.model === 'string' ? { primary: agent.model } : {});
    const primary = model.primary || defaultsModel.primary || null;
    const fallbacks = Array.isArray(model.fallbacks)
      ? model.fallbacks
      : (Array.isArray(defaultsModel.fallbacks) ? defaultsModel.fallbacks : []);
    const declaredLocalModels = [primary, ...fallbacks].filter((entry) => localModel(entry));
    const missingCatalogModels = declaredLocalModels.filter((entry) => !localCatalogModel(entry));
    const localFallbacks = fallbacks.filter((entry) => localCatalogModel(entry));
    const cloudPrimary = Boolean(primary) && !localModel(primary);
    const executionPolicy = expectedOpenClaw.agentModelPolicy?.guardedExecution?.agents?.[id] || null;
    const requiresLocalFallback = cloudPrimary && !executionPolicy;
    const unexpectedFallbacks = Boolean(executionPolicy && fallbacks.length);
    const missingDispatchModels = (executionPolicy?.targets || [])
      .filter(target => localModel(target.model) && !localCatalogModel(target.model));
    return {
      id,
      paths: {
        primary: `${agentPath}.${id}.model.primary`,
        fallbacks: `${agentPath}.${id}.model.fallbacks`
      },
      primary,
      fallbacks,
      cloudPrimary,
      executionPolicy,
      requiresLocalFallback,
      unexpectedFallbacks,
      localFallbacks,
      missingCatalogModels,
      missingDispatchModels,
      status: (requiresLocalFallback && localFallbacks.length === 0) || unexpectedFallbacks
        || missingCatalogModels.length || missingDispatchModels.length ? 'degraded' : 'ok'
    };
  });
  const issues = agentModels.flatMap((agent) => [
    ...(agent.requiresLocalFallback && agent.localFallbacks.length === 0 ? [{
      code: 'OPENCLAW_AGENT_LOCAL_FALLBACK_MISSING',
      severity: 'degraded',
      agentId: agent.id,
      path: agent.paths.fallbacks,
      message: `Cloud-primary OpenClaw agent ${agent.id} has no catalog-backed local fallback.`
    }] : []),
    ...(agent.unexpectedFallbacks ? [{
      code: 'OPENCLAW_GUARDED_FALLBACK_CONFIGURED',
      severity: 'degraded', agentId: agent.id, path: agent.paths.fallbacks,
      message: `Guarded dispatcher agent ${agent.id} must preserve its exact route without fallback.`
    }] : []),
    ...agent.missingDispatchModels.map(target => ({
      code: 'OPENCLAW_DISPATCH_MODEL_NOT_IN_CATALOG',
      severity: 'degraded', agentId: agent.id, path: target.path, model: target.model,
      message: `Dispatcher target ${target.model} is absent from the live provider catalog.`
    })),
    ...agent.missingCatalogModels.map((modelRef) => ({
      code: 'OPENCLAW_AGENT_LOCAL_MODEL_NOT_IN_CATALOG',
      severity: 'degraded',
      agentId: agent.id,
      path: modelRef === agent.primary ? agent.paths.primary : agent.paths.fallbacks,
      model: modelRef,
      message: `OpenClaw agent ${agent.id} references a local model absent from its live provider catalog.`
    }))
  ]);
  const degraded = issues.length;
  return {
    status: drift.length ? 'drift' : (degraded ? 'degraded' : 'ok'),
    drift,
    agentModels: {
      status: degraded ? 'degraded' : 'ok',
      checked: agentModels.length,
      degraded,
      agents: agentModels,
      issues
    }
  };
}

function validateRuntimeConfigs(exportData, current = {}) {
  return {
    hermes: compareHermesConfig(current.hermesConfig, exportData.hermes),
    openclaw: compareOpenClawConfig(current.openclawConfig, exportData.openclaw)
  };
}

module.exports = {
  buildRuntimeConfigExport,
  compareHermesConfig,
  compareOpenClawConfig,
  isCloudAuthorityModel,
  laneFromTask,
  parseParameterB,
  resolveOpenClawProviderBaseUrl,
  shortName,
  validateRuntimeConfigs
};
