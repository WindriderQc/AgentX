'use strict';

/**
 * Runtime topology modes (#360), read-only phase.
 *
 * An instance declares, per GPU host group, the modes it can run in: for
 * example two single-GPU lanes, or one endpoint pooling both GPUs. Each mode
 * lists its endpoints and the role each one serves. This module validates
 * that declaration, observes which mode is actually running (registered host,
 * reachable runtime, pins resident) and resolves a role to the endpoint of the
 * active mode. It changes nothing: routing does not use it yet and no mode is
 * switched here.
 */

const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const hostPrefService = require('./hostPreferenceService');
const { modelsMatch } = require('../helpers/modelNameNormalization');
const { resourceTopology, resourcesFor } = require('./runtimePhysicalResources');

const ROLES = Object.freeze(['conversation', 'background', 'pooled']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/;
const LIMITS = Object.freeze({ bytes: 64 * 1024, groups: 8, modes: 6, endpoints: 8, label: 80 });
const PS_TIMEOUT_MS = 3000;

function invalid() {
  // The declaration names private endpoints: never echo it.
  return Object.assign(new Error('Runtime topology configuration is invalid'), {
    code: 'runtime_topology_configuration_invalid'
  });
}

function only(object, keys) {
  return object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).every(key => keys.includes(key));
}

function label(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > LIMITS.label) throw invalid();
  return value.trim();
}

function endpointUrl(value) {
  if (typeof value !== 'string' || value.length > 500) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') throw invalid();
  return hostUrlKey(value);
}

/**
 * @returns {{configured: boolean, groups: Array}} the validated declaration;
 *   unset or empty means "not configured". Throws a typed error when invalid.
 */
function parseTopology(raw = process.env.AGENTX_RUNTIME_TOPOLOGY_JSON) {
  if (raw === undefined || raw === null || raw === '') return { configured: false, groups: [] };
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMITS.bytes) throw invalid();
  let doc;
  try { doc = JSON.parse(raw); } catch { throw invalid(); }
  if (!only(doc, ['groups']) || !Array.isArray(doc.groups) || doc.groups.length > LIMITS.groups) throw invalid();
  const groupIds = new Set();
  const owner = new Map(); // endpoint -> group id: a runtime endpoint belongs to one group
  const groups = doc.groups.map(group => {
    if (!only(group, ['id', 'label', 'modes']) || typeof group.id !== 'string' || !ID.test(group.id)
      || groupIds.has(group.id) || !Array.isArray(group.modes) || !group.modes.length
      || group.modes.length > LIMITS.modes) throw invalid();
    groupIds.add(group.id);
    const modeIds = new Set();
    const modes = group.modes.map(mode => {
      if (!only(mode, ['id', 'label', 'endpoints']) || typeof mode.id !== 'string' || !ID.test(mode.id)
        || modeIds.has(mode.id) || !Array.isArray(mode.endpoints) || !mode.endpoints.length
        || mode.endpoints.length > LIMITS.endpoints) throw invalid();
      modeIds.add(mode.id);
      const urls = new Set();
      const roles = new Set();
      const endpoints = mode.endpoints.map(entry => {
        if (!only(entry, ['url', 'role']) || !ROLES.includes(entry.role)) throw invalid();
        const url = endpointUrl(entry.url);
        // One endpoint per role keeps role resolution unambiguous.
        if (urls.has(url) || roles.has(entry.role)) throw invalid();
        if (owner.has(url) && owner.get(url) !== group.id) throw invalid();
        urls.add(url); roles.add(entry.role); owner.set(url, group.id);
        return { url, role: entry.role };
      });
      return { id: mode.id, label: label(mode.label, mode.id), endpoints };
    });
    return { id: group.id, label: label(group.label, group.id), modes };
  });
  return { configured: groups.length > 0, groups };
}

