'use strict';

const Alert = require('../../models/Alert');
const { normalizeAlertForRead } = require('./alertFeedProjection');
const PAGE_SIZE = 100;
const MAX_ALERTS = 500;

// Scan past old task escalations and the watch's own reports before declaring
// a clear system. Acknowledgment transfers ownership; it is not recovery.
async function listOpenAlerts() {
  const alerts = [];
  let after = null;
  while (alerts.length <= MAX_ALERTS) {
    const page = await Alert.find({ status: { $in: ['active', 'acknowledged'] },
      ruleId: { $ne: 'ops-watch-report' }, ...(after ? { _id: { $gt: after } } : {}),
    }).sort({ _id: 1 }).limit(PAGE_SIZE).lean();
    alerts.push(...page.map(normalizeAlertForRead));
    if (alerts.length > MAX_ALERTS) break;
    if (page.length < PAGE_SIZE) return alerts;
    after = page.at(-1)._id;
  }
  throw new Error('Operations watch alert scan is incomplete');
}

module.exports = { listOpenAlerts };
