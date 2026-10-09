'use strict';

const { randomUUID } = require('crypto');

const PIPELINE_MODEL_ALIAS = 'agentx-pipeline';
const PIPELINE_CONSUMER_CONTRACT = 'openclaw-pipeline-runtime-v1';
const DEFAULT_LEASE_TTL_SECONDS = 1_200;
const MAX_LEASE_TTL_SECONDS = 1_800;
const MAX_REQUESTS_PER_LEASE = 128;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
const TASK_TYPES = new Set(['daily_operator', 'code_generation', 'master_brain']);

class PipelineAttributionError extends Error {
  constructor(message, { code = 'PIPELINE_ATTRIBUTION_ERROR', statusCode = 409 } = {}) {
    super(message);
    this.name = 'PipelineAttributionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function identifier(name, value) {
  const text = String(value || '').trim();
  if (!IDENTIFIER_PATTERN.test(text)) {
    throw new PipelineAttributionError(`${name} must be a bounded opaque identifier.`, {
      code: 'PIPELINE_ATTRIBUTION_INVALID', statusCode: 400
    });
  }
  return text;
}

function attemptNumber(value) {
  const parsed = value == null ? 1 : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new PipelineAttributionError('attempt must be an integer from 1 through 10000.', {
      code: 'PIPELINE_ATTRIBUTION_INVALID', statusCode: 400
    });
  }
  return parsed;
}

function taskAttempt(task) {
  const attemptCount = task?.automationAttemptCount;
  const attempts = task?.automationAttempts;
  const leaseAttempt = task?.automationLease?.attempt;
  const lastIndex = Number.isInteger(attemptCount) ? attemptCount - 1 : -1;
  const historyIsExact = Array.isArray(attempts)
    && attempts.length === attemptCount
    && attempts.every((entry, index) => (
      Number.isInteger(entry?.attempt)
      && entry.attempt === index + 1
      && (index === lastIndex ? entry.finalState === 'active' : entry.finalState !== 'active')
    ));

  if (!Number.isInteger(attemptCount)
    || attemptCount < 1
    || attemptCount > 10_000
    || leaseAttempt !== attemptCount
    || !historyIsExact) {
    throw new PipelineAttributionError('Pipeline attempt authority is missing or internally inconsistent.', {
      code: 'PIPELINE_ATTRIBUTION_ATTEMPT_AUTHORITY_INVALID', statusCode: 409
    });
  }
  return attemptCount;
}

function ttlMilliseconds(value) {
  const parsed = Number(value == null ? DEFAULT_LEASE_TTL_SECONDS : value);
  if (!Number.isInteger(parsed) || parsed < 30 || parsed > MAX_LEASE_TTL_SECONDS) {
    throw new PipelineAttributionError(`ttlSeconds must be an integer from 30 through ${MAX_LEASE_TTL_SECONDS}.`, {
      code: 'PIPELINE_ATTRIBUTION_INVALID', statusCode: 400
    });
  }
  return parsed * 1_000;
}

function taskModel(snapshot, taskType) {
  const task = snapshot?.tasks?.[taskType] || null;
  if (!task?.model
    || task.model === PIPELINE_MODEL_ALIAS
    || task?.inferenceContract?.qualification?.qualified !== true) {
    throw new PipelineAttributionError('The requested Pipeline lane has no qualified effective model.', {
      code: 'PIPELINE_ATTRIBUTION_MODEL_UNQUALIFIED', statusCode: 409
    });
  }
  return task;
}

function publicLease(lease) {
  return {
    leaseId: lease.leaseId,
    requestId: lease.requestId,
    pipelineId: lease.pipelineId,
    assignee: lease.assignee,
    taskType: lease.taskType,
    effectiveModel: lease.effectiveModel,
    attempt: lease.attempt,
    openedAt: lease.openedAt,
    expiresAt: lease.expiresAt,
    requestCount: lease.requestCount,
    inference: lease.inference || null
  };
}

