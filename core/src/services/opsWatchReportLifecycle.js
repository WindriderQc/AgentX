'use strict';

const Alert = require('../../models/Alert');
const logger = require('../../config/logger');

// A changed finding set deserves an updated notification even when the same
// continuous incident is still open. Keep native delivery and acknowledgment
// semantics; an unchanged set uses the alert rule's normal reminder backoff.
async function publishReport(event) {
  const service = require('./alertService');
  const previous = await Alert.findOne({ ruleId: 'ops-watch-report', source: 'ops-watch',
    status: { $in: ['active', 'acknowledged'] },
    'context.additionalData.incidentKey': event.additionalData.incidentKey,
  }).lean();
  const alerts = await service.evaluateEvent(event);
  const report = alerts.find(alert => alert.ruleId === 'ops-watch-report');
  if (!report || !previous || previous.status !== 'active'
    || previous.context?.additionalData?.findingFingerprint === event.additionalData.findingFingerprint) return alerts;

  // A concurrent producer or a due native reminder may already have notified.
  const changed = await Alert.findOneAndUpdate({ _id: report._id, status: 'active',
    lastOccurrence: report.lastOccurrence, notificationCount: previous.notificationCount,
    'context.additionalData.findingFingerprint': event.additionalData.findingFingerprint,
  }, { $set: { lastNotifiedAt: new Date() }, $inc: { notificationCount: 1 } }, { new: true });
  if (changed) {
    try { await service._sendNotifications(changed, changed.channels); }
    catch (err) { logger.warn('[OpsWatch] updated report delivery failed', { error: err.message }); }
  }
  return alerts;
}

// Only the report producer can establish recovery. The generic stale sweep
// cannot distinguish a clear system from a disabled, slow or failing watch.
async function reconcileReports({ checkedAt, incidentKey }) {
  const observedAt = new Date(checkedAt);
  if (!Number.isFinite(observedAt.getTime()) || observedAt > new Date()) {
    throw new Error('Operations watch observation timestamp is invalid');
  }
  const openReports = {
    ruleId: 'ops-watch-report', source: 'ops-watch',
    status: { $in: ['active', 'acknowledged'] },
  };
  if (incidentKey && !(await Alert.exists({ ...openReports,
    'context.additionalData.incidentKey': incidentKey,
    lastOccurrence: { $gte: observedAt } }))) return 0;

  // Retire legacy reports only after their replacement was actually recorded.
  // A newer observation from another producer must never be closed by this one.
  const result = await Alert.updateMany({ ...openReports,
    lastOccurrence: { $lte: observedAt },
    ...(incidentKey ? { 'context.additionalData.incidentKey': { $ne: incidentKey } } : {}),
  }, { $set: {
    status: 'resolved', 'resolution.resolved': true,
    'resolution.resolvedAt': new Date(), 'resolution.resolvedBy': 'system',
    'resolution.resolutionMethod': incidentKey ? 'ops-watch-superseded' : 'ops-watch-clear',
    'resolution.comment': incidentKey
      ? 'Replaced by the current operations watch report; recovery is not claimed.'
      : 'A completed operations watch check found no current operational findings.',
  } });
  return result.modifiedCount ?? 0;
}

module.exports = { publishReport, reconcileReports };
