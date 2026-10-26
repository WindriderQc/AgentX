'use strict';

const { failureReasonExpression } = require('./inferenceFailureAnalytics');
const { ADMISSION_REASONS } = require('./routing/inferenceFailureReasons');

function recentFacet(metrics, since) {
  const error = { $and: [{ $ne: ['$status', 'success'] }, { $ne: ['$_analyticsCancelled', true] }] };
  const refusal = { $and: [error, { $in: ['$_recentReason', ADMISSION_REASONS] }] };
  const other = { $and: [error, { $not: [{ $in: ['$_recentReason', ADMISSION_REASONS] }] }] };
  return [
    { $match: { timestamp: { $gte: since } } },
    { $set: { _recentReason: failureReasonExpression() } },
    { $group: { _id: null, ...metrics,
      admissionRefusals: { $sum: { $cond: [refusal, 1, 0] } },
      unclassified: { $sum: { $cond: [{ $and: [error, { $eq: ['$_recentReason', 'unclassified_error'] }] }, 1, 0] } },
      lastErrorAt: { $max: { $cond: [other, '$timestamp', null] } },
      lastRefusalAt: { $max: { $cond: [refusal, '$timestamp', null] } }
    } }
  ];
}

function shapeRecent(row, since) {
  return { since, calls: row?.calls || 0, errors: row?.errors || 0,
    admissionRefusals: row?.admissionRefusals || 0, cancellations: row?.cancellations || 0,
    unclassified: row?.unclassified || 0,
    lastErrorAt: row?.lastErrorAt || null, lastRefusalAt: row?.lastRefusalAt || null };
}

module.exports = { recentFacet, shapeRecent };