class PipelineAttributionLeaseManager {
  constructor({ taskReader, snapshotProvider, now = () => new Date(), randomId = randomUUID } = {}) {
    if (typeof taskReader !== 'function' || typeof snapshotProvider !== 'function') {
      throw new Error('Pipeline attribution requires taskReader and snapshotProvider.');
    }
    this.taskReader = taskReader;
    this.snapshotProvider = snapshotProvider;
    this.now = now;
    this.randomId = randomId;
    this.active = null;
    this.lastClosed = null;
    this.openChain = Promise.resolve();
    this.counters = { opened: 0, closed: 0, expired: 0, rejected: 0, attributedRequests: 0 };
  }

  _expire(now) {
    if (!this.active || new Date(this.active.expiresAt).getTime() > now.getTime()) return;
    this.active = null;
    this.counters.expired += 1;
  }

  async _requireTask(pipelineId, assignee) {
    let task;
    try {
      task = await this.taskReader(pipelineId);
    } catch (error) {
      throw new PipelineAttributionError('Pipeline task authority is unavailable.', {
        code: 'PIPELINE_ATTRIBUTION_TASK_AUTHORITY_UNAVAILABLE', statusCode: 503
      });
    }
    if (!task || task.status !== 'in_progress' || String(task.assignee || '') !== assignee) {
      throw new PipelineAttributionError('Pipeline task is not actively assigned to this worker.', {
        code: 'PIPELINE_ATTRIBUTION_TASK_MISMATCH', statusCode: 409
      });
    }
    if (task.automationLease?.expiresAt && new Date(task.automationLease.expiresAt) <= this.now()) {
      throw new PipelineAttributionError('The task execution deadline has expired.', { code: 'PIPELINE_EXECUTION_DEADLINE' });
    }
    return task;
  }

  async _requireModel(taskType, expectedModel = null) {
    let snapshot;
    try {
      snapshot = await this.snapshotProvider();
    } catch (error) {
      throw new PipelineAttributionError('Effective routing authority is unavailable.', {
        code: 'PIPELINE_ATTRIBUTION_ROUTING_UNAVAILABLE', statusCode: 503
      });
    }
    const task = taskModel(snapshot, taskType);
    if (expectedModel && task.model !== expectedModel) {
      throw new PipelineAttributionError('The effective Pipeline model changed during the lease.', {
        code: 'PIPELINE_ATTRIBUTION_MODEL_DRIFT', statusCode: 409
      });
    }
    return task;
  }

  async open(input = {}) {
    const operation = this.openChain.then(() => this._open(input));
    this.openChain = operation.catch(() => undefined);
    return operation;
  }

  async _open(input = {}) {
    const now = this.now();
    this._expire(now);
    const pipelineId = identifier('pipelineId', input.pipelineId);
    const assignee = identifier('assignee', input.assignee);
    const requestId = identifier('requestId', input.requestId);
    const taskType = String(input.taskType || 'code_generation').trim();
    if (!TASK_TYPES.has(taskType)) {
      throw new PipelineAttributionError('taskType is not an approved AgentX routing lane.', {
        code: 'PIPELINE_ATTRIBUTION_INVALID', statusCode: 400
      });
    }
    const requestedAttempt = input.attempt == null ? null : attemptNumber(input.attempt);
    const leaseTtlMs = ttlMilliseconds(input.ttlSeconds);

    const pipelineTask = await this._requireTask(pipelineId, assignee);
    const attempt = taskAttempt(pipelineTask);
    if (requestedAttempt != null && requestedAttempt !== attempt) {
      throw new PipelineAttributionError('attempt does not match the authoritative Pipeline history.', {
        code: 'PIPELINE_ATTRIBUTION_ATTEMPT_MISMATCH', statusCode: 409
      });
    }

    if (this.active) {
      if (this.active.requestId === requestId
        && this.active.pipelineId === pipelineId
        && this.active.assignee === assignee
        && this.active.taskType === taskType
        && this.active.attempt === attempt) {
        return { lease: publicLease(this.active), idempotent: true };
      }
      this.counters.rejected += 1;
      throw new PipelineAttributionError('Another Pipeline attribution lease is active.', {
        code: 'PIPELINE_ATTRIBUTION_BUSY', statusCode: 409
      });
    }

    const effective = await this._requireModel(taskType);
    if (pipelineTask.codingCapacity) require('../../src/services/pipelineCodingCapacity').assertIdentity(pipelineTask.codingCapacity, effective);
    const openedAt = now.toISOString();
    this.active = {
      leaseId: this.randomId(),
      requestId,
      pipelineId,
      assignee,
      taskType,
      effectiveModel: effective.model,
      ...(pipelineTask.codingCapacity && { codingCapacity: { pipelineId, leaseId: pipelineTask.automationLease.leaseId },
        hostUrl: pipelineTask.codingCapacity.host, numCtx: pipelineTask.codingCapacity.numCtx }),
      attempt,
      openedAt,
      expiresAt: new Date(now.getTime() + leaseTtlMs).toISOString(),
      deadlineAt: pipelineTask.automationLease?.expiresAt || new Date(now.getTime() + leaseTtlMs).toISOString(),
      requestCount: 0,
      lastUsedAt: null
    };
    this.counters.opened += 1;
    return { lease: publicLease(this.active), idempotent: false };
  }

