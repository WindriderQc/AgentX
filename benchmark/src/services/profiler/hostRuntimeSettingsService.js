'use strict';

/**
 * Keeps HostProfile.ollama.settings in step with the observed Ollama service
 * (#368). Those settings enter the runtime fingerprint, so profiles measured
 * under other settings stop matching and the host is profiled again.
 *
 * Only a successful observation changes them. A missed one, or one whose unit
 * waits for `systemctl daemon-reload`, leaves the stored settings as they are,
 * so the fingerprint does not flip with the collector's availability.
 */

const HostProfile = require('../../../models/HostProfile');
const logger = require('../../../config/logger');
const { readHostHardware } = require('./hardwareCollectorClient');
const { inventoryForIdentity } = require('../../../../shared/gpuDriverObservation');
const { normalizeGpuInventory } = require('../../../../shared/gpuInventory');
const {
  normalizeRuntimeSettings,
  runtimeSettingsFromObservation,
  sameRuntimeSettings
} = require('../../../../shared/ollamaRuntimeSettings');

const SYNC_INTERVAL_MS = 5 * 60_000;
const lastSyncAt = new Map();

async function syncHostRuntimeSettings({ hostId, hostUrl } = {}, {
  readHardware = readHostHardware, model = HostProfile, now = Date.now, force = false, attempt = 0
} = {}) {
  if (!hostId || !hostUrl) return { synced: false, reason: 'host_required' };
  const at = now();
  if (!force && at - (lastSyncAt.get(hostId) || 0) < SYNC_INTERVAL_MS) return { synced: false, reason: 'recent' };
  lastSyncAt.set(hostId, at);

  const hardware = await readHardware(hostUrl).catch(() => null);
  const environment = hardware?.ollamaEnvironment || null;
  const reloadPending = environment?.needDaemonReload === true;
  const observed = reloadPending ? null : runtimeSettingsFromObservation({ environment, gpuCount: hardware?.knownGpuCount });
  const gpus = hardware?.status === 'observed' ? normalizeGpuInventory(hardware.gpus) : null;
  const current = await model.findOne({ hostId }).select('ollama.settings gpus gpuDriverObservation gpuDriverIdentityVersion updatedAt').lean();
  if (!current) return { synced: false, reason: 'no_host_profile' };
  if (!observed && !gpus) {
    if (current.gpuDriverObservation?.gpus) {
      await model.updateOne({ hostId }, { $set: { 'gpuDriverObservation.status': hardware?.status || 'unavailable' } });
    }
    return { synced: false, reason: reloadPending ? 'daemon_reload_pending' : 'not_observed' };
  }
  const previous = normalizeRuntimeSettings(current.ollama?.settings);
  // A GPU count the collector cannot give now keeps the last known one.
  const settings = observed ? { ...observed, gpuCount: observed.gpuCount ?? previous?.gpuCount ?? null } : previous;
  const settingsChanged = observed && !sameRuntimeSettings(previous, settings);
  const previousGpus = normalizeGpuInventory(current.gpus);
  const identityGpus = gpus && inventoryForIdentity(previousGpus, gpus, current.gpuDriverIdentityVersion);
  const gpusChanged = identityGpus && JSON.stringify(identityGpus) !== JSON.stringify(previousGpus);
  const driverObservation = gpus && {
    gpus, observedAt: new Date(hardware.sampledAt), staleAfterMs: hardware.staleAfterMs,
    status: 'observed', source: hardware.source
  };
  const observationChanged = driverObservation
    && JSON.stringify(driverObservation) !== JSON.stringify(current.gpuDriverObservation);

  const unavailableStatus = !gpus && current.gpuDriverObservation?.gpus
    ? hardware?.status || 'unavailable' : null;
  const availabilityChanged = unavailableStatus && unavailableStatus !== current.gpuDriverObservation.status;
  if (!settingsChanged && !gpusChanged && !observationChanged && !availabilityChanged) return { synced: false, reason: 'unchanged', settings };
  const update = {};
  if (settingsChanged) Object.assign(update, {
    'ollama.settings': settings,
    'ollama.settingsObservedAt': new Date(environment.observedAt),
    'ollama.settingsSource': environment.source
  });
  if (gpusChanged) Object.assign(update, {
    gpus: identityGpus, gpusObservedAt: new Date(hardware.sampledAt), gpusSource: hardware.source
  });
  if (observationChanged) update.gpuDriverObservation = driverObservation;
  else if (availabilityChanged) {
    update['gpuDriverObservation.status'] = unavailableStatus;
  }
  const saved = await model.updateOne({ hostId, updatedAt: current.updatedAt,
    gpuDriverIdentityVersion: current.gpuDriverIdentityVersion || { $exists: false } }, { $set: update });
  if (saved?.matchedCount === 0) {
    // An activation may have changed the identity policy while Data was read.
    // Recompute against that host with the same observation, never write a
    // legacy inventory over a newly activated driver identity.
    if (attempt < 2) return syncHostRuntimeSettings({ hostId, hostUrl }, {
      readHardware: async () => hardware, model, now, force: true, attempt: attempt + 1 });
    throw Object.assign(new Error('Host runtime synchronization lost its concurrency fence'), { code: 'HOST_RUNTIME_SYNC_CAS_FAILED' });
  }
  logger.info('Host runtime settings and GPU observations recorded', {
    hostId, previous, settings, gpusChanged: Boolean(gpusChanged), driverObservationChanged: Boolean(observationChanged)
  });
  return { synced: true, changed: Boolean((settingsChanged && previous) || (gpusChanged && previousGpus)), settings };
}

module.exports = {
  SYNC_INTERVAL_MS,
  syncHostRuntimeSettings,
  _resetForTests: () => lastSyncAt.clear()
};
