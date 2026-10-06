'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildSshArgs } = require('./openclaw/agentInventory');
const execFileAsync = promisify(execFile);
const DEFAULT_REMOTE_ROOT = '/srv/agentx/AgentX';
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
  const root = String(value || DEFAULT_REMOTE_ROOT).trim().replace(/\/$/, '');
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(root) || root.includes('/../') || root.endsWith('/..')) throw new CodingDispatchControlError('The coding dispatcher remote root is invalid.', { code: 'CODING_DISPATCH_CONFIGURATION_INVALID', statusCode: 503 });
  return root;
}
function transientUnitName() { return 'agentx-coding-dispatch-one-shot'; }
function observedAttemptCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000) throw new CodingDispatchControlError('The observed attempt count is required.', { code: 'CODING_DISPATCH_INVALID_TASK', statusCode: 400 });
  return value;
}
function launchCommand({ pipelineId, requestId, expectedAttemptCount, root }) {
  return `/usr/bin/python3 ${remoteRoot(root)}/integrations/coding/coding_dispatch_control.py launch ${exactPipelineId(pipelineId)} ${exactRequestId(requestId)} ${observedAttemptCount(expectedAttemptCount)}`;
}
async function defaultSshRunner(target, command, options = {}) {
  return execFileAsync(options.sshBin || process.env.OPENCLAW_INVENTORY_SSH_BIN || 'ssh', buildSshArgs(target, command, options), {
    timeout: Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true
  });
}
class CodingDispatchControl {
  constructor(options = {}) {
    this.target = String(options.sshTarget || process.env.CODING_DISPATCHER_SSH_TARGET || '').trim();
    this.root = remoteRoot(options.remoteRoot || process.env.CODING_DISPATCHER_REMOTE_ROOT);
    this.runner = options.sshRunner || defaultSshRunner;
    this.sshOptions = options.sshOptions || {};
    this.launching = new Map();
    this.inferenceStatus = options.inferenceStatus || (() => null);
  }
  async call(command, options = {}) {
    if (!this.target) throw new CodingDispatchControlError('The coding dispatcher target is not configured.', { code: 'CODING_DISPATCH_UNAVAILABLE', statusCode: 503 });
    let payload;
    try {
      const result = await this.runner(this.target, command, { ...this.sshOptions, ...options });
      payload = JSON.parse(typeof result === 'string' ? result : result.stdout);
    } catch {
      throw new CodingDispatchControlError('The host response is unavailable. Refresh the same request; acceptance may already have occurred.', { code: 'CODING_DISPATCH_OUTCOME_UNKNOWN', statusCode: 503 });
    }
    if (payload.status === 'error') throw new CodingDispatchControlError(payload.message, { code: payload.code, statusCode: payload.statusCode, data: payload.data });
    if (payload.status !== 'success' || !payload.data) throw new CodingDispatchControlError('The host response was incomplete. Refresh the same request.', { code: 'CODING_DISPATCH_OUTCOME_UNKNOWN', statusCode: 503 });
    return payload.data;
  }
  async status(input = {}) {
    const requestId = input.requestId ? exactRequestId(input.requestId) : '';
    if (!this.target) return { contractVersion: 2, available: false, candidates: [], excluded: [], busy: false };
    const status = await this.call(`/usr/bin/python3 ${this.root}/integrations/coding/coding_dispatch_control.py status${requestId ? ` ${requestId}` : ''}`);
    const active = this.inferenceStatus();
    return { ...status, ...(active && { inference: { pipelineId: active.pipelineId, attempt: active.attempt,
      requestCount: active.requestCount, ...active.inference } }) };
  }
  async launch(input = {}) {
    const pipelineId = exactPipelineId(input.pipelineId);
    const requestId = exactRequestId(input.requestId);
    const expectedAttemptCount = observedAttemptCount(input.expectedAttemptCount);
    if (input.confirm !== true) throw new CodingDispatchControlError('Explicit confirmation is required for a one-shot launch.', { code: 'CODING_DISPATCH_CONFIRMATION_REQUIRED', statusCode: 400 });
    if (!this.target) throw new CodingDispatchControlError('The coding dispatcher launch target is not configured.', { code: 'CODING_DISPATCH_UNAVAILABLE', statusCode: 503 });
    const pending = this.launching.get(requestId);
    if (pending) {
      if (pending.pipelineId !== pipelineId || pending.expectedAttemptCount !== expectedAttemptCount) throw new CodingDispatchControlError('This request id belongs to a different selection.', { code: 'CODING_DISPATCH_REQUEST_CONFLICT' });
      return pending.promise;
    }
    const promise = this.call(launchCommand({ pipelineId, requestId, expectedAttemptCount, root: this.root }));
    this.launching.set(requestId, { pipelineId, expectedAttemptCount, promise });
    try { return await promise; } finally { this.launching.delete(requestId); }
  }
  async cancel(input = {}) {
    return this.call(`/usr/bin/python3 ${this.root}/integrations/coding/coding_dispatch_control.py cancel-waiting ${exactRequestId(input.requestId)}`);
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
    try { return res.json({ status: 'success', data: await control.cancel(req.params) }); }
    catch (error) { return sendError(res, error, logger); }
  });
  return router;
}
module.exports = { CodingDispatchControl, CodingDispatchControlError, exactPipelineId, exactRequestId, launchCommand, registerCodingDispatchControlRoutes, remoteRoot, transientUnitName };
