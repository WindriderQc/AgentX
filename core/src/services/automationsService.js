'use strict';

const { collectOpenClawCronEvidence } = require('../../integrations/runtime-bridges/openclaw/runtimeEvidence');
const { getAllEntries } = require('./clusterScheduleService');

const iso = value => {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const text = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
const id = value => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value || '');
function runState(status) {
  if (['ok', 'success', 'completed'].includes(status)) return 'completed';
  if (['error', 'failed', 'partial'].includes(status)) return 'failed';
  if (['running', 'accepted', 'skipped', 'cancelled'].includes(status)) return status;
  return status ? 'unknown' : 'never';
}
function openClawJob(job) {
  const schedule = job.schedule || {};
  const kind = job.coreJob ? 'native-core' : job.payloadKind === 'command' ? 'command' : 'agent';
  const lastAt = iso(job.lastRunAtMs);
  const lastRun = lastAt ? {jobId: `openclaw:${job.id}`, state: runState(job.lastRunStatus || job.lastStatus),
    startedAt: lastAt, durationMs: Number(job.lastDurationMs) || null, metrics: {}} : null;
  return {id: `openclaw:${job.id}`, nativeId: job.id, owner: 'openclaw', ownerLabel: 'OpenClaw',
    name: text(job.name, 120), description: text(job.description), enabled: job.enabled === true,
    state: job.runningAtMs ? 'running' : !job.enabled ? 'paused' : runState(job.lastRunStatus || job.lastStatus), kind,
    agentId: text(job.agentId, 80), hostLabel: job.agentId || 'Runtime natif', supervisorLabel: 'OpenClaw',
    schedule: {type: schedule.kind === 'every' ? 'interval' : schedule.kind === 'at' ? 'once' : 'cron',
      minutes: Number(schedule.everyMs) / 60_000 || null, cron: text(schedule.expr, 100),
      at: iso(schedule.at), timezone: text(schedule.tz, 80) || null, anchorMs: Number(schedule.anchorMs) || null},
    nextRunAt: iso(job.nextRunAtMs), lastRun, lastSuccessAt: lastRun?.state === 'completed' ? lastAt : null,
    failureCount: Number(job.consecutiveErrors) || 0, gateType: null, source: {},
    controlUrl: '/api/openclaw/control-launch/cron', archived: false};
}
function backupJob(schedule) {
  const lastAt = iso(schedule.lastStartedAt || schedule.lastAttemptAt);
  return {id: 'core:backup', nativeId: 'backup', owner: 'core', ownerLabel: 'Core', name: 'Sauvegarde Core',
    description: 'Crée les sauvegardes des services. La copie hors hôte attend une sauvegarde complète réussie.',
    enabled: schedule.enabled === true, state: !schedule.enabled ? 'paused' : schedule.scheduleValid === false ? 'attention' : runState(schedule.lastStatus),
    kind: 'backup', hostLabel: 'Services AgentX', supervisorLabel: 'Core', agentId: null,
    schedule: {type: schedule.anchor === 'interval' ? 'interval' : 'cron', cron: text(schedule.cron, 100),
      timezone: text(schedule.timezone, 80) || 'UTC', minutes: Number(schedule.normalEveryMs || schedule.intervalMs) / 60_000 || null},
    nextRunAt: iso(schedule.nextRunAt), lastSuccessAt: iso(schedule.lastSuccessAt),
    lastRun: lastAt ? {jobId: 'core:backup', startedAt: lastAt, state: runState(schedule.lastStatus), metrics: {}} : null,
    gateType: null, source: {}, controlUrl: '/backup', archived: false};
}

function createAutomationsService({operations, readCron = () => collectOpenClawCronEvidence({includeDisabledCron: true}),
  readMirrors = () => getAllEntries({source: 'agentx-system'}),
  readBackup = () => require('./backupSchedulerService').getStatus(), now = () => Date.now()} = {}) {
  let cachedOperations = null, cachedOffset = null;
  let cachedCron = null, cronReadAt = 0, cronFlight = null;
  async function cron(refresh) {
    if (!refresh && cachedCron && now() - cronReadAt < 30_000) return cachedCron;
    if (!cronFlight) cronFlight = Promise.resolve().then(readCron).then(value => {
      if (!value?.cron?.available || !Array.isArray(value.cron.jobs)) throw new Error('Unavailable native inventory');
      cachedCron = value; cronReadAt = now(); return value;
    }).finally(() => {cronFlight = null;});
    return cronFlight;
  }
  async function status(options = {}) {
    const offset = options.offset || 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw Object.assign(new Error('Invalid history page.'), {status: 400});
    const results = await Promise.allSettled([operations.status(options), cron(options.refresh), readBackup(), readMirrors()]);
    if (results[0].status === 'fulfilled' && results[0].value.available) {cachedOperations = results[0].value; cachedOffset = offset;}
    const native = results[0].status === 'fulfilled' ? results[0].value
      : cachedOperations ? {...cachedOperations, history: cachedOffset === offset ? cachedOperations.history : []} : {};
    const operationsAvailable = results[0].status === 'fulfilled' && native.available === true;
    const evidence = results[1].status === 'fulfilled' ? results[1].value : cachedCron;
    const sources = [
      {id: 'operations', label: 'AgentX', available: operationsAvailable, stale: results[0].status === 'rejected', observedAt: native.observedAt || null},
      {id: 'openclaw', label: 'OpenClaw', available: results[1].status === 'fulfilled', stale: results[1].status === 'rejected' && !!cachedCron, observedAt: evidence?.generatedAt || null},
      {id: 'core', label: 'Core', available: results[2].status === 'fulfilled', stale: false, observedAt: new Date(now()).toISOString()}
    ];
    const jobs = (native.jobs || []).map(job => ({...job, owner: 'operations', ownerLabel: 'AgentX', nativeId: job.id, archived: false}));
    const seen = new Set();
    for (const job of evidence?.cron?.jobs || []) {
      if (!id(job.id) || seen.has(job.id)) continue;
      seen.add(job.id); jobs.push(openClawJob(job));
    }
    if (results[2].status === 'fulfilled') jobs.push(backupJob(results[2].value));
    for (const mirror of results[3].status === 'fulfilled' ? results[3].value : []) {
      const nativeId = mirror.metadata?.originalJobId;
      const archiveId = id(nativeId) ? nativeId : `archive:${text(mirror.sourceId, 180)}`;
      if (mirror.metadata?.scheduler !== 'openclaw' || seen.has(archiveId) || mirror.metadata?.mirrorState !== 'absent-from-openclaw') continue;
      seen.add(archiveId);
      jobs.push({id: `openclaw:${archiveId}`, nativeId: id(nativeId) ? nativeId : null, owner: 'openclaw', ownerLabel: 'OpenClaw',
        name: text(mirror.name, 120), description: 'Ancienne projection conservée pour référence. Absente du catalogue natif au dernier rapprochement.',
        enabled: false, state: 'archived', archived: true, kind: 'archive', schedule: {}, source: {}});
    }
    return {...native, available: sources.some(source => source.available), operationsAvailable,
      contract: 'agentx.automations/v1', sources, jobs, history: native.history || [], historyTotal: native.historyTotal || 0,
      inventory: {rows: [], unavailable: [], ...native.inventory}, supervisor: native.supervisor || {},
      observedAt: new Date(now()).toISOString(), archiveAvailable: results[3].status === 'fulfilled'};
  }
  return {status};
}
module.exports = {createAutomationsService, openClawJob, backupJob, runState};
