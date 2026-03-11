const logger = require('../../config/logger');
const { getAutomationRunnerService } = require('./automationRunnerService');

const DEFAULT_SWEEP_HOUR = Number.parseInt(process.env.PATCH_PROPOSAL_SWEEP_HOUR || '3', 10);
const DEFAULT_SWEEP_MINUTE = Number.parseInt(process.env.PATCH_PROPOSAL_SWEEP_MINUTE || '15', 10);
const DAY_MS = 24 * 60 * 60 * 1000;

function toDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

class PatchProposalExpiryService {
  constructor() {
    this.hour = Number.isNaN(DEFAULT_SWEEP_HOUR) ? 3 : DEFAULT_SWEEP_HOUR;
    this.minute = Number.isNaN(DEFAULT_SWEEP_MINUTE) ? 15 : DEFAULT_SWEEP_MINUTE;
    this.startTimer = null;
    this.dailyTimer = null;
  }

  start() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    if (this.startTimer || this.dailyTimer) {
      return;
    }

    const initialDelay = this.getDelayUntilNextSweep();
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.runSweep().catch((error) => {
        logger.error('Patch proposal expiry sweep failed', { error: error.message });
      });

      this.dailyTimer = setInterval(() => {
        this.runSweep().catch((error) => {
          logger.error('Patch proposal expiry sweep failed', { error: error.message });
        });
      }, DAY_MS);
    }, initialDelay);

    if (typeof this.startTimer.unref === 'function') {
      this.startTimer.unref();
    }

    logger.info('Patch proposal expiry scheduler started', {
      hour: this.hour,
      minute: this.minute,
      initialDelayMs: initialDelay
    });
  }

  stop() {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }

    if (this.dailyTimer) {
      clearInterval(this.dailyTimer);
      this.dailyTimer = null;
    }
  }

  getDelayUntilNextSweep(now = new Date()) {
    const nextRun = new Date(now);
    nextRun.setHours(this.hour, this.minute, 0, 0);
    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
    }
    return nextRun.getTime() - now.getTime();
  }

  async runSweep() {
    const service = getAutomationRunnerService();
    const task = await service.enqueueTask({
      type: 'proposal_expiry_sweep',
      source: 'system',
      priority: 6,
      input: {},
      idempotencyKey: `proposal_expiry_sweep:${toDateKey()}`
    }, {
      authSource: 'system'
    });

    logger.info('Enqueued patch proposal expiry sweep', {
      taskId: String(task._id),
      idempotencyKey: task.idempotencyKey
    });

    return task;
  }
}

let instance = null;

function getPatchProposalExpiryService() {
  if (!instance) {
    instance = new PatchProposalExpiryService();
  }
  return instance;
}

module.exports = {
  getPatchProposalExpiryService
};
