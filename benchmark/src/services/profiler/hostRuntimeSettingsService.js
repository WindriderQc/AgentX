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
const { preserveInventoryDrivers } = require('../../../../shared/gpuDriverObservation');
const { normalizeGpuInventory } = require('../../../../shared/gpuInventory');
const {
  normalizeRuntimeSettings,
  runtimeSettingsFromObservation,
  sameRuntimeSettings
} = require('../../../../shared/ollamaRuntimeSettings');

const SYNC_INTERVAL_MS = 5 * 60_000;
const lastSyncAt = new Map();

async function syncHostRuntimeSettings({ hostId, hostUrl } = {}, {
  readHardware = readHostHardware, model = HostProfile, now = Date.now, force = false
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
  if (!observed && !gpus) return { synced: false, reason: reloadPending ? 'daemon_reload_pending' : 'not_observed' };

  const current = await model.findOne({ hostId }).select('ollama.settings gpus gpuDriverObservation').lean();
  if (!current) return { synced: false, reason: 'no_host_profile' };
  const previous = normalizeRuntimeSettings(current.ollama?.settings);
  // A GPU count the collector cannot give now keeps the last known one.
  const settings = observed ? { ...observed, gpuCount: observed.gpuCount ?? previous?.gpuCount ?? null } : previous;
  const settingsChanged = observed && !sameRuntimeSettings(previous, settings);
  const previousGpus = normalizeGpuInventory(current.gpus);
  const identityGpus = gpus && preserveInventoryDrivers(previousGpus, gpus);
  const gpusChanged = identityGpus && JSON.stringify(identityGpus) !== JSON.stringify(previousGpus);
  const driverObservation = gpus && {
    gpus, observedAt: new Date(hardware.sampledAt), source: hardware.source
  };
  const observationChanged = driverObservation
    && JSON.stringify(driverObservation) !== JSON.stringify(current.gpuDriverObservation);

  if (!settingsChanged && !gpusChanged && !observationChanged) return { synced: false, reason: 'unchanged', settings };
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
  await model.updateOne({ hostId }, { $set: update });
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
