'use strict';
const router = require('express').Router();
const logger = require('../config/logger');
const { HOSTS, TASK_MODELS } = require('../src/services/modelRouterConfig');
const hostPrefService = require('../src/services/hostPreferenceService');
const { modelsMatch } = require('../src/helpers/modelNameNormalization');
const { getLoadedEntryStatus } = require('../src/services/hostPinPrimitives');
const { validateHostUrl } = require('../src/helpers/ollamaHostConfig');
const { projectHostPreferenceForRead } = require('../src/services/hostPreferencePublicProjection');
const { readHostGpuHealth } = require('../src/services/hostGpuHealthService');
const { getGpuTelemetryForHosts } = require('../src/services/gpuTelemetryService');
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
      if (!taskRoutedByUrl.has(hostUrl)) taskRoutedByUrl.set(hostUrl, new Set());
      taskRoutedByUrl.get(hostUrl).add(entry.model);
    }

    // Merge live Ollama status from each host. `pinnedModels` is the only
    // canonical surface — legacy emit (defaultModels / pinnedModel / flat
    // keepAlive / contextSize / autoRestore) is retired.
    const data = await Promise.all(normalizedPrefs.map(async (pref) => {
      const observedAt = new Date().toISOString();
      const validation = validateHostUrl(pref.hostUrl);
      if (!validation.valid) {
        return {
          ...pref,
          pinnedModels: hostPrefService.getPinnedEntries(pref),
          driftModels: [],
          live: {
            online: false,
            runningModels: [],
            pinnedLoaded: null,
            anyPinnedLoaded: false,
            gpuHealth: { status: 'unknown', reason: 'preferences_unavailable', checkedAt: observedAt },
            blockedByAllowlist: true,
            observedAt
          }
        };
      }

      const safeHostUrl = validation.host || pref.hostUrl;
      const pinnedEntries = hostPrefService.getPinnedEntries(pref);
      const pinnedNames = pinnedEntries.map(e => e.model);
      const primaryPin = pinnedNames[0] || null;
      // Drift: pinned models not referenced by any task on this host
      const routedModels = taskRoutedByUrl.get(safeHostUrl) || new Set();
      const driftModels = pinnedNames.filter(m => !routedModels.has(m));

      try {
        const psResponse = await fetch(`${safeHostUrl}/api/ps`, {
          signal: AbortSignal.timeout(3_000)
        });
        if (!psResponse.ok) throw new Error('Model inventory unavailable');
        const psData = await psResponse.json();
        if (!Array.isArray(psData.models)) throw new Error('Malformed model inventory');
        const gpuHealth = await readHostGpuHealth(safeHostUrl, { pref, runningModels: psData.models, telemetry: telemetryByHost.get(pref.hostUrl), checkedAt: observedAt });
        const runningModels = (psData.models || []).map(m => {
          const matchedPinned = pinnedNames.find(p => modelsMatch(m.name, p)) || null;
          return {
            name: m.name,
            size: m.size,
            sizeVram: m.size_vram,
            expiresAt: m.expires_at,
            contextLength: m.context_length,
            matchedPinned
          };
        });
        const anyPinnedLoaded = runningModels.some(rm => rm.matchedPinned !== null);
        return {
          ...pref,
          pinnedModels: pinnedEntries,
          driftModels,
          live: {
            gpuHealth,
            online: true,
            runningModels,
            pinnedLoaded: primaryPin
              ? runningModels.some(rm => modelsMatch(rm.name, primaryPin))
              : null,
            anyPinnedLoaded,
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
      hostIdentityDrift
    });
  } catch (err) {
    logger.error('[NerveCenter] host preferences fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
