'use strict';

/**
 * Inference distributions over `inferencelogs`.
 *
 * The summary route reports sums and averages. Placement decisions (does a
 * lane's real prompt fit a smaller context, how long do calls wait) need
 * distributions: percentiles, maxima and prompt-size buckets per traffic class.
 * This module builds that aggregation and shapes its result. It reads only
 * numeric fields and server-attested labels; `callerDetail` is never grouped.
 *
 * Percentiles use MongoDB's `$percentile` with the `approximate` method
 * (MongoDB 7.0+), which the response states.
 */

const { STABLE_REASON_CODES } = require('./routing/routeDecision');

// A fallback reason is grouped only as a stable code, like the read projection
// returns it: free-text legacy reasons become `other`, no reason is `none`.
function fallbackReasonExpression() {
  const reason = { $toLower: { $trim: { input: { $ifNull: ['$fallbackReason', ''] } } } };
  return {
    $let: {
      vars: { reason },
      in: {
        $switch: {
          branches: [
            { case: { $eq: ['$$reason', ''] }, then: 'none' },
            { case: { $in: ['$$reason', [...STABLE_REASON_CODES]] }, then: '$$reason' },
            {
              case: { $regexMatch: { input: '$$reason', regex: '^(upstream_(http|status)_[1-5][0-9]{2}|fetch_timeout_[1-9][0-9]{0,8}ms)$' } },
              then: '$$reason'
            }
          ],
          default: 'other'
        }
      }
    }
  };
}

const GROUP_FIELDS = Object.freeze({
  consumerContract: '$consumerContract',
  taskType: '$taskType',
  model: '$model',
  host: '$host',
  hostKey: '$hostKey',
  caller: '$caller',
  runtime: '$runtime',
  status: '$status',
  fallbackReason: fallbackReasonExpression(),
});

const DEFAULT_GROUP_BY = Object.freeze(['consumerContract']);
const MAX_GROUP_FIELDS = 2;
const DEFAULT_GROUP_LIMIT = 50;
const MAX_GROUP_LIMIT = 200;
const PERCENTILES = Object.freeze([0.5, 0.9, 0.95, 0.99]);
const CONTEXT_FILL_THRESHOLDS = Object.freeze([0.5, 0.75, 0.9]);

// Upper bounds (inclusive) of the input-token buckets, chosen around the
// context windows a placement decision compares.
const INPUT_TOKEN_BUCKETS = Object.freeze([
  { label: '<=8k', upTo: 8192 },
  { label: '<=16k', upTo: 16384 },
  { label: '<=32k', upTo: 32768 },
  { label: '<=64k', upTo: 65536 },
  { label: '<=96k', upTo: 98304 },
  { label: '<=128k', upTo: 131072 },
  { label: '<=192k', upTo: 196608 },
  { label: '>192k', upTo: null },
]);

const METRICS = Object.freeze({
  inputTokens: 'Prompt tokens: tokensIn when reported, otherwise the estimate taken at dispatch.',
  tokensOut: 'Generated tokens reported by the runtime.',
  durationMs: "Core's wall clock for the call, routing, admission and retries included.",
  firstTokenMs: 'Streamed calls only: dispatch to the first output frame.',
  loadMs: 'Model load time reported by Ollama.',
  promptEvalMs: 'Prompt evaluation (prefill) time reported by Ollama.',
  evalMs: 'Generation time reported by Ollama.',
  nonModelMs: 'durationMs minus load, prompt evaluation and generation, when all three are reported: routing, admission, queueing, retries and network.',
  admissionWaitMs: 'Runtime admission wait of the attempt that ended the call. Absent on older rows.',
  hostGateWaitMs: "Wait at Core's per-host and model gate for the attempt that ended the call. Absent on older rows.",
  numCtx: 'Context window sent to the runtime (num_ctx).',
  contextFill: 'inputTokens divided by num_ctx.',
});

function positive(field) {
  return { $cond: [{ $and: [{ $isNumber: field }, { $gt: [field, 0] }] }, field, null] };
}

