'use strict';

/**
 * Observed Ollama server settings.
 *
 * Some Ollama behaviour is decided by the server's environment, not by a
 * request: the KV cache type, flash attention, parallel requests, resident
 * model slots, GPU spreading and visible devices. The GPU collector reads them
 * read-only on each GPU host (a systemd unit's environment, or the Windows
 * machine and user environment), Data keeps the latest observation per host
 * and Core shows it. Only the allowlisted keys below are ever kept; every
 * other variable is discarded where it is read, so no secret can travel.
 */

const OLLAMA_ENV_KEYS = Object.freeze([
  'OLLAMA_KV_CACHE_TYPE',
  'OLLAMA_FLASH_ATTENTION',
  'OLLAMA_NUM_PARALLEL',
  'OLLAMA_MAX_LOADED_MODELS',
  'OLLAMA_MAX_QUEUE',
  'OLLAMA_SCHED_SPREAD',
  'OLLAMA_KEEP_ALIVE',
  'OLLAMA_CONTEXT_LENGTH',
  'OLLAMA_GPU_OVERHEAD',
  'OLLAMA_LLM_LIBRARY',
  'OLLAMA_VULKAN',
  'CUDA_VISIBLE_DEVICES',
]);
const ALLOWED = new Set(OLLAMA_ENV_KEYS);
const SOURCES = Object.freeze(['systemd', 'windows-registry']);
const WINDOWS_SERVICE = 'windows';
const SAFE_VALUE = /^[A-Za-z0-9_.,:+-]{0,64}$/;
const SAFE_UNIT = /^[A-Za-z0-9@_.:][A-Za-z0-9@_.:-]{0,127}$/;
const SAFE_STATE = /^[a-z-]{1,32}$/;
const SYSTEMD_PROPERTIES = Object.freeze([
  'LoadState', 'ActiveState', 'ExecMainStartTimestamp', 'NeedDaemonReload', 'Environment', 'EnvironmentFiles',
]);
const WINDOWS_MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const WINDOWS_USER_KEY = 'HKCU\\Environment';

function text(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

/**
 * Keep the allowlisted keys of `[key, value]` pairs, later pairs winning.
 * A listed key with an unexpected value is reported by name, without value.
 */
function pickAllowed(pairs, { caseInsensitive = false } = {}) {
  const values = {};
  const rejected = new Set();
  for (const [rawKey, rawValue] of pairs) {
    const key = caseInsensitive ? String(rawKey).toUpperCase() : String(rawKey);
    if (!ALLOWED.has(key)) continue;
    const value = String(rawValue ?? '');
    if (SAFE_VALUE.test(value)) {
      values[key] = value;
      rejected.delete(key);
    } else {
      delete values[key];
      rejected.add(key);
    }
  }
  return { values, rejectedKeys: [...rejected].sort() };
}

/** Split a systemd `Environment=` value into words, honouring quotes and escapes. */
function splitSystemdWords(input) {
  const words = [];
  let current = '';
  let quote = null;
  let started = false;
  const source = String(input || '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\' && quote === '"' && i + 1 < source.length) current += source[++i];
      else if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\' && i + 1 < source.length) {
      current += source[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

function assignments(words) {
  return words.map((word) => {
    const at = word.indexOf('=');
    return at > 0 ? [word.slice(0, at), word.slice(at + 1)] : null;
  }).filter(Boolean);
}

/** Arguments for `systemctl` that read one unit's environment and state. */
function systemdShowArgs(unit) {
  if (!SAFE_UNIT.test(String(unit || ''))) throw new Error('unit must be a plain systemd unit name');
  return ['show', unit, '--no-pager', ...SYSTEMD_PROPERTIES.map(property => `--property=${property}`)];
}

/** Parse `systemctl show` output into an observation (without `observedAt`). */
function parseSystemdShow(stdout, unit) {
  const properties = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) properties[line.slice(0, at)] = line.slice(at + 1);
  }
  if (!properties.LoadState) throw new Error('systemctl returned no unit properties');
  if (properties.LoadState === 'not-found') throw new Error(`unit ${unit} not found`);
  const { values, rejectedKeys } = pickAllowed(assignments(splitSystemdWords(properties.Environment)));
  return {
    source: 'systemd',
    unit,
    ok: true,
    values,
    rejectedKeys,
    activeState: SAFE_STATE.test(properties.ActiveState || '') ? properties.ActiveState : null,
    activeSince: text(properties.ExecMainStartTimestamp, 64) || null,
    needDaemonReload: properties.NeedDaemonReload === 'yes',
    environmentFiles: Boolean(text(properties.EnvironmentFiles, 500)),
  };
}

function parseRegistryValues(stdout) {
  const pairs = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ(?:\s+(.*?))?\s*$/.exec(line);
    if (match) pairs.push([match[1], match[2] || '']);
  }
  return pairs;
}

/**
 * Parse `reg query` output of the machine and the user environment. A process
 * started by that user sees the machine values overridden by the user values.
 */
function parseWindowsEnvironment(machineStdout, userStdout) {
  const pairs = [...parseRegistryValues(machineStdout), ...parseRegistryValues(userStdout)];
  const { values, rejectedKeys } = pickAllowed(pairs, { caseInsensitive: true });
  return { source: 'windows-registry', unit: null, ok: true, values, rejectedKeys,
    activeState: null, activeSince: null, needDaemonReload: null, environmentFiles: null };
}

function normalizeValues(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return pickAllowed(Object.entries(raw)).values;
}

/**
 * Validate an observation crossing a service boundary (agent → Data → Core).
 * Returns null when it is not an observation; never keeps an unlisted key.
 */
function normalizeOllamaEnvironment(raw) {
  if (!raw || typeof raw !== 'object' || !SOURCES.includes(raw.source)) return null;
  const observedAt = new Date(raw.observedAt);
  if (!Number.isFinite(observedAt.getTime())) return null;
  const unit = raw.source === 'systemd' && SAFE_UNIT.test(String(raw.unit || '')) ? raw.unit : null;
  const base = { source: raw.source, unit, observedAt: observedAt.toISOString() };
  if (raw.ok !== true) return { ...base, ok: false, error: text(raw.error, 400) || 'observation failed' };
  const bool = value => (typeof value === 'boolean' ? value : null);
  return {
    ...base,
    ok: true,
    values: normalizeValues(raw.values),
    rejectedKeys: Array.isArray(raw.rejectedKeys) ? raw.rejectedKeys.filter(key => ALLOWED.has(key)) : [],
    activeState: SAFE_STATE.test(String(raw.activeState || '')) ? raw.activeState : null,
    activeSince: text(raw.activeSince, 64) || null,
    needDaemonReload: bool(raw.needDaemonReload),
    environmentFiles: bool(raw.environmentFiles),
  };
}

module.exports = {
  OLLAMA_ENV_KEYS,
  SOURCES,
  WINDOWS_SERVICE,
  SAFE_UNIT,
  WINDOWS_MACHINE_KEY,
  WINDOWS_USER_KEY,
  pickAllowed,
  splitSystemdWords,
  systemdShowArgs,
  parseSystemdShow,
  parseWindowsEnvironment,
  normalizeOllamaEnvironment,
};
