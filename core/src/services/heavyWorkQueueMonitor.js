'use strict';

const mongoose = require('mongoose');
const queue = require('./heavyWorkQueueService');
const evidence = require('./heavyWorkQueueEvidence');
const logger = require('../../config/logger');
let timer;
let attentionTimer;
let attentionBusy = false;
let codingTimer;
let transcriptionHeartbeatTimer;
let transcriptionConnectedListener;
let busy = false;

// Launch/evidence RPCs can consume minutes. Their pending replies must not
// delay the inbox and Telegram request for a missing receipt.
async function attentionTick() {
  if (attentionBusy || mongoose.connection.readyState !== 1) return;
  attentionBusy = true;
  try { await require('./heavyWorkQueueNotifications').publishJobs((await queue.list())?.jobs || []); }
  catch (error) { logger.warn('Heavy queue attention unavailable', { code: error.code || 'QUEUE_UNAVAILABLE' }); }
  finally { attentionBusy = false; }
}

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
    try { await require('./householdPlantImportQueue').sweep(); }
    catch (error) { logger.warn('Plant import identification awaits reconciliation', { code: error.code }); }
    try { await require('./photos/photoProcessingQueue').sweep(); }
    catch (error) { logger.warn('Verified photo processing awaits reconciliation', { code: error.code }); }
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
        // A previously attached native receipt that disappears must not hide
        // behind a multi-hour execution estimate. External operator/island
        // jobs have their own observer and terminal receipt protocol.
        if (job.state === 'running' && !['operator', 'island'].includes(job.executor?.mode)) {
          await queue.record(job.id, { dispatchId: job.dispatchId, state: 'uncertain',
            reason: 'Native receipt is unavailable; reconcile this original operation before any replacement launch.' }, 'core-queue-observer').catch(() => {});
        }
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
  attentionTimer = setInterval(attentionTick, 15000);
  attentionTimer.unref();
  void attentionTick();
  const renewTranscriptions = () => {
    if (mongoose.connection.readyState !== 1) return;
    require('./transcriptionExecutor').heartbeatActive().catch(error =>
      logger.warn('Transcription admission heartbeat awaits reconciliation', { code: error.code || 'HEARTBEAT_UNAVAILABLE' }));
  };
  transcriptionConnectedListener = renewTranscriptions;
  mongoose.connection.on('connected', transcriptionConnectedListener);
  renewTranscriptions();
  transcriptionHeartbeatTimer = setInterval(renewTranscriptions, 20000);
  transcriptionHeartbeatTimer.unref();
  codingTimer = setInterval(() => {
    require('./pipelineCodingAutonomyService').tick().catch(error =>
      logger.warn('Coding autonomy awaits reconciliation', { code: error.code || 'CODING_AUTONOMY_UNAVAILABLE' }));
    require('./pipelineReportContinuationService').tick().catch(error =>
      logger.warn('Report continuation awaits reconciliation', { code: error.code || 'REPORT_CONTINUATION_UNAVAILABLE' }));
  }, 15000);
  codingTimer.unref();
}
function stop() { if (transcriptionConnectedListener) mongoose.connection.off('connected', transcriptionConnectedListener); transcriptionConnectedListener = null; if (transcriptionHeartbeatTimer) clearInterval(transcriptionHeartbeatTimer); transcriptionHeartbeatTimer = null; if (timer) clearInterval(timer); timer = null; if (attentionTimer) clearInterval(attentionTimer); attentionTimer = null; if (codingTimer) clearInterval(codingTimer); codingTimer = null; }

module.exports = { start, stop, sweep, attentionTick };
