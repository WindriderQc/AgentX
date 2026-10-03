'use strict';

// Continuity owns execution identities. A consulted agent name alone proves
// neither an execution nor its run ID, so progress never supplies attribution.
function nativePerformedBy(evidence, agentId, runId) {
  const run = evidence?.run;
  const rows = [{ agentId: run?.agentId || agentId, runId: run?.runId || runId || null }];
  const answer = evidence?.answer;
  if (answer?.status === 'ready' && answer.runId === runId && typeof answer.deliveredBy === 'string') {
    // Requester-settle and background completion runs execute in this same
    // native session. Preserve their exact identity without guessing a child run.
    rows.push({ agentId, runId: answer.deliveredBy });
  }
  return rows.filter((row, index) => rows.findIndex(other => other.agentId === row.agentId && other.runId === row.runId) === index);
}

module.exports = { nativePerformedBy };