async function readResident(url, fetchImpl) {
  try {
    const response = await fetchImpl(`${url}/api/ps`, { signal: AbortSignal.timeout(PS_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) return { online: false, models: [] };
    const body = await response.json();
    if (!Array.isArray(body?.models)) return { online: false, models: [] };
    return { online: true, models: body.models.map(model => ({
      name: model.name || model.model,
      contextLength: Number(model.context_length) || null,
      fullyOnGpu: Number(model.size) > 0 && Number(model.size_vram) === Number(model.size)
    })) };
  } catch {
    return { online: false, models: [] };
  }
}

function endpointState(endpoint, pref, live, physical) {
  const pins = pref ? hostPrefService.getPinnedEntries(pref).map(pin => ({
    model: pin.model, contextSize: pin.contextSize || null
  })) : [];
  const resident = pins.map(pin => live.models.find(model => modelsMatch(model.name, pin.model)) || null);
  const pinsResident = pins.length > 0 && resident.every(Boolean);
  const reason = !pref ? 'not_registered' : !live.online ? 'offline' : !pins.length ? 'no_pins'
    : pinsResident ? null : 'pins_not_resident';
  return {
    url: endpoint.url, role: endpoint.role,
    registered: Boolean(pref), hostKey: pref?.hostKey || null, hostName: pref?.displayName || null,
    resources: physical ? resourcesFor(physical, [endpoint.url]) : [],
    online: live.online, pins, pinsResident,
    residentModels: live.models,
    ready: reason === null, reason
  };
}

function modeStatus(endpoints) {
  if (endpoints.every(endpoint => endpoint.ready)) return 'active';
  return endpoints.some(endpoint => endpoint.online && endpoint.pinsResident) ? 'partial' : 'inactive';
}

/**
 * Observe every declared mode. Never throws for an unreachable runtime; an
 * invalid declaration is reported as such, without its content.
 */
async function describeTopology({ raw, fetchImpl = fetch, now = () => new Date() } = {}) {
  const observedAt = now().toISOString();
  let topology;
  try {
    topology = parseTopology(raw === undefined ? process.env.AGENTX_RUNTIME_TOPOLOGY_JSON : raw);
  } catch (error) {
    return { configured: true, valid: false, code: error.code, message: error.message, observedAt, groups: [] };
  }
  if (!topology.configured) return { configured: false, valid: true, observedAt, groups: [] };
  let physical = null;
  try { physical = resourceTopology(); } catch { physical = null; } // its own status is reported elsewhere
  const urls = [...new Set(topology.groups.flatMap(group => group.modes.flatMap(mode => mode.endpoints.map(e => e.url))))];
  const prefs = new Map((await hostPrefService.getAll()).map(pref => [hostUrlKey(pref.hostUrl), pref]));
  const live = new Map(await Promise.all(urls.map(async url => [url, await readResident(url, fetchImpl)])));
  const groups = topology.groups.map(group => {
    const modes = group.modes.map(mode => {
      const endpoints = mode.endpoints.map(endpoint => endpointState(endpoint, prefs.get(endpoint.url), live.get(endpoint.url), physical));
      return { id: mode.id, label: mode.label, status: modeStatus(endpoints), endpoints };
    });
    const active = modes.filter(mode => mode.status === 'active');
    return {
      id: group.id, label: group.label, modes,
      activeMode: active.length === 1 ? active[0].id : null,
      state: active.length === 1 ? 'active' : active.length > 1 ? 'conflict'
        : modes.some(mode => mode.status === 'partial') ? 'transitional' : 'none_active'
    };
  });
  return { configured: true, valid: true, observedAt, roles: ROLES, groups };
}

/**
 * The endpoint serving `role` in a group's active mode, from a description.
 * @returns {{url: string|null, mode: string|null, reason: string|null}}
 */
function resolveRole(description, groupId, role) {
  if (!ROLES.includes(role)) return { url: null, mode: null, reason: 'unknown_role' };
  const group = (description?.groups || []).find(entry => entry.id === groupId);
  if (!group) return { url: null, mode: null, reason: 'unknown_group' };
  if (!group.activeMode) return { url: null, mode: null, reason: group.state };
  const mode = group.modes.find(entry => entry.id === group.activeMode);
  const endpoint = mode.endpoints.find(entry => entry.role === role);
  return endpoint ? { url: endpoint.url, mode: mode.id, reason: null }
    : { url: null, mode: mode.id, reason: 'role_not_in_active_mode' };
}

module.exports = { ROLES, parseTopology, describeTopology, resolveRole };
