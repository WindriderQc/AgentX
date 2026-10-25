'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildSshArgs } = require('../../integrations/runtime-bridges/openclaw/agentInventory');
const execFileAsync = promisify(execFile);
const JOB_ID = /^[a-z][a-z0-9-]{0,63}$/;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RUN_STATES = new Set(['accepted', 'running', 'completed', 'failed', 'cancelled', 'unknown', 'waiting-host']);
const METRICS = ['files', 'bytes', 'unchanged', 'sourceFiles', 'accepted', 'sessions', 'filesScanned', 'verified', 'noModelCall'];

class OperationsError extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}
const text = (value, length = 200) => typeof value === 'string' ? value.slice(0, length) : '';
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
function identifier(value) {
  if (!JOB_ID.test(value || '')) throw new OperationsError('INVALID_JOB', 'Invalid job identifier.', 400);
  return value;
}
function requestIdentity(value) {
  if (!REQUEST_ID.test(value || '')) throw new OperationsError('INVALID_REQUEST', 'An exact request identity is required.', 400);
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new OperationsError('INVALID_REVISION', 'Refresh the current configuration.', 400);
  return value;
}
function projectRun(row) {
  if (!row || !REQUEST_ID.test(row.requestId || '') || !JOB_ID.test(row.jobId || '')) return null;
  const metrics = {};
  for (const key of METRICS) if (typeof row.metrics?.[key] === 'boolean' || (Number.isFinite(row.metrics?.[key]) && row.metrics[key] >= 0)) metrics[key] = row.metrics[key];
  const startedAt = date(row.startedAt);
  const finishedAt = date(row.finishedAt);
  return { requestId: row.requestId, jobId: row.jobId, state: RUN_STATES.has(row.state) ? row.state : 'unknown',
    trigger: row.trigger === 'scheduled' ? 'scheduled' : 'manual', createdAt: date(row.createdAt), startedAt, finishedAt,
    dueAt: date(row.dueAt), nextAttemptAt: date(row.nextAttemptAt), sourceAt: date(row.sourceAt),
    durationMs: startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
    code: /^[A-Z0-9_]{1,80}$/.test(row.code || '') ? row.code : null,
    exitCode: Number.isInteger(row.exitCode) ? row.exitCode : null, metrics };
}
function projectJob(row) {
  if (!JOB_ID.test(row.id || '')) throw new OperationsError('INVALID_NATIVE_SNAPSHOT', 'The job inventory is incomplete.');
  const cadence = row.schedule || {};
  const source = row.source || {};
  return { id: row.id, name: text(row.name, 120), description: text(row.description, 500), kind: text(row.kind, 40),
    enabled: row.enabled === true, state: text(row.state, 40), hostLabel: text(row.hostLabel, 100), supervisorLabel: text(row.supervisorLabel, 100),
    schedule: { type: cadence.type === 'daily' ? 'daily' : 'interval', minutes: Number(cadence.minutes) || null,
      at: /^\d{2}:\d{2}$/.test(cadence.at || '') ? cadence.at : null, timezone: text(cadence.timezone, 80) || 'UTC' },
    nextRunAt: date(row.nextRunAt), lastSuccessAt: date(row.lastSuccessAt), lastRun: projectRun(row.lastRun),
    failureCount: Number(row.failureCount) || 0, gateType: ['core-backup', 'file', 'snapshot'].includes(row.gateType) ? row.gateType : null,
    source: { ready: source.ready === true, label: text(source.label, 120), code: text(source.code, 80), sourceAt: date(source.sourceAt), cached: source.cached === true },
    legacyTask: text(row.legacyTask, 180) };
}
function projectSnapshot(body) {
  if (body?.contract !== 'agentx.operations/v1' || !Array.isArray(body.jobs) || body.jobs.length > 100) {
    throw new OperationsError('INVALID_NATIVE_SNAPSHOT', 'The supervisor response is incomplete.');
  }
  const inventory = body.inventory || {};
  const rows = Array.isArray(inventory.rows) ? inventory.rows.slice(0, 2000).map(row => ({
    name: text(row.name, 240), folder: text(row.folder, 240), enabled: row.enabled === true, state: text(row.state, 30),
    lastResult: Number.isInteger(row.lastResult) ? row.lastResult : null, lastRunAt: text(row.lastRunAt, 60), nextRunAt: text(row.nextRunAt, 60),
    executablePresent: row.executablePresent !== false, category: text(row.category, 30), assessment: text(row.assessment, 60),
    jobId: JOB_ID.test(row.jobId || '') ? row.jobId : null, hostLabel: text(row.hostLabel, 100),
    triggers: Array.isArray(row.triggers) ? row.triggers.slice(0, 10).map(trigger => ({type: text(trigger.type, 50), interval: text(trigger.interval, 40), start: text(trigger.start, 60)})) : []
  })) : [];
  return { contract: body.contract, available: true, revision: revision(body.revision), observedAt: date(body.observedAt),
    supervisor: { label: text(body.supervisor?.label, 100), lastTickAt: date(body.supervisor?.lastTickAt), pollSeconds: Number(body.supervisor?.pollSeconds) || 60 },
    jobs: body.jobs.map(projectJob), history: (body.history || []).slice(0, 100).map(projectRun).filter(Boolean), historyTotal: Number(body.historyTotal) || 0,
    inventory: { observedAt: date(inventory.observedAt), lastAttemptAt: date(inventory.lastAttemptAt), unavailable: (inventory.unavailable || []).map(value => text(value, 100)), rows },
    legacy: (body.legacy || []).slice(0, 100).map(row => ({name: text(row.name, 180), assessment: text(row.assessment, 80)})) };
}
async function defaultRunner(target, command) {
  try {
    return await execFileAsync('ssh', buildSshArgs(target, command, {sshStrictHostKeyChecking: 'yes'}), {
      timeout: 25_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true
    });
  } catch (error) {
    if (error.stdout) return {stdout: error.stdout};
    throw error;
  }
}
async function mirrorSnapshot(snapshot) {
  const cluster = require('./clusterScheduleService');
  const entries = snapshot.jobs.map(job => ({ source: 'agentx-system', sourceId: `operations-${job.id}`, name: job.name,
    taskType: ['offhost-backup', 'archive-mirror', 'session-archive'].includes(job.kind) ? 'backup' : 'sync', host: null, model: null, agent: null,
    schedule: job.schedule.type === 'daily'
      ? {type: 'cron', cron: `${Number(job.schedule.at.slice(3))} ${Number(job.schedule.at.slice(0, 2))} * * *`, timezone: job.schedule.timezone}
      : {type: 'interval', intervalMs: job.schedule.minutes * 60_000, timezone: job.schedule.timezone},
    enabled: job.enabled, lastRun: job.lastRun?.startedAt || null,
    estimatedDurationMs: job.lastRun?.durationMs || null, vramMb: 0,
    metadata: {scheduler: 'agentx-operations', sourceAuthority: 'native-operations-supervisor', controlUrl: '/operations-jobs',
      executionHost: job.hostLabel, state: job.state, gateType: job.gateType, requiresGpu: false,
      nextRunAtMs: job.nextRunAt ? Date.parse(job.nextRunAt) : null} }));
  await cluster.syncEntries(entries);
}
function createOperationsService(options = {}) {
  const env = options.env || process.env;
  const target = env.AGENTX_OPERATIONS_SSH_TARGET || '';
  const root = env.AGENTX_OPERATIONS_ROOT || '/var/lib/agentx/operations';
  const control = env.AGENTX_OPERATIONS_CONTROL || '/usr/local/lib/agentx/host_jobs_control.py';
  const runner = options.runner || defaultRunner;
  const mirror = options.mirror || mirrorSnapshot;
  let cached = null;
  let cacheAt = 0;
  let timer = null;
  if (target && (!/^[A-Za-z0-9_.@:-]+$/.test(target) || target.startsWith('-'))) throw new OperationsError('INVALID_CONFIGURATION', 'Invalid operations host.');
  for (const path of [root, control]) if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('/../')) throw new OperationsError('INVALID_CONFIGURATION', 'Invalid operations entrance.');
  async function call(action, extra = []) {
    if (!target) throw new OperationsError('NOT_CONFIGURED', 'The operations supervisor is not configured.');
    let body;
    try {
      const result = await runner(target, `python3 ${quote(control)} --root ${quote(root)} ${action}${extra.length ? ` ${extra.map(quote).join(' ')}` : ''}`);
      body = JSON.parse(typeof result === 'string' ? result : result.stdout);
    } catch {
      throw new OperationsError('NATIVE_OUTCOME_UNKNOWN', 'The native response is unavailable. Refresh the same request.');
    }
    if (body.status === 'error') throw new OperationsError(text(body.error?.code, 80) || 'NATIVE_FAILURE', text(body.error?.message, 300) || 'The native operation failed.', [400,404,409,503].includes(body.error?.status) ? body.error.status : 503);
    if (body.status !== 'success' || !body.data) throw new OperationsError('NATIVE_OUTCOME_UNKNOWN', 'The native response is incomplete.');
    return body.data;
  }
  const service = {
    async status({offset = 0, refresh = false} = {}) {
      if (!target) return {available: false, code: 'NOT_CONFIGURED', jobs: [], history: [], historyTotal: 0, inventory: {rows: []}};
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new OperationsError('INVALID_OFFSET', 'Invalid history page.', 400);
      if (!offset && !refresh && cached && Date.now() - cacheAt < 4000) return cached;
      const snapshot = projectSnapshot(await call('status', ['--offset', String(offset)]));
      try { await mirror(snapshot); } catch { snapshot.timelineProjectionUnavailable = true; }
      if (!offset) { cached = snapshot; cacheAt = Date.now(); }
      return snapshot;
    },
    async run(id, body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OperationsError('INVALID_CHANGE', 'Execution fields are required.', 400);
      if (Object.keys(body || {}).some(key => !['requestId', 'revision'].includes(key))) throw new OperationsError('INVALID_CHANGE', 'Unexpected execution fields.', 400);
      const result = projectRun(await call('run', ['--job', identifier(id), '--request', requestIdentity(body.requestId), '--revision', String(revision(body.revision))]));
      cached = null;
      if (!result) throw new OperationsError('NATIVE_OUTCOME_UNKNOWN', 'The execution receipt is incomplete.');
      return result;
    },
    async patch(id, body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['revision', 'enabled', 'schedule'].includes(key))) throw new OperationsError('INVALID_CHANGE', 'Unexpected settings fields.', 400);
      const changes = {};
      if ('enabled' in body) {
        if (typeof body.enabled !== 'boolean') throw new OperationsError('INVALID_CHANGE', 'Enabled must be a boolean.', 400);
        changes.enabled = body.enabled;
      }
      if ('schedule' in body) {
        if (!body.schedule || Object.keys(body.schedule).some(key => !['type','minutes','at','timezone'].includes(key))) throw new OperationsError('INVALID_SCHEDULE', 'Unexpected cadence fields.', 400);
        changes.schedule = body.schedule;
      }
      if (!Object.keys(changes).length) throw new OperationsError('INVALID_CHANGE', 'Choose a setting to change.', 400);
      const encoded = Buffer.from(JSON.stringify(changes)).toString('base64');
      const result = await call('patch', ['--job', identifier(id), '--revision', String(revision(body.revision)), '--changes', encoded]);
      cached = null;
      return {jobId: identifier(result.jobId), revision: revision(result.revision)};
    },
    async reconcile(requestId) {
      const result = projectRun(await call('reconcile', ['--request', requestIdentity(requestId)]));
      cached = null;
      return result;
    },
    startObserver() {
      if (!target || timer) return;
      timer = setInterval(() => service.status({refresh: true}).catch(() => {}), 60_000);
      timer.unref();
    },
    stopObserver() {if (timer) clearInterval(timer); timer = null;}
  };
  return service;
}
module.exports = {createOperationsService, OperationsError, projectSnapshot, projectRun};
