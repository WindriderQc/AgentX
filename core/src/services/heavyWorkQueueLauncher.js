'use strict';

// Core launches a reserved Profiler request itself, either because the owner
// pressed "Run now" or because the owner opted in to an automatic start when
// planning its slot. Both paths cross the same durable dispatch fence as the
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
  const answer = await requestJson({ baseUrl: process.env.BENCHMARK_SERVICE_URL || 'http://localhost:3081',
    path: '/api/profiler/pipeline/profile-host', method: 'POST', body, timeoutMs: START_TIMEOUT_MS, serviceName: 'benchmark' });
  return answer?.data ?? answer;
}
function startable(job) {
  if (!queue.AUTO_START_KINDS.includes(job.kind) || !job.executor) {
    throw fail('Core launches Profiler requests only; use the request\'s own executor protocol', 409, 'HEAVY_QUEUE_LAUNCH_UNSUPPORTED');
  }
}
function windowOpen(job, now) {
  return job.state === 'reserved' && Date.parse(job.reservation?.start) <= now && now < Date.parse(job.reservation?.end)
    && (!job.startBefore || now < Date.parse(job.startBefore));
}

/**
 * Launch one reserved request now. Every check that can refuse happens before
 * the dispatch mark; after it, any failure leaves the request uncertain with
 * its reason, for the owner to reconcile, and is never retried here.
 */
async function launch(id, actor, { expectedRevision, start = startProfile } = {}) {
  const job = await queue.get(id);
  startable(job);
  if (!Number.isInteger(expectedRevision)) throw fail('expectedRevision required');
  if (expectedRevision !== job.revision) throw fail('Request changed; read its current revision', 409, 'HEAVY_QUEUE_STALE');
  await evidence.preDispatch(job);
  const begun = await queue.begin(id, { expectedRevision: job.revision }, actor);
  let operationId;
  try {
    await queue.assertDispatch(id, begun.dispatchId);
    const result = await start({ ...begun.executor, queueRequestId: begun.id });
    operationId = result?.queueId;
    if (typeof operationId !== 'string' || !operationId) throw new Error('Profiler returned no queue identity');
    return await queue.record(id, { dispatchId: begun.dispatchId, state: 'running', operationId }, actor);
  } catch (error) {
    const reason = String(error.message || error).slice(0, 900);
    // A started profile is found again by its queue request identity; leave
    // the dispatch mark for the observer instead of declaring it uncertain.
    if (!operationId) {
      try {
        await queue.record(id, { dispatchId: begun.dispatchId, state: 'uncertain',
          reason: `Launch outcome unknown: ${reason}. Check the Profiler before recovering this request; it is not retried.` }, actor);
      } catch { /* The durable dispatch mark still fences the resources. */ }
    }
    throw fail(`Request ${id} needs reconciliation: ${reason}`, 409, 'HEAVY_QUEUE_LAUNCH_UNCERTAIN');
  }
}

/** Launch every reserved request whose owner opted in and whose slot is open. */
async function dispatchDue({ now = Date.now(), start = startProfile } = {}) {
  const current = await queue.list();
  const due = (current?.jobs || [])
    .filter(job => job.reservation?.autoStart === true && queue.AUTO_START_KINDS.includes(job.kind) && windowOpen(job, now))
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
