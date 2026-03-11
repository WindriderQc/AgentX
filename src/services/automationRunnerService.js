const os = require('os');
const logger = require('../../config/logger');
const AutomationTask = require('../../models/AutomationTask');
const AutomationRun = require('../../models/AutomationRun');
const SpecialX = require('../../models/SpecialX');
const { runTaskByType } = require('./specialxTaskHandlers');

const DEFAULT_RUNNER_POLL_MS = parseInt(process.env.SPECIALX_RUNNER_POLL_MS || '5000', 10);
const DEFAULT_LEASE_MS = parseInt(process.env.SPECIALX_TASK_LEASE_MS || '45000', 10);
const OPENCLAW_WEBHOOK_TIMEOUT_MS = 5000;

class AutomationRunnerService {
  constructor() {
    this.instanceId = `${os.hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.pollMs = DEFAULT_RUNNER_POLL_MS;
    this.leaseMs = DEFAULT_LEASE_MS;
    this.enabled = process.env.SPECIALX_RUNNER_ENABLED !== 'false';
    this.timer = null;
    this.busy = false;
    this.startedAt = null;
    this.lastTickAt = null;
    this.lastError = null;
    this.processedCount = 0;
  }

  async start() {
    if (!this.enabled) {
      logger.info('SpecialX runner disabled by SPECIALX_RUNNER_ENABLED=false');
      return;
    }

    if (this.timer) {
      return;
    }

    await SpecialX.ensureDefaultOperator().catch((err) => {
      logger.warn('Failed to ensure default SpecialX operator on start', { error: err.message });
    });

    this.startedAt = new Date();
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.lastError = err.message;
        logger.error('SpecialX runner tick failed', { error: err.message, instanceId: this.instanceId });
      });
    }, this.pollMs);

    // Kick off one run immediately so queue starts moving without waiting poll interval.
    setImmediate(() => {
      this.tick().catch((err) => {
        this.lastError = err.message;
        logger.error('SpecialX runner initial tick failed', { error: err.message, instanceId: this.instanceId });
      });
    });

    logger.info('SpecialX runner started', {
      instanceId: this.instanceId,
      pollMs: this.pollMs,
      leaseMs: this.leaseMs
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('SpecialX runner stopped', { instanceId: this.instanceId });
    }
  }

  async tick() {
    if (!this.enabled || this.busy) {
      return null;
    }

    this.busy = true;
    this.lastTickAt = new Date();

    try {
      const leasedTask = await AutomationTask.claimNext(this.instanceId, this.leaseMs);
      if (!leasedTask) {
        return null;
      }

      this.processedCount += 1;
      await this.executeLeasedTask(leasedTask);
      return leasedTask;
    } finally {
      this.busy = false;
    }
  }

  async enqueueTask(taskInput, context = {}) {
    const {
      workspaceId = null,
      userId = null,
      authSource = 'session'
    } = context;

    const normalizedIdempotencyKey = typeof taskInput.idempotencyKey === 'string'
      ? taskInput.idempotencyKey.trim()
      : '';

    if (normalizedIdempotencyKey) {
      const existing = await AutomationTask.findOne({ idempotencyKey: normalizedIdempotencyKey });
      if (existing) {
        return existing;
      }
    }

    const specialX = await this.resolveSpecialX(taskInput.specialXId, workspaceId);
    const payload = {
      workspaceId,
      specialXId: specialX?._id || null,
      source: taskInput.source || 'manual',
      type: taskInput.type,
      status: 'queued',
      priority: taskInput.priority || 5,
      input: taskInput.input || {},
      constraints: {
        noCloud: taskInput.constraints?.noCloud ?? true,
        allowCloudFallback: taskInput.constraints?.allowCloudFallback ?? false,
        maxLocalAttempts: taskInput.constraints?.maxLocalAttempts ?? 2,
        timeoutMs: taskInput.constraints?.timeoutMs ?? 120000
      },
      runAt: taskInput.runAt ? new Date(taskInput.runAt) : new Date(),
      maxAttempts: taskInput.maxAttempts || 3,
      tags: Array.isArray(taskInput.tags) ? taskInput.tags : [],
      requestedBy: {
        userId: userId || null,
        authSource
      }
    };

    if (normalizedIdempotencyKey) {
      payload.idempotencyKey = normalizedIdempotencyKey;
    }

    try {
      const task = await AutomationTask.create(payload);
      return task;
    } catch (error) {
      if (error?.code === 11000 && normalizedIdempotencyKey) {
        const existing = await AutomationTask.findOne({ idempotencyKey: normalizedIdempotencyKey });
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  async executeLeasedTask(taskDoc) {
    const task = await AutomationTask.findById(taskDoc._id);
    if (!task) {
      return;
    }

    const attempt = task.attempts + 1;
    const startedAt = new Date();
    const specialX = await this.resolveSpecialX(task.specialXId, task.workspaceId);

    await AutomationTask.updateOne(
      { _id: task._id, 'lease.owner': this.instanceId },
      {
        $set: {
          status: 'running',
          startedAt
        },
        $inc: { attempts: 1 }
      }
    );

    const run = await AutomationRun.create({
      workspaceId: task.workspaceId || null,
      taskId: task._id,
      specialXId: specialX?._id || null,
      workerId: this.instanceId,
      attempt,
      status: 'running',
      execution: {
        localFirst: specialX?.modelPolicy?.localFirst !== false,
        fallbackUsed: false
      },
      startedAt
    });

    const heartbeatTimer = setInterval(() => {
      AutomationTask.heartbeat(task._id, this.instanceId, this.leaseMs).catch((err) => {
        logger.warn('SpecialX task heartbeat failed', { taskId: String(task._id), error: err.message });
      });
    }, Math.max(5000, Math.floor(this.leaseMs / 3)));

    try {
      const result = await runTaskByType(task, specialX, this.getQueueMetrics.bind(this));
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      await AutomationRun.updateOne(
        { _id: run._id },
        {
          $set: {
            status: 'completed',
            summary: result.summary,
            output: result.output || {},
            artifacts: result.artifacts || [],
            metrics: {
              localCalls: result.metrics?.localCalls || 0,
              cloudCalls: result.metrics?.cloudCalls || 0,
              retriesUsed: attempt - 1,
              durationMs
            },
            execution: {
              localFirst: specialX?.modelPolicy?.localFirst !== false,
              fallbackUsed: result.execution?.fallbackUsed || false,
              model: result.execution?.model || null,
              target: result.execution?.target || null,
              taskType: result.execution?.taskType || null,
              routed: result.execution?.routed || false
            },
            finishedAt
          }
        }
      );

      await AutomationTask.updateOne(
        { _id: task._id, 'lease.owner': this.instanceId },
        {
          $set: {
            status: 'completed',
            completedAt: finishedAt,
            resultRunId: run._id,
            lastError: null,
            lease: {
              owner: null,
              leasedAt: null,
              leaseExpiresAt: null,
              heartbeatAt: null
            }
          }
        }
      );

      await this.updateSpecialXStats(specialX?._id, {
        success: true,
        durationMs
      });

      this.notifyOpenClawTaskResult({
        taskId: task._id,
        type: task.type,
        status: 'completed',
        runId: run._id,
        summary: result.summary || '',
        completedAt: finishedAt
      });

      logger.info('SpecialX task completed', {
        taskId: String(task._id),
        runId: String(run._id),
        type: task.type,
        durationMs
      });
    } catch (error) {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const isDeadLetter = attempt >= task.maxAttempts;
      const nextRetryAt = new Date(Date.now() + Math.min(600000, 15000 * attempt));

      await AutomationRun.updateOne(
        { _id: run._id },
        {
          $set: {
            status: 'failed',
            summary: error.message || 'Task failed',
            error: {
              message: error.message || 'Task failed',
              code: error.code || null,
              stack: error.stack || null
            },
            metrics: {
              localCalls: 0,
              cloudCalls: 0,
              retriesUsed: attempt - 1,
              durationMs
            },
            finishedAt
          }
        }
      );

      await AutomationTask.updateOne(
        { _id: task._id, 'lease.owner': this.instanceId },
        {
          $set: {
            status: isDeadLetter ? 'dead_letter' : 'queued',
            runAt: isDeadLetter ? task.runAt : nextRetryAt,
            lastError: error.message || 'Task failed',
            startedAt: isDeadLetter ? startedAt : null,
            completedAt: isDeadLetter ? finishedAt : null,
            resultRunId: run._id,
            lease: {
              owner: null,
              leasedAt: null,
              leaseExpiresAt: null,
              heartbeatAt: null
            }
          }
        }
      );

      await this.updateSpecialXStats(specialX?._id, {
        success: false,
        durationMs
      });

      if (isDeadLetter) {
        this.notifyOpenClawTaskResult({
          taskId: task._id,
          type: task.type,
          status: 'failed',
          runId: run._id,
          summary: error.message || 'Task failed',
          completedAt: finishedAt
        });
      }

      logger.error('SpecialX task failed', {
        taskId: String(task._id),
        runId: String(run._id),
        type: task.type,
        attempt,
        isDeadLetter,
        error: error.message
      });
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  async resolveSpecialX(specialXId, workspaceId = null) {
    if (specialXId) {
      const found = await SpecialX.findById(specialXId);
      if (found) {
        return found;
      }
    }

    const existing = await SpecialX.findOne({
      name: 'specialx.operator.v1',
      workspaceId: workspaceId || null
    });
    if (existing) {
      return existing;
    }

    return SpecialX.ensureDefaultOperator(workspaceId || null);
  }

  async updateSpecialXStats(specialXId, { success, durationMs }) {
    if (!specialXId) {
      return;
    }

    const updates = {
      $inc: {
        'stats.totalRuns': 1,
        'stats.successRuns': success ? 1 : 0,
        'stats.failedRuns': success ? 0 : 1
      },
      $set: {
        'stats.lastRunAt': new Date()
      }
    };

    const specialX = await SpecialX.findById(specialXId).lean();
    if (specialX) {
      const totalRuns = (specialX.stats?.totalRuns || 0) + 1;
      const currentAvg = specialX.stats?.avgDurationMs || 0;
      updates.$set['stats.avgDurationMs'] = Math.round(((currentAvg * (totalRuns - 1)) + durationMs) / totalRuns);
    }

    await SpecialX.updateOne({ _id: specialXId }, updates);
  }

  notifyOpenClawTaskResult(payload) {
    const webhookUrl = typeof process.env.OPENCLAW_WEBHOOK_URL === 'string'
      ? process.env.OPENCLAW_WEBHOOK_URL.trim()
      : '';

    if (!webhookUrl) {
      return;
    }

    void this.postOpenClawWebhook(webhookUrl, payload).catch((error) => {
      logger.warn('Failed to notify OpenClaw task result webhook', {
        webhookUrl,
        taskId: String(payload.taskId),
        status: payload.status,
        error: error.message
      });
    });
  }

  async postOpenClawWebhook(webhookUrl, payload) {
    const fetchImpl = await this.getFetch();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENCLAW_WEBHOOK_TIMEOUT_MS);

    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Webhook responded ${response.status}${body ? `: ${body}` : ''}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getFetch() {
    if (typeof fetch === 'function') {
      return fetch;
    }

    return (await import('node-fetch')).default;
  }

  async getQueueMetrics() {
    const [queueAgg, recentRunsAgg] = await Promise.all([
      AutomationTask.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]),
      AutomationRun.aggregate([
        {
          $match: {
            createdAt: {
              $gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
            }
          }
        },
        {
          $group: {
            _id: null,
            totalRuns: { $sum: 1 },
            successRuns: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            localCalls: { $sum: '$metrics.localCalls' },
            cloudCalls: { $sum: '$metrics.cloudCalls' }
          }
        }
      ])
    ]);

    const queue = {
      queued: 0,
      leased: 0,
      running: 0,
      completed: 0,
      failed: 0,
      dead_letter: 0,
      cancelled: 0
    };

    for (const item of queueAgg) {
      queue[item._id] = item.count;
    }

    const run = recentRunsAgg[0] || {
      totalRuns: 0,
      successRuns: 0,
      localCalls: 0,
      cloudCalls: 0
    };

    const totalCalls = run.localCalls + run.cloudCalls;
    const localFirstRatio = totalCalls > 0 ? Math.round((run.localCalls / totalCalls) * 100) : 100;
    const successRate = run.totalRuns > 0 ? Math.round((run.successRuns / run.totalRuns) * 100) : 0;

    return {
      queue,
      runs: {
        totalRuns24h: run.totalRuns,
        successRate,
        localCalls: run.localCalls,
        cloudCalls: run.cloudCalls,
        localFirstRatio
      }
    };
  }

  async getStatus() {
    const queueMetrics = await this.getQueueMetrics();
    return {
      status: 'success',
      data: {
        runner: {
          enabled: this.enabled,
          active: Boolean(this.timer),
          busy: this.busy,
          instanceId: this.instanceId,
          pollMs: this.pollMs,
          leaseMs: this.leaseMs,
          startedAt: this.startedAt,
          lastTickAt: this.lastTickAt,
          lastError: this.lastError,
          processedCount: this.processedCount
        },
        ...queueMetrics
      }
    };
  }
}

let serviceInstance = null;

function getAutomationRunnerService() {
  if (!serviceInstance) {
    serviceInstance = new AutomationRunnerService();
  }
  return serviceInstance;
}

module.exports = {
  getAutomationRunnerService
};