function present(field) {
  return { $cond: [{ $and: [{ $isNumber: field }, { $gte: [field, 0] }] }, field, null] };
}

function parseGroupBy(raw) {
  if (raw == null || String(raw).trim() === '') return [...DEFAULT_GROUP_BY];
  const fields = [...new Set(String(raw).split(',').map(value => value.trim()).filter(Boolean))];
  const unknown = fields.filter(field => !Object.prototype.hasOwnProperty.call(GROUP_FIELDS, field));
  if (unknown.length > 0 || fields.length === 0 || fields.length > MAX_GROUP_FIELDS) {
    const error = new Error(
      `groupBy accepts one or two of: ${Object.keys(GROUP_FIELDS).join(', ')}`
    );
    error.statusCode = 400;
    throw error;
  }
  return fields;
}

function parseGroupLimit(raw) {
  if (raw == null || raw === '') return DEFAULT_GROUP_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_GROUP_LIMIT) {
    const error = new Error(`limit must be an integer between 1 and ${MAX_GROUP_LIMIT}`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function metricAccumulators() {
  const accumulators = {};
  for (const metric of Object.keys(METRICS)) {
    const input = `$${metric}`;
    accumulators[`${metric}__count`] = { $sum: { $cond: [{ $isNumber: input }, 1, 0] } };
    accumulators[`${metric}__max`] = { $max: input };
    accumulators[`${metric}__pct`] = {
      $percentile: { input, p: [...PERCENTILES], method: 'approximate' }
    };
  }
  return accumulators;
}

function bucketAccumulators() {
  const accumulators = {};
  let lower = 0;
  INPUT_TOKEN_BUCKETS.forEach((bucket, index) => {
    const conditions = [{ $isNumber: '$inputTokens' }, { $gt: ['$inputTokens', lower] }];
    if (bucket.upTo != null) conditions.push({ $lte: ['$inputTokens', bucket.upTo] });
    accumulators[`bucket__${index}`] = { $sum: { $cond: [{ $and: conditions }, 1, 0] } };
    if (bucket.upTo != null) lower = bucket.upTo;
  });
  CONTEXT_FILL_THRESHOLDS.forEach((threshold, index) => {
    accumulators[`fill__${index}`] = {
      $sum: { $cond: [{ $and: [{ $isNumber: '$contextFill' }, { $gte: ['$contextFill', threshold] }] }, 1, 0] }
    };
  });
  return accumulators;
}

function groupAccumulators() {
  return {
    calls: { $sum: 1 },
    success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
    error: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
    timeout: { $sum: { $cond: [{ $eq: ['$status', 'timeout'] }, 1, 0] } },
    ...metricAccumulators(),
    ...bucketAccumulators(),
  };
}

function projectionStage(groupBy) {
  const labels = {};
  for (const field of groupBy) labels[field] = { $ifNull: [GROUP_FIELDS[field], 'unknown'] };
  const phases = ['$loadMs', '$promptEvalMs', '$evalMs'];
  return {
    $project: {
      _id: 0,
      ...labels,
      status: 1,
      inputTokens: {
        $cond: [
          { $and: [{ $isNumber: '$tokensIn' }, { $gt: ['$tokensIn', 0] }] },
          '$tokensIn',
          positive('$estimatedInputTokensAtDispatch'),
        ]
      },
      tokensOut: positive('$tokensOut'),
      durationMs: positive('$durationMs'),
      firstTokenMs: present('$firstTokenMs'),
      loadMs: present('$loadMs'),
      promptEvalMs: present('$promptEvalMs'),
      evalMs: present('$evalMs'),
      nonModelMs: {
        $cond: [
          {
            $and: [
              { $isNumber: '$durationMs' }, { $gt: ['$durationMs', 0] },
              ...phases.map(phase => ({ $isNumber: phase })),
            ]
          },
          { $max: [0, { $subtract: ['$durationMs', { $add: phases }] }] },
          null,
        ]
      },
      numCtx: positive('$num_ctx'),
      admissionWaitMs: present('$admissionWaitMs'),
      hostGateWaitMs: present('$hostGateWaitMs'),
    }
  };
}

const CONTEXT_FILL_STAGE = Object.freeze({
  $set: {
    contextFill: {
      $cond: [
        { $and: [{ $isNumber: '$inputTokens' }, { $isNumber: '$numCtx' }] },
        { $divide: ['$inputTokens', '$numCtx'] },
        null,
      ]
    }
  }
});

function buildDistributionPipeline({ match, groupBy, limit }) {
  const groupId = {};
  for (const field of groupBy) groupId[field] = `$${field}`;
  const accumulators = groupAccumulators();
  return [
    { $match: match },
    projectionStage(groupBy),
    CONTEXT_FILL_STAGE,
    {
      $facet: {
        totals: [{ $group: { _id: null, ...accumulators } }],
        groups: [
          { $group: { _id: groupId, ...accumulators } },
          { $sort: { calls: -1 } },
          { $limit: limit + 1 },
        ],
      }
    },
  ];
}

function roundMetric(metric, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return metric === 'contextFill' ? Math.round(value * 1000) / 1000 : Math.round(value);
}

function shapeMetrics(row) {
  const metrics = {};
  for (const metric of Object.keys(METRICS)) {
    const count = row[`${metric}__count`] || 0;
    const percentiles = Array.isArray(row[`${metric}__pct`]) ? row[`${metric}__pct`] : [];
    const shaped = { count };
    PERCENTILES.forEach((p, index) => {
      shaped[`p${Math.round(p * 100)}`] = count > 0 ? roundMetric(metric, percentiles[index]) : null;
    });
    shaped.max = count > 0 ? roundMetric(metric, row[`${metric}__max`]) : null;
    metrics[metric] = shaped;
  }
  return metrics;
}

function shapeRow(row, sanitizeLabel) {
  const calls = row.calls || 0;
  const key = {};
  if (row._id && typeof row._id === 'object') {
    for (const [field, value] of Object.entries(row._id)) key[field] = sanitizeLabel(field, value);
  }
  const contextFillCount = row.contextFill__count || 0;
  return {
    ...(Object.keys(key).length > 0 && { key }),
    calls,
    statuses: { success: row.success || 0, error: row.error || 0, timeout: row.timeout || 0 },
    metrics: shapeMetrics(row),
    inputTokenBuckets: INPUT_TOKEN_BUCKETS.map((bucket, index) => ({
      label: bucket.label,
      upTo: bucket.upTo,
      calls: row[`bucket__${index}`] || 0,
    })),
    contextFill: {
      count: contextFillCount,
      thresholds: CONTEXT_FILL_THRESHOLDS.map((threshold, index) => ({
        atLeast: threshold,
        calls: row[`fill__${index}`] || 0,
      })),
    },
  };
}

function shapeDistribution(facet, { groupBy, limit, sanitizeLabel }) {
  const totalsRow = facet?.totals?.[0] || { calls: 0 };
  const groupRows = Array.isArray(facet?.groups) ? facet.groups : [];
  return {
    groupBy,
    percentileMethod: 'approximate',
    percentiles: PERCENTILES.map(p => `p${Math.round(p * 100)}`),
    metrics: METRICS,
    totals: shapeRow({ ...totalsRow, _id: null }, sanitizeLabel),
    groups: groupRows.slice(0, limit).map(row => shapeRow(row, sanitizeLabel)),
    truncated: groupRows.length > limit,
  };
}

module.exports = {
  CONTEXT_FILL_THRESHOLDS,
  DEFAULT_GROUP_BY,
  GROUP_FIELDS,
  fallbackReasonExpression,
  INPUT_TOKEN_BUCKETS,
  METRICS,
  PERCENTILES,
  buildDistributionPipeline,
  parseGroupBy,
  parseGroupLimit,
  shapeDistribution,
};