  async authorizeAlias(model) {
    if (String(model || '').trim() !== PIPELINE_MODEL_ALIAS) return null;
    const now = this.now();
    this._expire(now);
    const lease = this.active;
    if (!lease) {
      this.counters.rejected += 1;
      throw new PipelineAttributionError('No active Pipeline attribution lease exists.', {
        code: 'PIPELINE_ATTRIBUTION_LEASE_REQUIRED', statusCode: 409
      });
    }
    if (lease.requestCount >= MAX_REQUESTS_PER_LEASE) {
      this.active = null;
      this.counters.rejected += 1;
      throw new PipelineAttributionError('Pipeline attribution lease request budget is exhausted.', {
        code: 'PIPELINE_ATTRIBUTION_REQUEST_LIMIT', statusCode: 409
      });
    }
    try {
      const task = await this._requireTask(lease.pipelineId, lease.assignee);
      const target = await this._requireModel(lease.taskType, lease.effectiveModel);
      if (task.codingCapacity) require('../../src/services/pipelineCodingCapacity').assertIdentity(task.codingCapacity, target);
    } catch (error) {
      if (this.active === lease) this.active = null;
      this.counters.rejected += 1;
      throw error;
    }
    const authorizedAt = this.now();
    this._expire(authorizedAt);
    if (this.active !== lease) {
      this.counters.rejected += 1;
      throw new PipelineAttributionError('Pipeline attribution lease closed during validation.', {
        code: 'PIPELINE_ATTRIBUTION_LEASE_REQUIRED', statusCode: 409
      });
    }
    if (lease.requestCount >= MAX_REQUESTS_PER_LEASE) {
      this.active = null;
      this.counters.rejected += 1;
      throw new PipelineAttributionError('Pipeline attribution lease request budget is exhausted.', {
        code: 'PIPELINE_ATTRIBUTION_REQUEST_LIMIT', statusCode: 409
      });
    }
    lease.requestCount += 1;
    lease.lastUsedAt = authorizedAt.toISOString();
    this.counters.attributedRequests += 1;
    return {
      effectiveModel: lease.effectiveModel,
      ...(lease.codingCapacity && { codingCapacity: lease.codingCapacity, hostUrl: lease.hostUrl, numCtx: lease.numCtx }),
      consumerContract: PIPELINE_CONSUMER_CONTRACT,
      attribution: {
        workItemId: lease.pipelineId,
        correlationId: lease.leaseId,
        runtime: 'external',
        attempt: lease.attempt
      }
    };
  }

