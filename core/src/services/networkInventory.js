'use strict';

/**
 * Compact, read-only view of the Data network inventory for Nestor.
 *
 * Freshness is stated, never implied: the newest collector scan is compared
 * with Data's online window, and a stale or missing scan is said so in the
 * `freshness` sentence Nestor relays.
 */

const SCOPES = Object.freeze(['online', 'unknown', 'all']);
const MAX_DEVICES = 50;

function time(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function ageLabel(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} jours`;
}

function freshness(lastScanMs, onlineTtlMs, nowMs) {
  if (!lastScanMs) return { stale: true, text: 'Aucun scan réseau connu : l\'inventaire ne dit pas ce qui est branché maintenant.' };
  const age = nowMs - lastScanMs;
  if (age > onlineTtlMs) {
    return { stale: true, text: `Inventaire périmé : dernier scan il y a ${ageLabel(age)}. Ce qui est listé n'est pas confirmé maintenant.` };
  }
  return { stale: false, text: `Dernier scan il y a ${ageLabel(age)}.` };
}

function projectInventory({ devicesBody, agentsBody, scope = 'online', now = new Date() }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const devices = Array.isArray(devicesBody?.devices) ? devicesBody.devices : [];
  const summary = devicesBody?.summary || {};
  const onlineTtlMs = Number(summary.onlineTtlMs) > 0 ? Number(summary.onlineTtlMs) : 30 * 60000;
  const scanners = Array.isArray(agentsBody?.scanners) ? agentsBody.scanners : [];
  const lastScanMs = scanners.map((agent) => time(agent.lastScanAt)).filter(Boolean).sort((a, b) => b - a)[0] || null;
  const fresh = freshness(lastScanMs, onlineTtlMs, nowMs);

  const rows = devices.map((device) => {
    const known = Boolean(String(device.alias || '').trim() || device.knownAt);
    return {
      name: String(device.alias || device.hostname || '').trim() || null,
      hostname: device.hostname || null,
      ip: device.ip || null,
      mac: device.mac || null,
      vendor: device.vendor || null,
      state: device.observation?.state || 'never_confirmed',
      known,
      firstSeen: device.firstSeen || null,
      lastSeen: device.observation?.lastSeenAt || device.lastSeen || null,
    };
  });
  const selected = rows.filter((row) => (scope === 'all' ? true
    : scope === 'unknown' ? !row.known : row.state === 'online'));

  return {
    freshness: fresh.text,
    stale: fresh.stale,
    lastScanAt: lastScanMs ? new Date(lastScanMs).toISOString() : null,
    counts: {
      total: rows.length,
      online: rows.filter((row) => row.state === 'online').length,
      unknown: rows.filter((row) => !row.known).length,
    },
    scope,
    returned: Math.min(selected.length, MAX_DEVICES),
    truncated: selected.length > MAX_DEVICES,
    devices: selected.slice(0, MAX_DEVICES),
  };
}

async function readNetworkInventory({ scope = 'online' } = {}, deps = {}) {
  if (!SCOPES.includes(scope)) {
    throw Object.assign(new Error(`scope must be one of ${SCOPES.join(', ')}`), { code: 'INVALID_ARGUMENTS' });
  }
  const fetchData = deps.fetchData || require('./dataServiceClient').fetchData;
  const read = async (route) => {
    const { response, body } = await fetchData(route);
    if (!response.ok) throw Object.assign(new Error(`Data network inventory answered ${response.status}`), { code: 'DATA_UNAVAILABLE' });
    return body?.data || {};
  };
  const [devicesBody, agentsBody] = await Promise.all([read('/api/v1/network/devices'), read('/api/v1/network/agents')]);
  return projectInventory({ devicesBody, agentsBody, scope, now: deps.now ? deps.now() : new Date() });
}

module.exports = { SCOPES, projectInventory, readNetworkInventory };
