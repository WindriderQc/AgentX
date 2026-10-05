'use strict';

/**
 * Inference host registry: the Ollama endpoints this instance may use.
 *
 * The env slots (`OLLAMA_HOST`, `_2`, `_3`) bootstrap the first hosts; every
 * further endpoint is registered here, from the Nerve Center, without a slot
 * limit. A registry entry may also annotate an env host (name, residency,
 * concurrency) by using its URL. Core keeps a synchronous snapshot in the
 * shared host config so existing callers stay synchronous.
 */

const net = require('net');
const InferenceHost = require('../../models/InferenceHost');
const HostPreference = require('../../models/HostPreference');
const RouterTaskConfig = require('../../models/RouterTaskConfig');
const hostConfig = require('../helpers/ollamaHostConfig');
const { HOST_ID_PATTERN, hostUrlKey, normalizeHostUrl } = require('../../../shared/ollamaHostConfig');
const logger = require('../../config/logger');

const BOOTSTRAP_IDS = new Set(['primary', 'secondary', 'tertiary']);
const PROBE_TIMEOUT_MS = 3000;

class RegistryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isPrivateIpv4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// LAN only: private or loopback addresses and local names. A public endpoint
// would turn the registry into an outbound proxy.
function assertLanUrl(raw) {
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(String(raw || '').trim()) ? String(raw).trim() : `http://${String(raw || '').trim()}`);
  } catch {
    throw new RegistryError(400, 'HOST_URL_INVALID', 'Use an address such as http://192.168.1.20:11434');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new RegistryError(400, 'HOST_URL_INVALID', 'Use only scheme, address and port, without a path');
  }
  const hostname = parsed.hostname.toLowerCase();
  const ipVersion = net.isIP(hostname.replace(/^\[|\]$/g, ''));
  const local = ipVersion === 4 ? isPrivateIpv4(hostname)
    : ipVersion === 6 ? ['[::1]', '::1'].includes(hostname)
      : hostname === 'localhost' || !hostname.includes('.') || /\.(local|lan|home\.arpa|internal)$/.test(hostname);
  if (!local) {
    throw new RegistryError(400, 'HOST_URL_NOT_LAN', 'Only private network or loopback addresses can be registered');
  }
  return normalizeHostUrl(parsed.origin);
}

function toSnapshot(doc) {
  return {
    id: doc.hostId,
    name: doc.name,
    url: doc.url,
    residency: doc.residency,
    maxInflight: doc.maxInflight,
    vramMb: doc.vramMb,
    priority: doc.priority
  };
}

function refreshRouting() {
  try { require('./modelRouterDefaults').refreshHosts(); } catch (error) {
    logger.warn('Routing host keys were not refreshed', { error: error.message });
  }
}

async function load() {
  const docs = await InferenceHost.find({}).sort({ priority: 1, createdAt: 1 }).lean();
  const count = hostConfig.setRegisteredHosts(docs.map(toSnapshot));
  refreshRouting();
  return count;
}

