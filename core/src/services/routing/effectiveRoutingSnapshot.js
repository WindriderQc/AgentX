'use strict';

// Effective routing snapshot exposed to trusted extensions and external
// consumers: configured task routes, host preferences and per-task context
// and contract evidence.
const { frozenCopy } = require('../../helpers/frozenCopy');

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function sanitizeHostPreference(pref, getPinnedEntries) {
  return {
    hostUrl: pref?.hostUrl || null,
    displayName: pref?.displayName || null,
    status: pref?.status || null,
    loadedModel: pref?.loadedModel || null,
    loadedModels: Array.isArray(pref?.loadedModels) ? [...pref.loadedModels] : [],
    maxConcurrentModels: positiveInteger(pref?.maxConcurrentModels),
    vramTotalMiB: positiveInteger(pref?.vramTotalMiB),
    benchmarkClaimed: Boolean(pref?.status === 'benchmarking' || pref?.benchmarkClaim?.batchId),
    pinnedModels: getPinnedEntries(pref).map((entry) => ({
      model: entry.model,
      contextSize: positiveInteger(entry.contextSize),
      keepAlive: entry.keepAlive ?? null,
      autoRestore: entry.autoRestore ?? null
    }))
  };
}

function buildTaskSnapshot(taskType, task, routerConfig, preferencesByHost, modelsMatch) {
  const hostKey = task?.host || null;
  const hostUrl = hostKey ? routerConfig.hosts?.[hostKey] || null : null;
  const preference = hostUrl ? preferencesByHost.get(hostUrl) || null : null;
  const pin = preference?.pinnedModels?.find((entry) => modelsMatch(entry.model, task?.model)) || null;
  return {
    taskType,
    model: pin?.model || task?.model || null,
    configuredModel: task?.model || null,
    hostKey,
    hostUrl,
    contextSize: positiveInteger(pin?.contextSize),
    contextSource: pin?.contextSize ? 'host_preference_pin' : 'unresolved',
    keepAlive: pin?.keepAlive ?? null,
    pinAligned: Boolean(pin),
    hostPreference: preference
  };
}

async function resolveTaskEvidence(deps, resolved, options) {
  const contractInput = { model: resolved.model, host: resolved.hostUrl };
  const [contextInfo, inferenceContract] = await Promise.all([
    deps.getContextInfo(resolved.model, resolved.hostUrl),
    options.includeArtifactIdentity === true
      ? deps.resolveInferenceContract(contractInput, { includeArtifactIdentity: true })
      : deps.resolveInferenceContract(contractInput)
  ]);
  if (!resolved.contextSize && positiveInteger(contextInfo?.num_ctx)) {
    resolved.contextSize = positiveInteger(contextInfo.num_ctx);
    resolved.contextSource = contextInfo.source || 'context_info';
  }
  resolved.contextInfo = contextInfo;
  resolved.inferenceContract = inferenceContract;
}

async function readActiveCatalog(deps) {
  const docs = await deps.ModelRegistry.find({
    isActive: { $ne: false },
    status: { $ne: 'retired' }
  })
    .select('modelName sourceHost parameterSize quantization family capabilities categories')
    .sort({ modelName: 1 })
    .lean();
  return (docs || []).map((doc) => ({
    model: doc.modelName || null,
    hostUrl: doc.sourceHost || null,
    parameterSize: doc.parameterSize || null,
    quantization: doc.quantization || null,
    family: doc.family || null,
    capabilities: Array.isArray(doc.capabilities) ? doc.capabilities : [],
    categories: Array.isArray(doc.categories) ? doc.categories : []
  }));
}

async function buildEffectiveRoutingSnapshot(deps, options = {}) {
  const [routerConfig, rawPreferences] = await Promise.all([
    deps.buildRouterConfigPayload(options.routerOptions || {}),
    deps.hostPreferenceService.getAll()
  ]);
  const hostPreferences = (rawPreferences || []).map((pref) =>
    sanitizeHostPreference(pref, deps.hostPreferenceService.getPinnedEntries)
  );
  const preferencesByHost = new Map(hostPreferences.map((pref) => [pref.hostUrl, pref]));
  const tasks = {};
  const warnings = [];

  for (const [taskType, task] of Object.entries(routerConfig.taskModels || {})) {
    const resolved = buildTaskSnapshot(taskType, task, routerConfig, preferencesByHost, deps.modelsMatch);
    if (resolved.model) {
      try {
        await resolveTaskEvidence(deps, resolved, options);
      } catch (error) {
        resolved.resolutionError = String(error?.message || 'routing capability resolution failed');
      }
    }
    tasks[taskType] = resolved;
  }

  let catalog = [];
  if (options.includeCatalog !== false) {
    try {
      catalog = await readActiveCatalog(deps);
    } catch (error) {
      warnings.push(`Active model catalog is unavailable: ${error.message}`);
    }
  }

  return frozenCopy({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    authority: routerConfig.authority || null,
    hosts: routerConfig.hosts || {},
    tasks,
    hostPreferences,
    catalog,
    warnings
  });
}

module.exports = { buildEffectiveRoutingSnapshot };
