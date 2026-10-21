'use strict';

// Keep historical bucket boundaries explicit. First/last buckets may be partial.
function bucketFacet(windowKey, groupMetrics) {
  return [
    { $group: {
      _id: { $dateToString: {
        format: windowKey === '24h' ? '%Y-%m-%dT%H:00:00.000Z' : '%Y-%m-%dT00:00:00.000Z',
        date: '$timestamp', timezone: 'UTC'
      } },
      ...groupMetrics
    } },
    { $sort: { _id: 1 } }
  ];
}

function summaryCoverage({ models, listedModels, calls, windowKey }) {
  const retentionDays = parseInt(process.env.INFERENCE_LOG_TTL_DAYS || '30', 10);
  return {
    retentionDays,
    requestedDays: { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[windowKey],
    modelCount: models.length,
    listedModelCount: listedModels.length,
    listedModelCalls: listedModels.reduce((sum, row) => sum + row.calls, 0),
    calls,
    durationBasis: 'Sum of end-to-end call durations, including routing and waits. Concurrent calls overlap; this is not GPU busy time.',
    tokenBasis: 'Reported tokens only; unreported usage is not measured.',
    scope: 'Recorded AgentX-routed calls only. Native calls bypassing Core are outside this view.',
    callBasis: 'Recorded inference attempts, including admission refusals. Client retries may create several records for one user request.'
  };
}

module.exports = { bucketFacet, summaryCoverage };
