'use strict';
const LIMIT = 'Allocation and GPU residency only; quality, tools, driver qualification and other contexts retain their existing evidence and warnings.';

function projectFit(row, { writerPresent = false, matchesCurrent = null } = {}) {
  if (!row) return null;
  const state = row.state === 'dispatching' && !writerPresent ? 'unknown' : row.state;
  return {
    contract: 'agentx.pinned-context-fit/v1', id: row._id, hostId: row.hostId,
    model: row.model, numCtx: row.numCtx, artifactDigest: row.artifact?.digest || null,
    runtimeFingerprint: row.artifact?.runtimeFingerprint || null,
    ollamaVersion: row.artifact?.runtime?.ollamaVersion || null,
    measuredVersion: row.measuredVersion || null, state,
    status: row.state === 'completed' && row.runtimeReleased === true ? 'pass'
      : row.result?.status === 'fail' ? 'fail' : 'unknown',
    fullVram: row.result?.fullVram ?? null,
    effectiveContext: row.result?.native?.contextLength || null,
    checkedAt: row.checkedAt || null, durationMs: row.durationMs ?? null,
    runtimeReleased: row.runtimeReleased === true,
    revalidationRequired: row.state !== 'completed' || row.runtimeReleased !== true,
    queueRequestId: row.queueRequestId || null,
    queueDispatchId: row.queueDispatchId || null,
    operationId: row.operationId, reason: row.reason || row.result?.reason || null,
    matchesCurrent, scope: 'exact_pinned_context_residency', qualificationAuthority: 'none', limit: LIMIT
  };
}

module.exports = { projectFit, LIMIT };
