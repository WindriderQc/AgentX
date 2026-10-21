'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildSshArgs } = require('./openclaw/agentInventory');
const registry = require('./coding-executor-registry');
const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;

class CodingDispatchControlError extends Error {
  constructor(message, { code = 'CODING_DISPATCH_CONTROL_ERROR', statusCode = 409, data } = {}) {
    super(message);
    this.name = 'CodingDispatchControlError';
    this.code = code;
    this.statusCode = statusCode;
    this.data = data;
  }
}
function exactPipelineId(value) {
  const id = String(value || '').trim();
  if (!/^\d{4}$/.test(id)) throw new CodingDispatchControlError('pipelineId must be an exact four-digit task id.', { code: 'CODING_DISPATCH_INVALID_TASK', statusCode: 400 });
  return id;
}
function exactRequestId(value) {
  const id = String(value || '');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new CodingDispatchControlError('A valid request id is required.', { code: 'CODING_DISPATCH_INVALID_REQUEST', statusCode: 400 });
  return id;
}
function remoteRoot(value) {
  try { return registry.root(value); }
  catch (error) { throw new CodingDispatchControlError(error.message, { code: error.code, statusCode: error.statusCode }); }
}
function transientUnitName() { return 'agentx-coding-dispatch-one-shot'; }
function observedAttemptCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000) throw new CodingDispatchControlError('The observed attempt count is required.', { code: 'CODING_DISPATCH_INVALID_TASK', statusCode: 400 });
  return value;
}
const reportSelection = require('../../../shared/pipelineReportSelection').normalize;
function launchCommand(input) {
  const { pipelineId, requestId, expectedAttemptCount, root, autonomous } = input;
  const report = reportSelection(input);
  const action = report.reportName ? 'launch-report' : autonomous === true ? 'launch-autonomous' : 'launch';
  return `/usr/bin/python3 ${remoteRoot(root)}/integrations/coding/coding_dispatch_control.py ${action} ${exactPipelineId(pipelineId)} ${exactRequestId(requestId)} ${observedAttemptCount(expectedAttemptCount)}`
    + (report.reportName ? ` ${report.reportName} --model-call-limit ${report.modelCallLimit}` : '')
    + (report.parentRequestId ? ` --parent-request-id ${report.parentRequestId}` : '')
    + (report.parentSha256 ? ` --parent-sha256 ${report.parentSha256}` : '');
}
async function defaultSshRunner(target, command, options = {}) {
  return execFileAsync(options.sshBin || process.env.OPENCLAW_INVENTORY_SSH_BIN || 'ssh', buildSshArgs(target, command, options), {
    timeout: Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true
  });
}
class CodingDispatchControl {
  constructor(options = {}) {
    const legacy = options.sshTarget ? [{ id: 'default', harness: 'dsh', sshTarget: options.sshTarget,
      remoteRoot: options.remoteRoot || registry.DEFAULT_ROOT }] : null;
    this.requireHarnessIdentity = Boolean(options.executors || (!legacy && process.env.CODING_EXECUTORS_JSON));
    try { this.executors = options.executors ? registry.normalizeAll(options.executors)
      : legacy ? registry.normalizeAll(legacy) : registry.fromEnvironment(); }
    catch (error) { throw new CodingDispatchControlError(error.message, { code: error.code, statusCode: error.statusCode }); }
    this.executors.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    this.target = this.executors[0]?.sshTarget || '';
    this.root = this.executors[0]?.remoteRoot || registry.DEFAULT_ROOT;
    this.runner = options.sshRunner || defaultSshRunner;
    this.sshOptions = options.sshOptions || {};
    this.launching = new Map();
    this.inferenceStatus = options.inferenceStatus || (() => null);
  }
  configured() { return this.executors.some(item => item.enabled); }
  executor(id) {
    const executor = this.executors.find(item => item.enabled && item.id === id);
    if (!executor) throw new CodingDispatchControlError('The selected coding executor is unavailable.', { code: 'CODING_EXECUTOR_UNAVAILABLE', statusCode: 503 });
    return executor;
  }
  async call(executor, command, options = {}) {
    let payload;
    try {
      const result = await this.runner(executor.sshTarget, command, { ...this.sshOptions, ...options });
      payload = JSON.parse(typeof result === 'string' ? result : result.stdout);
    } catch {
      throw new CodingDispatchControlError('The host response is unavailable. Refresh the same request; acceptance may already have occurred.', { code: 'CODING_DISPATCH_OUTCOME_UNKNOWN', statusCode: 503 });
    }
    if (payload.status === 'error') throw new CodingDispatchControlError(payload.message, { code: payload.code, statusCode: payload.statusCode, data: payload.data });
    if (payload.status !== 'success' || !payload.data) throw new CodingDispatchControlError('The host response was incomplete. Refresh the same request.', { code: 'CODING_DISPATCH_OUTCOME_UNKNOWN', statusCode: 503 });
    return payload.data;
  }
  command(executor, action) {
    return `/usr/bin/python3 ${executor.remoteRoot}/integrations/coding/coding_dispatch_control.py ${action}`;
  }
  decorate(data, executor) {
    const identity = registry.publicExecutor(executor);
    return { ...data, executor: identity,
      ...(data.run && { run: { ...data.run, executorId: executor.id, harness: executor.harness } }),
      candidates: (data.candidates || []).map(row => ({ ...row, executorId: executor.id, harness: executor.harness })) };
  }
  async statusOn(executor, requestId = '') {
    const data = await this.call(executor, this.command(executor, `status${requestId ? ` ${requestId}` : ''}`));
    if ((data.harness && data.harness !== executor.harness) || (this.requireHarnessIdentity && !data.harness))
      throw new CodingDispatchControlError('The coding executor harness differs from its registry entry.', {
        code: 'CODING_EXECUTOR_HARNESS_MISMATCH', statusCode: 503 });
    return this.decorate(data, executor);
  }
  async allStatuses(requestId = '') {
    const enabled = this.executors.filter(item => item.enabled);
    const settled = await Promise.allSettled(enabled.map(item => this.statusOn(item, requestId)));
    return { answered: settled.filter(row => row.status === 'fulfilled').map(row => row.value),
      failed: settled.flatMap((row, index) => row.status === 'rejected' ? [registry.publicExecutor(enabled[index])] : []) };
  }
  async status(input = {}) {
    const requestId = input.requestId ? exactRequestId(input.requestId) : '';
    if (!this.configured()) return { contractVersion: 2, available: false, candidates: [], excluded: [], busy: false, executors: [] };
    if (input.executorId) return this.statusOn(this.executor(input.executorId), requestId);
    const { answered, failed } = await this.allStatuses(requestId);
    if (!answered.length) throw new CodingDispatchControlError('No coding executor answered.', { code: 'CODING_DISPATCH_OUTCOME_UNKNOWN', statusCode: 503 });
    const received = requestId ? answered.filter(row => row.run && row.run.phase !== 'not_received') : [];
    if (received.length > 1) throw new CodingDispatchControlError('More than one executor has a receipt for this request.', { code: 'CODING_DISPATCH_REQUEST_CONFLICT' });
    if (requestId && !received.length && failed.length) throw new CodingDispatchControlError('Not every executor answered; the request outcome is unknown.', { code: 'CODING_DISPATCH_OUTCOME_UNKNOWN', statusCode: 503 });
    const selected = received[0];
    const candidates = answered.filter(row => row.available && !row.busy).flatMap(row => row.candidates || []);
    const status = selected || { contractVersion: 2, available: answered.some(row => row.available),
      busy: answered.filter(row => row.available).every(row => row.busy), candidates,
      excluded: answered.flatMap(row => row.excluded || []),
      ...(requestId && { run: { requestId, phase: 'not_received', canCancel: true } }) };
    const active = this.inferenceStatus();
    return { ...status, contractVersion: 2, candidates: selected ? selected.candidates : candidates,
      executors: answered.map(row => ({ ...row.executor, available: row.available, busy: row.busy,
        observedAt: row.observedAt })), unavailableExecutors: failed,
      ...(active && { inference: { pipelineId: active.pipelineId, attempt: active.attempt, requestCount: active.requestCount, ...active.inference } }) };
  }
  async owner(input, profile = null) {
    if (input.executorId) {
      const selected = this.executor(input.executorId);
      if (profile && !selected.profiles.includes(profile)) throw new CodingDispatchControlError('The selected executor does not support this work profile.', { code: 'CODING_EXECUTOR_PROFILE_UNAVAILABLE' });
      return selected;
    }
    const compatible = this.executors.filter(item => item.enabled && (!profile || item.profiles.includes(profile)));
    if (compatible.length === 1) return compatible[0];
    if (input.requestId) {
      const observed = await this.status({ requestId: input.requestId });
      if (observed.run?.phase !== 'not_received' && observed.run?.executorId) return this.executor(observed.run.executorId);
    }
    const { answered } = await this.allStatuses();
    const available = answered.filter(row => row.available && !row.busy && (!profile || row.executor.profiles.includes(profile)));
    if (!available.length) throw new CodingDispatchControlError('No compatible coding executor is available.', { code: 'CODING_DISPATCH_BUSY' });
    return this.executor(available[0].executor.id);
  }
  async select(input = {}) {
    const profile = input.profile || 'code';
    const { answered } = await this.allStatuses();
    const row = answered.find(status => status.available && !status.busy && status.executor.profiles.includes(profile));
    if (!row) throw new CodingDispatchControlError('No compatible coding executor is available.', { code: 'CODING_DISPATCH_BUSY' });
    return row.executor;
  }
  async launch(input = {}) {
    const pipelineId = exactPipelineId(input.pipelineId);
    const requestId = exactRequestId(input.requestId);
    const expectedAttemptCount = observedAttemptCount(input.expectedAttemptCount);
    if (input.confirm !== true) throw new CodingDispatchControlError('Explicit confirmation is required for a one-shot launch.', { code: 'CODING_DISPATCH_CONFIRMATION_REQUIRED', statusCode: 400 });
    const report = reportSelection(input);
    const executor = await this.owner(input, report.reportName ? 'report' : input.autonomous === true ? 'autonomous' : 'code');
    const pending = this.launching.get(requestId);
    if (pending) {
      if (pending.executorId !== executor.id || pending.pipelineId !== pipelineId || pending.expectedAttemptCount !== expectedAttemptCount || pending.autonomous !== (input.autonomous === true) || pending.reportName !== report.reportName || pending.modelCallLimit !== report.modelCallLimit || pending.parentRequestId !== report.parentRequestId || pending.parentSha256 !== report.parentSha256) throw new CodingDispatchControlError('This request id belongs to a different selection.', { code: 'CODING_DISPATCH_REQUEST_CONFLICT' });
      return pending.promise;
    }
    const promise = this.call(executor, launchCommand({ pipelineId, requestId, expectedAttemptCount, root: executor.remoteRoot, autonomous: input.autonomous, ...report }))
      .then(data => this.decorate(data, executor));
    this.launching.set(requestId, { executorId: executor.id, pipelineId, expectedAttemptCount, autonomous: input.autonomous === true, ...report, promise });
    try { return await promise; } finally { this.launching.delete(requestId); }
  }
  async cancel(input = {}) {
    const executor = await this.owner(input);
    return this.call(executor, this.command(executor, `cancel-waiting ${exactPipelineId(input.pipelineId)} ${exactRequestId(input.requestId)}`));
  }
  async observe(input = {}) {
    const executor = await this.owner(input);
    return this.call(executor, this.command(executor, `observe ${exactPipelineId(input.pipelineId)} ${exactRequestId(input.requestId)}`));
  }
  async reconcile(input = {}) {
    const executor = await this.owner(input);
    return this.call(executor, this.command(executor, `reconcile ${exactPipelineId(input.pipelineId)} ${exactRequestId(input.requestId)}`));
  }
  async checkpoint(input = {}) {
    if (typeof input.path !== 'string' || input.path.length > 300 || !/^\.review-work\/[A-Za-z0-9_./-]+\.md$/.test(input.path)
      || input.path.split('/').includes('..')) throw new CodingDispatchControlError('Choose the exact private review artifact.', { statusCode: 400 });
    const executor = await this.owner(input);
    return this.call(executor, this.command(executor, `read-checkpoint ${exactPipelineId(input.pipelineId)} ${exactRequestId(input.requestId)} ${input.path}`));
  }
  async stop(input = {}) {
    const pipelineId = exactPipelineId(input.pipelineId);
    const requestId = exactRequestId(input.requestId);
    if (input.confirm !== true) throw new CodingDispatchControlError('Explicit confirmation is required to stop this worker.', { code: 'CODING_DISPATCH_CONFIRMATION_REQUIRED', statusCode: 400 });
    const executor = await this.owner(input);
    return this.call(executor, this.command(executor, `stop ${pipelineId} ${requestId}`));
  }
}
function sendError(res, error, logger) {
  const statusCode = Number(error?.statusCode) || 500;
  const code = error?.code || 'CODING_DISPATCH_CONTROL_ERROR';
  if (statusCode >= 500) logger?.warn?.('Coding dispatcher one-shot control failed', { code });
  const message = String(error?.message || 'Coding dispatcher launch failed.');
  return res.status(statusCode).json({ status: 'error', message, error: { code, message }, ...(error?.data ? { data: error.data } : {}) });
}
function registerCodingDispatchControlRoutes({ express, control, preparation, logger }) {
  const router = express.Router();
  router.post('/prepare', async (req, res) => {
    try {
      if (!preparation) throw new CodingDispatchControlError('Task preparation is unavailable.', { statusCode: 503 });
      return res.json({ status: 'success', data: await preparation.prepare(req.body || {}) });
    } catch (error) { return sendError(res, error, logger); }
  });
  router.get('/status', async (req, res) => {
    try { return res.json({ status: 'success', data: await control.status(req.query || {}) }); }
    catch (error) { return sendError(res, error, logger); }
  });
  router.post('/runs', async (req, res) => {
    try { return res.status(202).json({ status: 'success', data: await control.launch(req.body || {}) }); }
    catch (error) { return sendError(res, error, logger); }
  });
  router.post('/runs/:requestId/cancel', async (req, res) => {
    try { return res.json({ status: 'success', data: await control.cancel({ ...req.body, requestId: req.params.requestId }) }); }
    catch (error) { return sendError(res, error, logger); }
  });
  router.post('/runs/:requestId/reconcile', async (req, res) => {
    try {
      if (req.body?.confirm !== true) throw new CodingDispatchControlError('Explicit confirmation is required to reconcile this report.', { code: 'CODING_DISPATCH_CONFIRMATION_REQUIRED', statusCode: 400 });
      return res.json({ status: 'success', data: await control.reconcile({ ...req.body, requestId: req.params.requestId }) });
    }
    catch (error) { return sendError(res, error, logger); }
  });
  router.post('/runs/:requestId/stop', async (req, res) => {
    try { return res.status(202).json({ status: 'success', data: await control.stop({ ...req.body, requestId: req.params.requestId }) }); }
    catch (error) { return sendError(res, error, logger); }
  });
  return router;
}
module.exports = { CodingDispatchControl, CodingDispatchControlError, exactPipelineId, exactRequestId, launchCommand, registerCodingDispatchControlRoutes, remoteRoot, transientUnitName };