  async revalidate(leaseId) {
    this._expire(this.now());
    const lease = this.active;
    if (!lease || lease.leaseId !== leaseId) throw new PipelineAttributionError(
      'Inference recovery requires the original active session; no task or tool replay was made.',
      { code: 'PIPELINE_ATTRIBUTION_LEASE_REQUIRED' });
    const task = await this._requireTask(lease.pipelineId, lease.assignee);
    if (taskAttempt(task) !== lease.attempt) throw new PipelineAttributionError(
      'The task attempt changed during inference.', { code: 'PIPELINE_ATTRIBUTION_ATTEMPT_MISMATCH' });
    const target = await this._requireModel(lease.taskType, lease.effectiveModel);
    if (task.codingCapacity) require('../../src/services/pipelineCodingCapacity').assertIdentity(task.codingCapacity, target);
    if (this.active !== lease || new Date(lease.deadlineAt) <= this.now()) throw new PipelineAttributionError(
      'The execution deadline or session ended during inference.', { code: 'PIPELINE_EXECUTION_DEADLINE' });
    return Math.max(0, new Date(lease.deadlineAt).getTime() - this.now().getTime());
  }

  progress(leaseId, progress) {
    if (!this.active || this.active.leaseId !== leaseId) return;
    this.active.inference = { ...progress, updatedAt: this.now().toISOString() };
  }

  close(input = {}) {
    const leaseId = identifier('leaseId', input.leaseId);
    const requestId = identifier('requestId', input.requestId);
    if (!this.active) {
      if (this.lastClosed?.leaseId === leaseId && this.lastClosed?.requestId === requestId) {
        return { closed: true, idempotent: true, requestCount: this.lastClosed.requestCount,
          ...(this.lastClosed.inference && { inference: this.lastClosed.inference }) };
      }
      throw new PipelineAttributionError('Pipeline attribution lease is not active.', {
        code: 'PIPELINE_ATTRIBUTION_LEASE_MISMATCH', statusCode: 409
      });
    }
    if (this.active.leaseId !== leaseId || this.active.requestId !== requestId) {
      this.counters.rejected += 1;
      throw new PipelineAttributionError('Pipeline attribution lease identity does not match.', {
        code: 'PIPELINE_ATTRIBUTION_LEASE_MISMATCH', statusCode: 409
      });
    }
    this.lastClosed = {
      leaseId,
      requestId,
      requestCount: this.active.requestCount,
      inference: this.active.inference || null,
      closedAt: this.now().toISOString()
    };
    this.active = null;
    this.counters.closed += 1;
    return { closed: true, idempotent: false, requestCount: this.lastClosed.requestCount,
      ...(this.lastClosed.inference && { inference: this.lastClosed.inference }) };
  }

  status() {
    const now = this.now();
    this._expire(now);
    return {
      contractVersion: 1,
      alias: PIPELINE_MODEL_ALIAS,
      consumerContract: PIPELINE_CONSUMER_CONTRACT,
      active: this.active ? publicLease(this.active) : null,
      counters: { ...this.counters }
    };
  }
}

function sendError(res, error, logger) {
  const statusCode = Number(error?.statusCode) || 500;
  const code = error?.code || 'PIPELINE_ATTRIBUTION_ERROR';
  if (statusCode >= 500) logger?.warn?.('Pipeline attribution control failed', { code });
  return res.status(statusCode).json({
    status: 'error',
    error: { code, message: String(error?.message || 'Pipeline attribution failed') }
  });
}

function registerPipelineAttributionRoutes({ express, manager, logger }) {
  const router = express.Router();
  router.get('/status', (_req, res) => res.json({ status: 'success', data: manager.status() }));
  router.post('/leases', async (req, res) => {
    try {
      const result = await manager.open(req.body || {});
      return res.status(result.idempotent ? 200 : 201).json({ status: 'success', data: result });
    } catch (error) { return sendError(res, error, logger); }
  });
  router.post('/leases/:leaseId/close', (req, res) => {
    try {
      const result = manager.close({ ...(req.body || {}), leaseId: req.params.leaseId });
      return res.json({ status: 'success', data: result });
    } catch (error) { return sendError(res, error, logger); }
  });
  return router;
}

module.exports = {
  MAX_REQUESTS_PER_LEASE,
  PIPELINE_CONSUMER_CONTRACT,
  PIPELINE_MODEL_ALIAS,
  PipelineAttributionError,
  PipelineAttributionLeaseManager,
  registerPipelineAttributionRoutes
};
