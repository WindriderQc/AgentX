'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SWITCH = /^switch\.[a-z0-9_]+$/;
const SENSOR = /^sensor\.[a-z0-9_]+$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function configuration(env = process.env) {
  if (!env.AGENTX_INSTANCE_ROOT) return null;
  try {
    const root = env.AGENTX_INSTANCE_ROOT;
    const { baseUrl, plug } = JSON.parse(fs.readFileSync(path.join(root, 'config/home-assistant.json'), 'utf8'));
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
        || base.pathname !== '/' || base.search || base.hash) return null;
    const label = typeof plug?.label === 'string' ? plug.label.trim() : '';
    if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)
        || typeof plug.switchEntity !== 'string' || !SWITCH.test(plug.switchEntity)
        || typeof plug.powerEntity !== 'string' || !SENSOR.test(plug.powerEntity)) return null;
    return { origin: base.origin, label, switchEntity: plug.switchEntity, powerEntity: plug.powerEntity,
      tokenFile: path.join(root, 'credentials/home-assistant-nestor.token') };
  } catch {
    return null;
  }
}

function reportedAt(state) {
  const epoch = Date.parse(state?.last_reported ?? state?.last_updated);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

async function getState(fetchImpl, config, token, entityId) {
  try {
    const response = await fetchImpl(new URL('/api/states/' + entityId, config.origin), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2500),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    });
    if (!response.ok) return null;
    const value = await response.json();
    return value?.entity_id === entityId ? value : null;
  } catch {
    return null;
  }
}

async function readPlug({ config = configuration(), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const base = { source: 'home-assistant', label: config?.label ?? null, state: null, power: null };
  const result = (status, fields) => ({ ...base, ...fields, status, checkedAt: new Date(now()).toISOString() });
  if (!config) return result('not_configured');
  let token;
  try {
    token = (await fs.promises.readFile(config.tokenFile, 'utf8')).trim();
  } catch {
    return result('credentials_unavailable');
  }
  if (!token || /\s/.test(token)) return result('credentials_unavailable');

  const [outlet, meter] = await Promise.all([
    getState(fetchImpl, config, token, config.switchEntity),
    getState(fetchImpl, config, token, config.powerEntity)
  ]);
  const switchAt = reportedAt(outlet);
  const state = switchAt && ['on', 'off'].includes(outlet.state) ? { value: outlet.state, reportedAt: switchAt } : null;
  const meterAt = reportedAt(meter);
  const watts = typeof meter?.state === 'string' && DECIMAL.test(meter.state) ? Number(meter.state) : NaN;
  const power = meterAt && meter.attributes?.unit_of_measurement === 'W' && Number.isFinite(watts)
    ? { watts, reportedAt: meterAt } : null;
  return result(state && power ? 'available' : state || power ? 'partial' : 'unavailable', { state, power });
}

module.exports = { configuration, readPlug };
