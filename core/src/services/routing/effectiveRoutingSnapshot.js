'use strict';

// Effective routing snapshot exposed to trusted extensions and external
// consumers: configured task routes, host preferences and per-task context
// and contract evidence. Resolving a task reads its host's Ollama catalog, so
// a caller's `signal` is carried to every read, and once it aborts no further
// read starts (#189).
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

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('routing snapshot aborted');
}

async function resolveTaskEvidence(deps, resolved, options) {
  const { signal, identityMemo } = options;
  const contractInput = { model: resolved.model, host: resolved.hostUrl };
  const contractOptions = {
    ...(options.includeArtifactIdentity === true && { includeArtifactIdentity: true }),
    ...(signal && { signal }),
    ...(identityMemo && { identityMemo })
  };
  // The snapshot cache's memo resolves one exact artifact identity per model
  // and host for every task and for both reads below (#258).
  const contextOptions = {
    ...(signal && { signal }),
    ...(identityMemo && { deps: { identityMemo } })
  };
  const [contextInfo, inferenceContract] = await Promise.all([
    Object.keys(contextOptions).length
      ? deps.getContextInfo(resolved.model, resolved.hostUrl, contextOptions)
      : deps.getContextInfo(resolved.model, resolved.hostUrl),
    Object.keys(contractOptions).length
      ? deps.resolveInferenceContract(contractInput, contractOptions)
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
  const { signal } = options;
  throwIfAborted(signal);
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
    // A departed caller must not open further host reads.
    throwIfAborted(signal);
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
  throwIfAborted(signal);

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
