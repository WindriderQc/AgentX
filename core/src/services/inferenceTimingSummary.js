'use strict';

const PHASES = ['loadMs', 'promptEvalMs', 'evalMs'];
const WAITS = { admission: '$admissionWaitMs', hostGate: '$hostGateWaitMs', retryBackoff: '$retry.delayMs' };
const known = field => ({ $and: [{ $isNumber: field }, { $gte: [field, 0] }, { $lt: [field, 1e15] }] });

// Compare phases with elapsed time only on the SAME calls. A remainder is not
// proof of waiting: it can include transport, routing, retries and unreported work.
function timingFacet() {
  const phasesKnown = { $and: PHASES.map(field => known('$' + field)) };
  const elapsedKnown = { $and: [known('$durationMs'), { $gt: ['$durationMs', 0] }] };
  const sum = fields => ({ $add: fields.map(field => '$' + field) });
  const eligible = { $and: [elapsedKnown, { $ne: ['$_phaseMs', null] }] };
  const coherent = { $and: [eligible, { $lte: ['$_phaseMs', '$durationMs'] }] };
  const metrics = {
    calls: { $sum: { $cond: [coherent, 1, 0] } },
    inconsistentCalls: { $sum: { $cond: [{ $and: [eligible, { $gt: ['$_phaseMs', '$durationMs'] }] }, 1, 0] } },
  };
  for (const field of ['durationMs', ...PHASES]) metrics[field] = { $sum: { $cond: [coherent, '$' + field, 0] } };
  for (const [name, field] of Object.entries(WAITS)) {
    metrics[name + 'Calls'] = { $sum: { $cond: [known(field), 1, 0] } };
    metrics[name + 'Ms'] = { $sum: { $cond: [known(field), field, 0] } };
  }
  return [
    { $set: { _phaseMs: { $cond: [phasesKnown, sum(PHASES), null] } } },
    { $group: { _id: null, ...metrics } },
  ];
}

function shapeTiming(row = {}, totalCalls = 0) {
  const calls = row.calls || 0;
  const phases = Object.fromEntries(PHASES.map(field => [field, calls > 0 ? row[field] : null]));
  return {
    unit: 'ms', totalCalls,
    phases: { calls, elapsedMs: calls > 0 ? row.durationMs : null, ...phases,
      otherMs: calls > 0 ? row.durationMs - PHASES.reduce((sum, field) => sum + row[field], 0) : null,
      inconsistentCalls: row.inconsistentCalls || 0,
      missingCalls: totalCalls - calls - (row.inconsistentCalls || 0) },
    waits: Object.fromEntries(Object.keys(WAITS).map(name => [name, {
      calls: row[name + 'Calls'] || 0,
      totalMs: row[name + 'Calls'] > 0 ? row[name + 'Ms'] : null,
    }])),
    limits: [
      'Phase sums cover only calls with all three non-negative runtime phases and positive elapsed time; inconsistent phase totals are excluded.',
      'Other time is elapsed minus reported phases on those same calls. It is not a measurement of waiting or GPU idle time.',
      'Core waits are separate observations with their own coverage, already included in end-to-end time. Do not add them to phase totals.',
      'Admission and host-gate timings cover the terminal attempt, not all retries. Retry backoff covers only recorded delays; upstream queueing is not isolated.',
      'Concurrent calls overlap. Runtime phase durations are not GPU busy time.',
    ],
  };
}

// Bounded numeric projection for the shared presentation receipt.
function projectTiming(timing) {
  if (!timing || !Number.isFinite(timing.totalCalls)) return null;
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const fields = ['calls', 'elapsedMs', ...PHASES, 'otherMs', 'inconsistentCalls', 'missingCalls'];
  return { unit: 'ms', totalCalls: numeric(timing.totalCalls),
    phases: Object.fromEntries(fields.map(key => [key, numeric(timing.phases?.[key])])),
    waits: Object.fromEntries(Object.keys(WAITS).map(key => [key, {
      calls: numeric(timing.waits?.[key]?.calls), totalMs: numeric(timing.waits?.[key]?.totalMs),
    }])),
    limits: shapeTiming().limits,
  };
}

module.exports = { timingFacet, shapeTiming, projectTiming };
