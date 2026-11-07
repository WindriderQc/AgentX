'use strict';
const router = require('express').Router();
const logger = require('../config/logger');
const { HOSTS, TASK_MODELS } = require('../src/services/modelRouterConfig');
const hostPrefService = require('../src/services/hostPreferenceService');
const { modelsMatch } = require('../src/helpers/modelNameNormalization');
const { hostUrlKey } = require('../src/helpers/ollamaHostConfig');
const { getLoadedEntryStatus } = require('../src/services/hostPinPrimitives');
const { readHostRuntime } = require('../src/services/hostRuntimeReadService');
const { projectHostPreferenceForRead } = require('../src/services/hostPreferencePublicProjection');
const { readHostGpuHealth } = require('../src/services/hostGpuHealthService');
const { getGpuTelemetryForHosts } = require('../src/services/gpuTelemetryService');
const { readModelParallelism } = require('../src/services/ollamaModelParallelismService');
const { readVoiceReviewContention } = require('../src/services/voiceReviewContention');
router.get('/host-preferences', async (_req, res) => {
  try {
    const prefs = await hostPrefService.getAll();
    const hostIdentityDrift = hostPrefService.detectHostPreferenceIdentityDrift(prefs);
    const normalizedPrefs = prefs.map((pref) => projectHostPreferenceForRead(
      hostPrefService.normalizeHostPreferenceIdentity(pref)
    ));
    const telemetryByHost = await getGpuTelemetryForHosts(normalizedPrefs.map(pref => ({ id: pref.hostUrl, url: pref.hostUrl })));

    // Build set of models referenced by TASK_MODELS per host key, then map to URLs
    const taskRoutedByUrl = new Map();
    for (const entry of Object.values(TASK_MODELS)) {
      const hostUrl = HOSTS[entry.host];
      if (!hostUrl || !entry.model) continue;
      const key = hostUrlKey(hostUrl);
      if (!taskRoutedByUrl.has(key)) taskRoutedByUrl.set(key, new Set());
      taskRoutedByUrl.get(key).add(entry.model);
    }

    // Merge live Ollama status from each host. `pinnedModels` is the only
    // canonical surface — legacy emit (defaultModels / pinnedModel / flat
    // keepAlive / contextSize / autoRestore) is retired.
    const data = await Promise.all(normalizedPrefs.map(async (pref) => {
      const pinnedEntries = hostPrefService.getPinnedEntries(pref);
      const pinnedNames = pinnedEntries.map(e => e.model);
      const primaryPin = pinnedNames[0] || null;
      // Configuration drift does not depend on a successful runtime read.
      const routedModels = taskRoutedByUrl.get(hostUrlKey(pref.hostUrl)) || new Set();
      const driftModels = pinnedNames.filter(m => !routedModels.has(m));
      const runtime = await readHostRuntime(pref.hostUrl);
      const observedAt = runtime.observation.observedAt || runtime.observation.checkedAt;
      if (!runtime.online) {
        return {
          ...pref,
          pinnedModels: pinnedEntries,
          driftModels,
          live: {
            online: false,
            runningModels: [],
            pinnedLoaded: null,
            anyPinnedLoaded: false,
            gpuHealth: { status: runtime.status === 'inactive' ? 'not_applicable' : 'unknown',
              reason: runtime.status === 'inactive' ? 'topology_parked' : 'gpu_residency_unverified', checkedAt: observedAt },
            ...(runtime.observation.reason === 'blocked_by_allowlist' ? { blockedByAllowlist: true } : {}),
            status: runtime.status,
            observation: runtime.observation,
            ...(runtime.topology ? { topology: runtime.topology } : {}),
            observedAt
          }
        };
      }

      const safeHostUrl = runtime.hostUrl;

      try {
        const psData = { models: runtime.runningModels };
        const gpuHealth = await readHostGpuHealth(safeHostUrl, { pref, runningModels: psData.models, telemetry: telemetryByHost.get(pref.hostUrl), checkedAt: observedAt });
        const runningModels = (psData.models || []).map(m => {
          const name = m.name || m.model;
          const matchedPinned = pinnedNames.find(p => modelsMatch(name, p)) || null;
          return {
            name,
            size: m.size,
            sizeVram: m.size_vram,
            expiresAt: m.expires_at,
            contextLength: m.context_length,
            matchedPinned
          };
        });
        const anyPinnedLoaded = runningModels.some(rm => rm.matchedPinned !== null);
        // Request slots Ollama forces per model; other models follow OLLAMA_NUM_PARALLEL.
        const modelParallelism = await readModelParallelism(safeHostUrl, [...pinnedNames, ...runningModels.map(rm => rm.name)]);
        return {
          ...pref,
          pinnedModels: pinnedEntries,
          driftModels,
          live: {
            gpuHealth,
            online: true,
            status: runtime.status,
            observation: runtime.observation,
            runningModels,
            pinnedLoaded: primaryPin
              ? runningModels.some(rm => modelsMatch(rm.name, primaryPin))
              : null,
            anyPinnedLoaded,
            modelParallelism,
            allPinnedLoaded: pinnedEntries.length > 0 && pinnedEntries.every(entry => {
              const status = getLoadedEntryStatus(entry, psData.models);
              return status.loaded && !status.contextMismatch && !status.residencyMismatch && !status.vramSpill;
            }),
            observedAt
          }
        };
      } catch {
        return {
          ...pref,
          pinnedModels: pinnedEntries,
          driftModels,
          live: { gpuHealth: { status: 'unknown', reason: 'gpu_residency_unverified', checkedAt: observedAt }, online: false, runningModels: [], pinnedLoaded: null, anyPinnedLoaded: false, observedAt }
        };
      }
    }));
    res.json({
      status: 'success',
      data,
      healthCheckIntervalMs: hostPrefService.getHealthCheckIntervalMs(),
      hostIdentityDrift,
      voiceReviewContention: await readVoiceReviewContention(data)
    });
  } catch (err) {
    logger.error('[NerveCenter] host preferences fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
