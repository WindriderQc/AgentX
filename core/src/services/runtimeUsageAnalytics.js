'use strict';

const declared = { $eq: ['$source', 'declared-receipt'] };
const knownCost = { $and: [declared, { $isNumber: '$declaredUsage.costUsd' }] };
const gateEligible = { $or: [{ $ne: ['$source', 'declared-receipt'] }, { $and: [knownCost, { $eq: ['$declaredUsage.billing', 'metered'] }] }] };
const tokens = { $add: [{ $ifNull: ['$tokensIn', 0] }, { $ifNull: ['$tokensOut', 0] }] };

const provenanceMetrics = {
  declaredCalls: { $sum: { $cond: [declared, 1, 0] } },
  declaredPricedCalls: { $sum: { $cond: [knownCost, 1, 0] } },
  declaredCostUsd: { $sum: { $cond: [knownCost, '$declaredUsage.costUsd', 0] } },
  observedTokensIn: { $sum: { $cond: [declared, 0, { $ifNull: ['$tokensIn', 0] }] } },
  observedTokensOut: { $sum: { $cond: [declared, 0, { $ifNull: ['$tokensOut', 0] }] } }
};
const budgetMetrics = {
  declaredRequests: provenanceMetrics.declaredCalls,
  excludedDeclaredRequests: { $sum: { $cond: [gateEligible, 0, 1] } },
  gateTokens: { $sum: { $cond: [gateEligible, tokens, 0] } }
};

function provenance(row, calls = row.calls || 0) {
  const declaredCalls = row.declaredCalls || 0;
  return { coreObservedCalls: calls - declaredCalls, declaredCalls };
}

async function cloudCost(row, estimate, calls = row.calls || 0) {
  const declaredCalls = row.declaredCalls || 0, observedCalls = calls - declaredCalls;
  const observedCost = observedCalls > 0 ? await estimate(row.observedTokensIn ?? row.tokensIn ?? row.promptTokens ?? 0,
    row.observedTokensOut ?? row.tokensOut ?? row.completionTokens ?? 0) : null;
  const declaredPricedCalls = row.declaredPricedCalls || 0;
  return {
    estimatedCostUsd: Number.isFinite(observedCost) || declaredPricedCalls > 0
      ? (observedCost || 0) + (row.declaredCostUsd || 0) : null,
    unpricedCalls: declaredCalls - declaredPricedCalls + (observedCalls > 0 && !Number.isFinite(observedCost) ? observedCalls : 0),
    ...provenance(row, calls)
  };
}

module.exports = { provenanceMetrics, budgetMetrics, provenance, cloudCost };
