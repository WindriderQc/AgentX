'use strict';

// Native observations use the installed Operations SSH authority, without
// calling the scheduler or executing a job. Data remains the network owner.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildSshArgs } = require('../../integrations/runtime-bridges/openclaw/agentInventory');
const exec = promisify(execFile);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATES = new Set(['online', 'offline', 'degraded', 'unknown']);
const SOURCES = Object.freeze({ docker: 'native_process', systemd: 'native_process', http: 'http_interface', network: 'network_presence' });
const validPath = value => typeof value === 'string' && value.length <= 240
  && /^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function definitions(env) {
  const raw = fs.readFileSync(path.join(env.AGENTX_INSTANCE_ROOT, 'config/ecosystem-observers.json'));
  if (raw.length > 32768) throw new Error('Invalid observers');
  const data = JSON.parse(raw);
  if (data.version !== 1 || !Array.isArray(data.checks) || data.checks.length > 64) throw new Error('Invalid observers');
  const ids = new Set();
  for (const row of data.checks) {
    if (!ID.test(row.id || '') || ids.has(row.id) || (!SOURCES[row.kind] && row.kind !== 'prometheus')
      || row.kind === 'prometheus' && !['host_collector', 'monitoring_collector', 'storage_health'].includes(row.source)
      || row.kind === 'network' && !/^[a-f0-9]{24}$/.test(row.deviceId || '')) throw new Error('Invalid observers');
    ids.add(row.id);
  }
  return { revision: createHash('sha256').update(raw).digest('hex'), checks: data.checks };
}
async function defaultRunner(target, command) {
  return exec('ssh', buildSshArgs(target, command, { sshStrictHostKeyChecking: 'yes' }),
    { timeout: 6500, killSignal: 'SIGKILL', maxBuffer: 32768, windowsHide: true });
}
function nativeRows(body, config) {
  if (body?.contract !== 'agentx.ecosystem-observations/v1' || body.configurationRevision !== config.revision
    || !Array.isArray(body.observations) || body.observations.length > 64) return [];
  const rows = [], seen = new Set();
  for (const row of body.observations) {
    const definition = config.checks.find(check => check.id === row.id && check.kind !== 'network');
    if (!definition || seen.has(row.id) || row.source !== (SOURCES[definition.kind] || definition.source)
      || !STATES.has(row.state) || row.observedAt !== null && !iso(row.observedAt)) return [];
    seen.add(row.id);
    rows.push({ id: row.id, source: row.source, state: row.state, observedAt: row.observedAt });
  }
  return rows;
}
async function networkRows(config, fetchData, now) {
  const checks = config.checks.filter(c => c.kind === 'network');
  if (!checks.length) return [];
  const get = async route => {
    const { response, body } = await fetchData(route, { timeoutMs: 2000 });
    if (!response.ok) throw new Error('Data unavailable');
    return body?.data;
  };
  const [devices, agents] = await Promise.all([get('/api/v1/network/devices'), get('/api/v1/network/agents')]);
  const ttl = Math.min(1800000, Math.max(1, Number(devices?.summary?.onlineTtlMs) || 1800000));
  const scan = Math.max(0, ...(agents?.scanners || []).map(c => Date.parse(c.lastScanAt)).filter(Number.isFinite));
  return checks.map(check => {
    const device = devices?.devices?.find(row => row._id === check.deviceId);
    const seen = Date.parse(device?.observation?.lastSeenAt);
    const online = device?.observation?.state === 'online' && seen <= now && now - seen < ttl;
    // Absence is a network observation, never proof of machine shutdown.
    const absent = device && !online && Number.isFinite(seen) && seen <= now
      && ['recent', 'historical', 'offline'].includes(device.observation?.state) && scan <= now && now - scan < ttl;
    return { id: check.id, source: 'network_presence', state: online ? 'online' : absent ? 'offline' : 'unknown',
      observedAt: online ? new Date(seen).toISOString() : absent ? new Date(scan).toISOString() : null, ttlMs: ttl };
  });
}
function createObservationReader({ env = process.env, runner = defaultRunner, fetchData, load = () => definitions(env), now = Date.now } = {}) {
  let cached, pending;
  return async function read(settings) {
    let config;
    try { config = load(); } catch { return []; }
    const key = JSON.stringify([config.revision, settings.observer, env.AGENTX_OPERATIONS_SSH_TARGET]);
    if (cached?.key === key && cached.until > now()) return cached.rows;
    if (pending?.key === key) return pending.promise;
    const promise = (async () => {
      const readNative = async () => {
        const target = env.AGENTX_OPERATIONS_SSH_TARGET, observer = settings.observer;
        if (!target || !validPath(observer?.script) || !validPath(observer?.config)) return [];
        const command = `python3 '${observer.script}' --config '${observer.config}' --revision '${config.revision}'`;
        const { stdout } = await runner(target, command);
        return nativeRows(JSON.parse(stdout), config);
      };
      const results = await Promise.allSettled([readNative(), networkRows(config, fetchData || require('./dataServiceClient').fetchData, now())]);
      const observed = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      const rows = config.checks.map(check => observed.find(row => row.id === check.id) || {
        id: check.id, source: SOURCES[check.kind] || check.source, state: 'unknown', observedAt: null });
      cached = { key, rows, until: now() + 25000 };
      return rows;
    })();
    pending = { key, promise };
    try { return await promise; } finally { if (pending?.promise === promise) pending = null; }
  };
}
module.exports = { validPath, definitions, nativeRows, networkRows, createObservationReader };