async function probe(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${url}/api/version`, { signal: controller.signal });
    if (!response.ok) return { reachable: false, error: `HTTP ${response.status}` };
    const body = await response.json().catch(() => ({}));
    return { reachable: true, version: body?.version || null };
  } catch (error) {
    return { reachable: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

function envHostFor(idOrUrl) {
  const key = hostUrlKey(idOrUrl);
  return hostConfig.getConfiguredHosts()
    .find(host => host.source === 'env' && (host.id === idOrUrl || hostUrlKey(host.url) === key)) || null;
}

function readAttributes(body = {}, { partial = false } = {}) {
  const out = {};
  if (body.name !== undefined) out.name = String(body.name || '').trim().slice(0, 64);
  if (body.residency !== undefined || !partial) {
    const residency = body.residency === undefined ? 'gpu' : body.residency;
    if (!['gpu', 'cpu'].includes(residency)) throw new RegistryError(400, 'HOST_RESIDENCY_INVALID', 'Residency is gpu or cpu');
    out.residency = residency;
  }
  if (body.maxInflight !== undefined) {
    const value = body.maxInflight === null || body.maxInflight === '' ? null : Number(body.maxInflight);
    if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 16)) {
      throw new RegistryError(400, 'HOST_INFLIGHT_INVALID', 'Concurrent requests must be between 1 and 16');
    }
    out.maxInflight = value;
  } else if (!partial && out.residency === 'cpu') {
    out.maxInflight = 1;
  }
  if (body.vramMb !== undefined) {
    const value = Number(body.vramMb || 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new RegistryError(400, 'HOST_VRAM_INVALID', 'VRAM is a whole number of MiB');
    out.vramMb = value;
  }
  if (body.priority !== undefined) {
    const value = Number(body.priority || 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new RegistryError(400, 'HOST_PRIORITY_INVALID', 'Priority is a positive whole number');
    out.priority = value;
  }
  return out;
}

async function list() {
  const docs = await InferenceHost.find({}).lean();
  const byKey = new Map(docs.map(doc => [hostUrlKey(doc.url), doc]));
  // Benchmark reads this list: its probes on a CPU host reuse the pin's threads.
  const preferences = await HostPreference.find({ 'pinnedModels.numThread': { $gt: 0 } }).select('hostUrl pinnedModels').lean();
  const threadsByKey = new Map(preferences.map(pref => [hostUrlKey(pref.hostUrl), Object.fromEntries(
    (pref.pinnedModels || []).filter(pin => pin.numThread > 0).map(pin => [pin.model, pin.numThread]))]));
  return hostConfig.getConfiguredHosts().map(host => ({
    ...host,
    pinThreads: threadsByKey.get(hostUrlKey(host.url)) || {},
    registered: byKey.has(hostUrlKey(host.url)),
    removable: host.source === 'registry'
  }));
}

async function create(body = {}, { fetchImpl } = {}) {
  const hostId = String(body.id || body.hostId || '').trim().toLowerCase();
  if (!HOST_ID_PATTERN.test(hostId)) {
    throw new RegistryError(400, 'HOST_ID_INVALID', 'Id: lowercase letters, digits and dashes, 32 characters at most');
  }
  if (BOOTSTRAP_IDS.has(hostId)) throw new RegistryError(409, 'HOST_ID_RESERVED', `"${hostId}" is reserved for the configuration file hosts`);
  const url = assertLanUrl(body.url);
  if (hostConfig.getConfiguredHosts().some(host => host.id === hostId || hostUrlKey(host.url) === hostUrlKey(url))) {
    throw new RegistryError(409, 'HOST_ALREADY_CONFIGURED', 'This id or address is already configured');
  }
  const reachability = await probe(url, fetchImpl);
  const doc = await InferenceHost.create({ hostId, url, ...readAttributes(body) });
  await load();
  // The host card's pin editor works on the host preference; create it with
  // the host so the first pin can be added from the Nerve Center.
  await HostPreference.updateOne({ hostUrl: url },
    { $setOnInsert: { hostUrl: url, hostKey: hostId, displayName: doc.name || hostId, status: 'idle' } },
    { upsert: true });
  logger.info('Inference host registered', { hostId, url, residency: doc.residency, reachable: reachability.reachable });
  return { host: toSnapshot(doc.toObject()), reachability };
}

async function update(hostId, body = {}) {
  const attributes = readAttributes(body, { partial: true });
  if (body.url !== undefined) {
    throw new RegistryError(400, 'HOST_URL_IMMUTABLE', 'Remove the host and add it again to change its address');
  }
  let doc = await InferenceHost.findOne({ hostId });
  if (!doc) {
    // First edit of an env host creates its annotation.
    const envHost = envHostFor(hostId);
    if (!envHost) throw new RegistryError(404, 'HOST_NOT_FOUND', 'Unknown host');
    doc = new InferenceHost({ hostId: envHost.id, url: envHost.url });
  }
  Object.assign(doc, attributes);
  await doc.save();
  await load();
  return { host: toSnapshot(doc.toObject()) };
}

async function remove(hostId) {
  const doc = await InferenceHost.findOne({ hostId }).lean();
  if (!doc) throw new RegistryError(404, 'HOST_NOT_FOUND', 'Unknown host');
  if (!BOOTSTRAP_IDS.has(hostId)) {
    const pinned = await HostPreference.findOne({ hostUrl: doc.url, 'pinnedModels.0': { $exists: true } }).lean();
    if (pinned) throw new RegistryError(409, 'HOST_HAS_PINS', 'Clear this host\'s resident models first');
    const routed = await RouterTaskConfig.findOne({ host: hostId }).lean();
    if (routed) throw new RegistryError(409, 'HOST_IN_ROUTING', `Task ${routed.taskType} still routes to this host`);
  }
  await InferenceHost.deleteOne({ hostId });
  // A registered host's empty preference would otherwise read as an unconfigured host.
  if (!BOOTSTRAP_IDS.has(hostId)) await HostPreference.deleteOne({ hostUrl: doc.url, 'pinnedModels.0': { $exists: false } });
  await load();
  return { removed: hostId };
}

module.exports = { load, list, create, update, remove, probe, assertLanUrl, RegistryError };
