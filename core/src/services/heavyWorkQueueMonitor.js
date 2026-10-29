'use strict';

const mongoose = require('mongoose');
const queue = require('./heavyWorkQueueService');
const evidence = require('./heavyWorkQueueEvidence');
const logger = require('../../config/logger');
let timer;
let codingTimer;
let busy = false;

// Observe existing receipts and dispatch only images explicitly accepted by
// the image service, within their bounded start window, and Profiler requests
// whose owner opted in to an automatic start when reserving their slot. Never
// replay a crossed dispatch fence or launch a Benchmark/operator request.
async function sweep() {
  if (busy || mongoose.connection.readyState !== 1) return;
  busy = true;
  try {
    try { await require('./pipelineReportModelRecovery').observe(); }
    catch (error) { logger.warn('Report native receipts await reconciliation', { code: error.code || 'REPORT_RECEIPTS_UNAVAILABLE' }); }
    try { await require('./images/imageService').dispatchQueued(); }
    catch (error) { logger.warn('Image dispatcher unavailable; other queue receipts remain observable', { code: error.code || 'IMAGE_QUEUE_UNAVAILABLE' }); }
    try { await require('./transcriptionService').sweep(); }
    catch (error) { logger.warn('Transcription planning awaits reconciliation', { code: error.code }); }
    try { await require('./heavyWorkQueueLauncher').dispatchDue(); }
    catch (error) { logger.warn('Automatic starts unavailable; reserved requests wait', { code: error.code || 'AUTO_START_UNAVAILABLE' }); }
    const current = await queue.list();
    // Lane overflow refusals name the next pooled window (#360).
    try { await require('./runtimeTopologyWindow').refreshWindows(); }
    catch (error) { logger.debug('Topology windows unavailable', { code: error.code || 'TOPOLOGY_WINDOWS_UNAVAILABLE' }); }
    for (const job of current?.jobs || []) {
      if (!['dispatching', 'running', 'uncertain'].includes(job.state)) continue;
      try { await evidence.reconcile(job.id, 'core-queue-observer'); }
      catch (error) {
        // Missing evidence stays fenced. Do not turn it into an inferred
        // completion, and do not overwrite the launch owner's receipt.
        logger.debug('Heavy queue awaits executor evidence', { queueRequestId: job.id, code: error.code || 'EVIDENCE_UNAVAILABLE' });
      }
    }
    await require('./heavyWorkQueueNotifications').publishJobs((await queue.list())?.jobs || []);
  } catch (error) { logger.warn('Heavy queue observation unavailable', { code: error.code || 'QUEUE_UNAVAILABLE' }); }
  finally { busy = false; }
}
function start() {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(sweep, 15000);
  timer.unref();
  codingTimer = setInterval(() => {
    require('./pipelineCodingAutonomyService').tick().catch(error =>
      logger.warn('Coding autonomy awaits reconciliation', { code: error.code || 'CODING_AUTONOMY_UNAVAILABLE' }));
    require('./pipelineReportContinuationService').tick().catch(error =>
      logger.warn('Report continuation awaits reconciliation', { code: error.code || 'REPORT_CONTINUATION_UNAVAILABLE' }));
  }, 15000);
  codingTimer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; if (codingTimer) clearInterval(codingTimer); codingTimer = null; }

module.exports = { start, stop, sweep };
