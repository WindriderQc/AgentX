'use strict';

/**
 * Persistent hourly contention counters (#363): fallback ladder rungs served,
 * ladders exhausted, and /api/inference/generate refusals at selection or
 * admission. Counting never blocks or fails the call it describes.
 */

const logger = require('../../../config/logger');

const HOUR_MS = 3_600_000;
const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
// Only these stages mean "the host or model was not available to this call".
const REFUSAL_STAGES = new Set(['selection', 'admission']);

function counterModel() {
  return require('../../../models/InferenceContentionCounter');
}

function label(value, fallback) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  return LABEL_PATTERN.test(text) ? text : fallback;
}

function hourOf(time) {
  return new Date(Math.floor(time / HOUR_MS) * HOUR_MS);
}

/** Increment one bucket. Resolves; a storage failure is logged, never thrown. */
async function countContention(event, { taskType = null, code = null } = {}, {
  model = null, now = Date.now,
} = {}) {
  // Like recordInference: no implicit writes from unit tests.
  if (!model && process.env.NODE_ENV === 'test') return;
  if (!counterModel().CONTENTION_EVENTS.includes(event)) return;
  const Counter = model || counterModel();
  const at = now();
  const key = { hour: hourOf(at), event, taskType: label(taskType, 'other'), code: label(code, 'other') };
  const update = { $inc: { count: 1 }, $max: { lastAt: new Date(at) } };
  try {
    await Counter.updateOne(key, update, { upsert: true });
  } catch (error) {
    // Two processes creating the same bucket: the loser increments it.
    if (error?.code === 11000) {
      await Counter.updateOne(key, update).catch(() => {});
      return;
    }
    logger.warn('[InferenceContention] counter not recorded', { event, error: error?.message });
  }
}

/** Count a /api/inference/generate refusal from its RouteDecision. */
function countRouteRefusal(routeDecision, options) {
  const outcome = routeDecision?.outcome;
  if (!REFUSAL_STAGES.has(outcome?.stage)) return;
  void countContention('route_refused', {
    taskType: routeDecision.intent?.taskType,
    code: outcome.reasonCode || outcome.code,
  }, options);
}

/**
 * Buckets in [from, to], oldest first, and totals per event, task and code.
 * Grouped in Mongo: a bucket created twice before its unique index existed
 * still reads as one.
 */
async function readContention({ from, to }, { model = null } = {}) {
  const Counter = model || counterModel();
  const rows = await Counter.aggregate([
    { $match: { hour: { $gte: hourOf(from.getTime()), $lte: to } } },
    {
      $group: {
        _id: { hour: '$hour', event: '$event', taskType: '$taskType', code: '$code' },
        count: { $sum: '$count' },
        lastAt: { $max: '$lastAt' },
      }
    },
    { $sort: { '_id.hour': 1, '_id.event': 1, '_id.taskType': 1, '_id.code': 1 } },
  ]);
  const buckets = rows.map(row => ({
    hour: row._id.hour, event: row._id.event, taskType: row._id.taskType ?? null,
    code: row._id.code ?? null, count: row.count || 0, lastAt: row.lastAt || null,
  }));
  const totals = new Map();
  for (const bucket of buckets) {
    const key = `${bucket.event}\u0000${bucket.taskType ?? ''}\u0000${bucket.code ?? ''}`;
    const current = totals.get(key) || { event: bucket.event, taskType: bucket.taskType, code: bucket.code, count: 0, lastAt: null };
    current.count += bucket.count;
    if (bucket.lastAt && (!current.lastAt || bucket.lastAt > current.lastAt)) current.lastAt = bucket.lastAt;
    totals.set(key, current);
  }
  return {
    buckets: buckets.map(({ lastAt: _lastAt, ...bucket }) => bucket),
    totals: [...totals.values()].sort((left, right) => right.count - left.count),
  };
}

module.exports = { countContention, countRouteRefusal, readContention, _internal: { hourOf, label } };
