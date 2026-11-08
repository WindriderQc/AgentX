'use strict';

const { pipelineContract, pipelineTasks, pipelineCounts } = require('./projection');
const PIPELINE_ROUTE = '/api/pipeline/tasks?view=summary&includeDone=true&limit=1000';

// Pipeline reads use the existing parser/count contract, without waiting for
// runtime inventories, GPU/service probes, alerts or repository collectors.
async function buildPipelineProjection({ fetchJson, now = () => new Date() }) {
  let result;
  try { result = await fetchJson(PIPELINE_ROUTE); }
  catch { result = { ok: false }; }
  const contract = pipelineContract(result);
  const tasks = contract.valid ? pipelineTasks(result) : [];
  const counts = pipelineCounts(result, tasks);
  return {
    schemaVersion: 5, authority: 'aio-ops-runtime-bridges', readOnly: true,
    generatedAt: new Date(now()).toISOString(),
    sources: { pipeline: {
      status: contract.valid ? 'ok' : 'degraded', authority: PIPELINE_ROUTE,
      issues: contract.valid ? [] : ['PIPELINE_SOURCE_UNAVAILABLE_OR_INVALID']
    } },
    // These sources were not collected. Never report them as healthy/empty.
    alertEvidence: { available: false, records: [] },
    work: { counts: counts.counts, countsComplete: counts.complete, countsBasis: counts.basis,
      countScope: 'all pipeline statuses',
      active: tasks.filter(task => ['queued', 'in_progress', 'review', 'blocked'].includes(task.status)),
      recent: [] }
  };
}

module.exports = { buildPipelineProjection, PIPELINE_ROUTE };
