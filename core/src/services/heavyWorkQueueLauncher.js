'use strict';

// Core launches a reserved Profiler, embedding reindex or report campaign
// request itself, either because the owner pressed "Run now" or because the
// owner opted in to an automatic start when planning its slot. Both paths cross the same durable dispatch fence as the
// operator CLI: the request must be reserved, its window open and its
// resources free; a launch whose outcome is unknown is never repeated.

const { requestJson } = require('../helpers/crossServiceClient');
const logger = require('../../config/logger');
const queue = require('./heavyWorkQueueService');
const evidence = require('./heavyWorkQueueEvidence');
const { fail } = require('./heavyWorkQueueContract');

const AUTO_ACTOR = 'core-auto-start';
const START_TIMEOUT_MS = 5 * 60000;

async function startProfile(body) {
  try {
    const answer = await requestJson({ baseUrl: process.env.BENCHMARK_SERVICE_URL || 'http://localhost:3081',
      path: '/api/profiler/pipeline/profile-host', method: 'POST', body, timeoutMs: START_TIMEOUT_MS, serviceName: 'benchmark' });
    return answer?.data ?? answer;
  } catch (error) {
    const refusal = require('../../../shared/queueLaunchReceipt.cjs').readRefusal(error.body, { id: body.queueRequestId, kind: 'profiler' });
    if (refusal) Object.assign(error, { notStarted: true, code: refusal.code, message: refusal.reason });
    throw error;
  }
}
// Each request Core launches: its native start and the receipt identity it
// returns. `start` replaces the Profiler start only (tests, Run now).
const STARTERS = {
  transcription: {
    start: job => require('./transcriptionExecutor').start(job),
    operationId: result => result?.id, name: 'local transcription'
  },
  profiler: {
    start: (begun, start) => (start || startProfile)({ ...begun.executor, queueRequestId: begun.id, queueDispatchId: begun.dispatchId }),
    operationId: result => result?.queueId,
    name: 'Profiler'
  },
  'embedding-reindex': {
    start: begun => require('./embeddingReindex').startBuild(begun),
    operationId: result => result?.id,
    name: 'RAG embedding build'
  },
  topology: {
    start: begun => require('./runtimeTopologyWindow').start(begun),
    operationId: result => result?.id,
    name: 'topology window'
  },
  'pipeline-report': {
    start: begun => require('./pipelineReportResume').launchFromCampaign(begun),
    operationId: result => result?.queueId,
    name: 'report campaign'
  }
};
function starterFor(job) {
  return STARTERS[job.executor?.mode === 'pipeline-report' ? 'pipeline-report' : job.kind];
}
function startable(job) {
  const starter = queue.autoStartable(job) && starterFor(job);
  if (!starter) {
    throw fail('Core launches Profiler, embedding reindex, topology, local transcription and report campaign requests only; use the request\'s own executor protocol', 409, 'HEAVY_QUEUE_LAUNCH_UNSUPPORTED');
  }
  return starter;
}
function windowOpen(job, now) {
  return job.state === 'reserved' && Date.parse(job.reservation?.start) <= now && now < Date.parse(job.reservation?.end)
    && (!job.startBefore || now < Date.parse(job.startBefore));
}

/**
 * Launch one reserved request now. Every check that can refuse happens before
 * the dispatch mark. After it, a proven no-start verdict is persisted for
 * reconciliation; unknown outcomes retain their fence and are never retried.
 */
async function launch(id, actor, { expectedRevision, start } = {}) {
  const job = await queue.get(id);
  const starter = startable(job);
  if (!Number.isInteger(expectedRevision)) throw fail('expectedRevision required');
  if (expectedRevision !== job.revision) throw fail('Request changed; read its current revision', 409, 'HEAVY_QUEUE_STALE');
  await evidence.preDispatch(job);
  const begun = await queue.begin(id, { expectedRevision: job.revision }, actor);
  let operationId;
  try {
    await queue.assertDispatch(id, begun.dispatchId);
    const result = await starter.start(begun, start);
    operationId = starter.operationId(result);
    if (typeof operationId !== 'string' || !operationId) throw new Error(`${starter.name} returned no receipt identity`);
    return await queue.record(id, { dispatchId: begun.dispatchId, state: 'running', operationId }, actor);
  } catch (error) {
    const reason = String(error.message || error).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 900) || 'Launch refused';
    if (error.notStarted === true) {
      // The executor proved nothing reached the native runner: release the
      // fence with Core's own receipt instead of leaving it uncertain.
      let released = false;
      try {
        await queue.refused(id, { dispatchId: begun.dispatchId, code: String(error.code || 'LAUNCH_REFUSED').slice(0, 100), reason }, actor, 'core-launch-refusal');
        released = (await evidence.reconcile(id, actor)).state === 'failed';
      } catch {
        // A lost settlement reply may still have released this exact receipt.
        try { const current = await queue.get(id); released = current.state === 'failed' && current.launchRefusal?.dispatchId === begun.dispatchId; }
        catch { /* Fall back to an uncertain fence below. */ }
      }
      if (released) throw fail(`Request ${id} did not start: ${reason}`, 409, error.code || 'HEAVY_QUEUE_LAUNCH_REFUSED');
    }
    // The native producer may have stored its refusal before its HTTP reply
    // was lost. Observe that exact dispatch instead of overwriting it.
    const current = await queue.get(id).catch(() => null);
    if (current?.dispatchId === begun.dispatchId && current.state === 'failed' && current.launchRefusal?.dispatchId === begun.dispatchId) {
      throw fail(`Request ${id} did not start: ${current.launchRefusal.reason}`, 409, current.launchRefusal.code);
    }
    // A started profile or build is found again by its queue request identity;
    // leave the dispatch mark for the observer instead of declaring it uncertain.
    if (!operationId) {
      try {
        await queue.record(id, { dispatchId: begun.dispatchId, state: 'uncertain',
          reason: `Launch outcome unknown: ${reason}. Check the ${starter.name} before recovering this request; it is not retried.` }, actor);
      } catch { /* The durable dispatch mark still fences the resources. */ }
    }
    throw fail(`Request ${id} needs reconciliation: ${reason}`, 409, 'HEAVY_QUEUE_LAUNCH_UNCERTAIN');
  }
}

/** Launch every reserved request whose owner opted in and whose slot is open. */
async function dispatchDue({ now = Date.now(), start } = {}) {
  const current = await queue.list();
  const due = (current?.jobs || [])
    .filter(job => job.reservation?.autoStart === true && queue.autoStartable(job) && windowOpen(job, now))
    .sort((a, b) => a.reservation.start.localeCompare(b.reservation.start) || a.priority - b.priority);
  const launched = [];
  for (const job of due) {
    try { launched.push(await launch(job.id, AUTO_ACTOR, { expectedRevision: job.revision, start })); }
    catch (error) {
      // Refusals before the mark (busy resources, changed host) retry on the
      // next sweep while the window stays open; uncertain launches do not.
      logger.warn('Automatic heavy-work start did not launch', { queueRequestId: job.id, code: error.code || 'LAUNCH_REFUSED', error: error.message });
    }
  }
  return launched;
}

module.exports = { launch, dispatchDue, windowOpen, AUTO_ACTOR };
