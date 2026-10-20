'use strict';

const { ADMISSION_REASONS, FAILURE_REASONS } = require('./routing/inferenceFailureReasons');
const { projectInferenceLog } = require('./routing/inferenceLogReadProjection');

// Older trusted-runtime rows have an unknown route outcome but retain the last
// failed admission in retry.history. Use it only with terminal-attempt proof;
// an earlier retry's refusal must never explain a later execution failure.
function failureReasonExpression() {
  return { $let: {
    vars: {
      reason: '$routeDecision.outcome.reasonCode', code: '$routeDecision.outcome.code',
      last: { $arrayElemAt: [{ $cond: [{ $isArray: '$retry.history' }, '$retry.history', []] }, -1] },
    },
    in: { $switch: { branches: [
      { case: { $in: ['$$reason', FAILURE_REASONS] }, then: '$$reason' },
      { case: { $in: ['$$code', FAILURE_REASONS] }, then: '$$code' },
      { case: { $and: [
        { $in: [{ $ifNull: ['$$code', 'unknown'] }, ['unknown', 'pre_dispatch_error']] },
        { $in: ['$$last.cause', ADMISSION_REASONS] },
        { $eq: ['$$last.attempt', '$retry.attempts'] }, { $eq: ['$$last.delayMs', 0] },
        { $isNumber: '$admissionWaitMs' },
        { $eq: [{ $ifNull: ['$hostGateWaitMs', null] }, null] },
      ] }, then: '$$last.cause' },
      { case: { $eq: ['$status', 'timeout'] }, then: 'upstream_timeout' },
    ], default: 'unclassified_error' } },
  } };
}

function failureFacets() {
  const match = { $match: { status: { $ne: 'success' }, _analyticsCancelled: { $ne: true } } };
  const reason = { $set: { _failureReason: failureReasonExpression() } };
  return {
    failureReasons: [match, reason,
      { $group: { _id: '$_failureReason', calls: { $sum: 1 } } },
      { $sort: { calls: -1, _id: 1 } },
    ],
    topErrors: [match, reason,
      { $group: {
        _id: { model: '$model', status: '$status', reason: '$_failureReason', consumerContract: '$consumerContract' },
        calls: { $sum: 1 },
        durationMs: { $sum: { $cond: [{ $gt: ['$durationMs', 0] }, '$durationMs', 0] } },
        timedCalls: { $sum: { $cond: [{ $gt: ['$durationMs', 0] }, 1, 0] } },
      } },
      { $sort: { calls: -1, '_id.reason': 1, '_id.consumerContract': 1, '_id.model': 1 } }, { $limit: 10 },
    ],
  };
}

const safeReason = reason => FAILURE_REASONS.includes(reason) ? reason : 'unclassified_error';
function shapeFailures(facet) {
  const byReason = (facet?.failureReasons || []).map(row => ({ reason: safeReason(row._id), calls: row.calls }));
  const admissionRefusals = byReason.filter(row => ADMISSION_REASONS.includes(row.reason)).reduce((sum, row) => sum + row.calls, 0);
  const unclassified = byReason.filter(row => row.reason === 'unclassified_error').reduce((sum, row) => sum + row.calls, 0);
  return {
    failureAnalysis: { admissionRefusals, unclassified, byReason,
      basis: 'Recorded non-success attempts excluding cancellations. Admission refusals did not dispatch inference. Retries can produce several records for one client request; these are not counts of failed user requests.' },
    topErrors: (facet?.topErrors || []).map(row => {
      const projected = projectInferenceLog({ model: row._id?.model, status: row._id?.status, consumerContract: row._id?.consumerContract });
      return { model: projected.model || 'unknown', error: projected.status || 'error',
        reason: safeReason(row._id?.reason), consumerContract: projected.consumerContract || 'unknown',
        calls: row.calls, avgLatencyMs: row.timedCalls > 0 ? Math.round(row.durationMs / row.timedCalls) : null };
    }),
  };
}

module.exports = { failureFacets, shapeFailures };
