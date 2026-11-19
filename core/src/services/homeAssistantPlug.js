'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SWITCH = /^switch\.[a-z0-9_]+$/;
const SENSOR = /^sensor\.[a-z0-9_]+$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const DEVICE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const cleanLabel = value => typeof value === 'string' && value.trim().length <= 80
  && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : '';
const foldDeviceName = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function mapping(plug) {
  const label = cleanLabel(plug?.label);
  if (!label || typeof plug.switchEntity !== 'string' || !SWITCH.test(plug.switchEntity)
      || typeof plug.powerEntity !== 'string' || !SENSOR.test(plug.powerEntity)
      || plug.energyEntity !== undefined && (typeof plug.energyEntity !== 'string' || !SENSOR.test(plug.energyEntity))) return null;
  return { label, switchEntity: plug.switchEntity, powerEntity: plug.powerEntity,
    ...(plug.energyEntity && { energyEntity: plug.energyEntity }) };
}

function additionalMappings(rows, primary) {
  if (!Array.isArray(rows) || rows.length > 12) return [];
  const ids = new Set(['default', 'garage-camera']);
  const names = new Set(primary.aliases);
  const mappings = [];
  for (const row of rows) {
    const plug = mapping(row);
    if (!plug || typeof row.id !== 'string' || !DEVICE.test(row.id) || ids.has(row.id)
        || !Array.isArray(row.aliases) || row.aliases.length > 10) continue;
    const aliases = [...new Set([plug.label, ...row.aliases].map(cleanLabel).map(foldDeviceName))];
    if (aliases.some(name => name.length < 4 || names.has(name))) continue;
    ids.add(row.id);
    aliases.forEach(name => names.add(name));
    mappings.push({ ...plug, id: row.id, aliases });
  }
  return mappings;
}

function configuration(env = process.env) {
  if (!env.AGENTX_INSTANCE_ROOT) return null;
  try {
    const root = env.AGENTX_INSTANCE_ROOT;
    const { baseUrl, plug, additionalPlugs } = JSON.parse(fs.readFileSync(path.join(root, 'config/home-assistant.json'), 'utf8'));
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
        || base.pathname !== '/' || base.search || base.hash) return null;
    const primary = mapping(plug);
    if (!primary) return null;
    primary.aliases = [primary.label, ...(Array.isArray(plug.aliases) ? plug.aliases.slice(0, 10) : [])]
      .map(cleanLabel).map(foldDeviceName).filter(name => name.length >= 4);
    return { origin: base.origin, ...primary, additionalPlugs: additionalMappings(additionalPlugs, primary),
      tokenFile: path.join(root, 'credentials/home-assistant-nestor.token') };
  } catch {
    return null;
  }
}

function selectPlug(config, id) {
  if (id === undefined) return config;
  const plug = typeof id === 'string' && config?.additionalPlugs?.find(row => row.id === id);
  return plug ? { origin: config.origin, tokenFile: config.tokenFile, ...plug } : null;
}

function reportedAt(state) {
  const epoch = Date.parse(state?.last_reported ?? state?.last_updated);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function meterReading(state, unit, valueKey) {
  const time = reportedAt(state);
  const value = typeof state?.state === 'string' && DECIMAL.test(state.state) ? Number(state.state) : NaN;
  return time && state.attributes?.unit_of_measurement === unit && Number.isFinite(value)
    ? { [valueKey]: value, reportedAt: time } : null;
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

async function readPlug({ device, config = configuration(), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  config = selectPlug(config, device);
  const base = { source: 'home-assistant', label: config?.label ?? null, state: null, power: null,
    ...(config?.energyEntity && { energy: null }) };
  const result = (status, fields) => ({ ...base, ...fields, status, checkedAt: new Date(now()).toISOString() });
  if (!config) return result('not_configured');
  let token;
  try {
    token = (await fs.promises.readFile(config.tokenFile, 'utf8')).trim();
  } catch {
    return result('credentials_unavailable');
  }
  if (!token || /\s/.test(token)) return result('credentials_unavailable');

  const [outlet, meter, cumulative] = await Promise.all([
    getState(fetchImpl, config, token, config.switchEntity),
    getState(fetchImpl, config, token, config.powerEntity),
    ...(config.energyEntity ? [getState(fetchImpl, config, token, config.energyEntity)] : [])
  ]);
  const switchAt = reportedAt(outlet);
  const state = switchAt && ['on', 'off'].includes(outlet.state) ? { value: outlet.state, reportedAt: switchAt } : null;
  const power = meterReading(meter, 'W', 'watts');
  const energy = meterReading(cumulative, 'kWh', 'kilowattHours');
  const complete = state && power && (!config.energyEntity || energy);
  return result(complete ? 'available' : state || power || energy ? 'partial' : 'unavailable',
    { state, power, ...(config.energyEntity && { energy }) });
}

module.exports = { configuration, readPlug, selectPlug, foldDeviceName };
