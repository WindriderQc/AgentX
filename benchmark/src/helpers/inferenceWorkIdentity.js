'use strict';

// Existing Core telemetry field; no new task store or admission authority.
// A bounded workload id links generation and judging to the same operation.
function inferenceWorkIdentity(workloadId) {
  if (workloadId == null) return {};
  const id = String(workloadId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id)) return {};
  return { workItemId: `benchmark-workload/${id}` };
}

module.exports = { inferenceWorkIdentity };
