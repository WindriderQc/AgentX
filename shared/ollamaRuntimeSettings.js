'use strict';

/**
 * The Ollama server settings that change what a profile measures (#368): the
 * KV cache type and flash attention (context ceiling and speed), the devices
 * Ollama may use, whether it spreads a model across them, and how many GPUs
 * that leaves. They enter the runtime fingerprint, so evidence measured under
 * other settings stops counting as current.
 *
 * Derived only from an observation that succeeded (shared/ollamaServiceEnvironment.js).
 * An unset key reads as Ollama's default, named `default` rather than guessed.
 */

const { normalizeKvCacheType } = require('./kvCacheEstimate');

const SETTINGS_KEYS = Object.freeze(['kvCacheType', 'flashAttention', 'visibleDevices', 'schedSpread', 'gpuCount']);

function switchValue(raw) {
  if (raw == null || raw === '') return 'default';
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(value)) return 'on';
  if (['0', 'false', 'off', 'no', 'disabled'].includes(value)) return 'off';
  return 'other';
}

function visibleDeviceIds(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw).split(',').map(id => id.trim()).filter(Boolean);
}

/**
 * @param {{ environment?: object, gpus?: object[], gpuCount?: number }} observation
 *   environment: a normalized Ollama environment observation; gpus or
 *   gpuCount: the GPUs the hardware collector sees on that machine.
 * @returns {object|null} settings, or null when the environment was not observed
 */
function runtimeSettingsFromObservation({ environment, gpus, gpuCount } = {}) {
  if (!environment || environment.ok !== true || !environment.values || typeof environment.values !== 'object') {
    return null;
  }
  const values = environment.values;
  const kvRaw = values.OLLAMA_KV_CACHE_TYPE;
  const devices = visibleDeviceIds(values.CUDA_VISIBLE_DEVICES);
  const hardwareCount = Number.isSafeInteger(gpuCount) && gpuCount > 0 ? gpuCount
    : (Array.isArray(gpus) && gpus.length > 0 ? gpus.length : null);
  return {
    kvCacheType: kvRaw == null || kvRaw === '' ? 'default' : (normalizeKvCacheType(kvRaw) || 'other'),
    flashAttention: switchValue(values.OLLAMA_FLASH_ATTENTION),
    visibleDevices: devices ? devices.join(',') : 'default',
    schedSpread: switchValue(values.OLLAMA_SCHED_SPREAD),
    // CUDA_VISIBLE_DEVICES limits what Ollama sees; nvidia-smi lists the machine.
    gpuCount: devices ? devices.filter(id => id !== '-1').length : hardwareCount,
  };
}

/** The settings as stored, reduced to the fingerprinted keys, or null. */
function normalizeRuntimeSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const settings = {};
  for (const key of SETTINGS_KEYS) {
    const value = raw[key];
    if (key === 'gpuCount') settings[key] = Number.isSafeInteger(value) && value >= 0 ? value : null;
    else settings[key] = typeof value === 'string' && value ? value.slice(0, 64) : 'default';
  }
  return settings;
}

function sameRuntimeSettings(left, right) {
  const a = normalizeRuntimeSettings(left);
  const b = normalizeRuntimeSettings(right);
  return Boolean(a && b) && SETTINGS_KEYS.every(key => a[key] === b[key]);
}

module.exports = { SETTINGS_KEYS, normalizeRuntimeSettings, runtimeSettingsFromObservation, sameRuntimeSettings };
