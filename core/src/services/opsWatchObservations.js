'use strict';

const Alert = require('../../models/Alert');
const { normalizeAlertForRead } = require('./alertFeedProjection');
const PAGE_SIZE = 100;
const MAX_ALERTS = 500;

// Scan past old task escalations and the watch's own reports before declaring
// a clear system. Acknowledgment transfers ownership; it is not recovery.
// Queue notifications are outcome receipts: successful/cancelled notices and
// reviewed, released failures stay in the inbox/history without becoming
// current incidents. Uncertain results and unreviewed failures remain findings.
async function listOpenAlerts() {
  const alerts = [];
  let after = null;
  while (alerts.length <= MAX_ALERTS) {
    const page = await Alert.find({ status: { $in: ['active', 'acknowledged'] },
      ruleId: { $ne: 'ops-watch-report' }, ...(after ? { _id: { $gt: after } } : {}),
      $nor: [
        { ruleId: 'heavy_work_queue', severity: 'info', 'context.additionalData.state': { $in: ['completed', 'cancelled'] } },
        { ruleId: 'heavy_work_queue', status: 'acknowledged', 'context.additionalData.state': 'failed', $or: [
          { 'context.additionalData.receipt.confirmation': 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED' },
          { 'context.additionalData.receipt.terminal': true, 'context.additionalData.receipt.waitingForRelease': false,
            'context.additionalData.receipt.uncertain': { $ne: true } }
        ] }
      ],
    }).sort({ _id: 1 }).limit(PAGE_SIZE).lean();
    alerts.push(...page.map(normalizeAlertForRead));
    if (alerts.length > MAX_ALERTS) break;
    if (page.length < PAGE_SIZE) return alerts;
    after = page.at(-1)._id;
  }
  throw new Error('Operations watch alert scan is incomplete');
}

module.exports = { listOpenAlerts };
