'use strict';

const { createOpenClawExecutionClient } = require('../../../../shared/openclawExecutionClient');

const RULE_ID = 'openclaw-paid-spend-step';
const STEP_NANODOLLARS = 10_000_000_000;

/**
 * Paid model-mode spend has no ceiling on an instance that chose none; the
 * owner is told each time the native running total crosses another 10 USD.
 * The total lives in OpenClaw; Core only remembers the last step it announced.
 */
function createOpenClawSpendWatch({ client = createOpenClawExecutionClient(), alertService = require('../alertService'),
  Alert = require('../../../models/Alert'), logger = require('../../../config/logger') } = {}) {
  let announcedStep = null, timer = null, running = false;

  async function check() {
    const { spend } = await client.catalog();
    if (!spend || !Number.isSafeInteger(spend.nanodollars)) return null;
    const step = Math.floor(spend.nanodollars / STEP_NANODOLLARS);
    if (announcedStep == null) {
      const last = await Alert.findOne({ ruleId: RULE_ID }).sort({ createdAt: -1 }).lean();
      announcedStep = Number(last?.context?.additionalData?.step) || 0;
    }
    if (step <= announcedStep) return null;
    const alerts = await alertService.evaluateEvent({ source: 'openclaw', metric: 'openclaw_paid_spend_step', value: spend.nanodollars / 1e9,
      additionalData: { step, incidentKey: `step-${step}`, stepUsd: step * 10, totalUsd: (spend.nanodollars / 1e9).toFixed(2),
        paidCalls: spend.paidCalls, unknownCostCalls: spend.unknownCostCalls, since: spend.since } });
    // Without a stored alert the step is not announced; the next tick tries again.
    if (alerts.length) announcedStep = step;
    return alerts[0] || null;
  }

  function tick() {
    if (running) return;
    running = true;
    check().catch(error => logger.warn('OpenClaw paid spend check failed', { code: error.code, error: error.message }))
      .finally(() => { running = false; });
  }

  return { check,
    start(intervalMs = 300000) { tick(); timer = setInterval(tick, intervalMs); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = null; } };
}

module.exports = { createOpenClawSpendWatch, RULE_ID, STEP_NANODOLLARS };
