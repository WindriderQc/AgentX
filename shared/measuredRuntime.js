'use strict';

/**
 * The runtime a piece of evidence was measured on (#908): the Ollama version
 * from /api/version and the GPU driver, recorded on each context profile,
 * performance profile and tool qualification at measurement time.
 *
 * The Ollama version stays out of the runtime fingerprint. A version change does not
 * void evidence; it is shown as drift so an operator can re-measure. What
 * physically changes a result (GPU set, VRAM, KV cache type, flash attention,
 * visible devices) remains in the fingerprint (shared/artifactIdentity.js).
 */

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The host's GPU driver(s) as the collector reported them, or null. */
function gpuDriverOf(hostProfile = {}, { observedAt = new Date() } = {}) {
  const observation = hostProfile?.gpuDriverObservation;
  if (Array.isArray(observation?.gpus)) {
    const ageMs = new Date(observedAt).getTime() - new Date(observation.observedAt).getTime();
    // Data owns the freshness window. A cached inventory does not attest the
    // driver of a later measurement after that window, or after a failed read.
    if (observation.status !== 'observed' || !Number.isFinite(Number(observation.staleAfterMs))
      || !(Number(observation.staleAfterMs) > 0)
      || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > Number(observation.staleAfterMs)) return null;
    const drivers = observation.gpus.map(gpu => text(gpu?.driver));
    // Partial inventories cannot attest the complete host driver set.
    return drivers.length && drivers.every(Boolean) ? [...new Set(drivers)].sort().join(', ') : null;
  }
  const drivers = new Set();
  for (const gpu of Array.isArray(hostProfile?.gpus) ? hostProfile.gpus : []) {
    const driver = text(gpu?.driver);
    if (driver) drivers.add(driver);
  }
  const single = text(hostProfile?.gpu?.driver);
  if (single) drivers.add(single);
  return drivers.size ? [...drivers].sort().join(', ') : null;
}

/**
 * @param {{ollamaVersion?: string|null, hostProfile?: object|null, observedAt?: Date|string}} input
 * @returns {{ollamaVersion: string|null, gpuDriver: string|null, observedAt: string}}
 */
function buildMeasuredRuntime({ ollamaVersion = null, hostProfile = null, observedAt = new Date() } = {}) {
  const at = new Date(observedAt);
  return {
    ollamaVersion: text(ollamaVersion),
    gpuDriver: gpuDriverOf(hostProfile || {}, { observedAt: Number.isFinite(at.getTime()) ? at : new Date() }),
    observedAt: Number.isFinite(at.getTime()) ? at.toISOString() : new Date().toISOString()
  };
}

/** A stored value reduced to its known fields, or null when nothing was recorded. */
function normalizeMeasuredRuntime(value) {
  if (!value || typeof value !== 'object') return null;
  const runtime = {
    ollamaVersion: text(value.ollamaVersion),
    gpuDriver: text(value.gpuDriver),
    observedAt: text(typeof value.observedAt === 'string' ? value.observedAt
      : value.observedAt instanceof Date ? value.observedAt.toISOString() : null)
  };
  return runtime.ollamaVersion || runtime.gpuDriver ? runtime : null;
}

/**
 * Version drift between the runtime the evidence was measured on and the one
 * installed now. Null when the installed version is unknown or the same.
 * `measured: null` means the evidence predates this record (#908): its
 * version was never written, so it cannot be shown to match.
 *
 * @returns {{measured: string|null, installed: string}|null}
 */
function runtimeVersionDrift(measured, installed) {
  const installedVersion = text(installed?.ollamaVersion ?? installed);
  if (!installedVersion) return null;
  const measuredVersion = text(normalizeMeasuredRuntime(measured)?.ollamaVersion);
  if (measuredVersion === installedVersion) return null;
  return { measured: measuredVersion, installed: installedVersion };
}

module.exports = {
  buildMeasuredRuntime,
  gpuDriverOf,
  normalizeMeasuredRuntime,
  runtimeVersionDrift
};
