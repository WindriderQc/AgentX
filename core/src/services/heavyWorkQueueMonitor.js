'use strict';

const mongoose = require('mongoose');
const queue = require('./heavyWorkQueueService');
const evidence = require('./heavyWorkQueueEvidence');
const logger = require('../../config/logger');
let timer;
let busy = false;

// Observe existing receipts and dispatch only images explicitly accepted by
// the image service, within their bounded start window. Never replay a crossed
// dispatch fence or launch a Benchmark/operator request automatically.
async function sweep() {
  if (busy || mongoose.connection.readyState !== 1) return;
  busy = true;
  try {
    try { await require('./images/imageService').dispatchQueued(); }
    catch (error) { logger.warn('Image dispatcher unavailable; other queue receipts remain observable', { code: error.code || 'IMAGE_QUEUE_UNAVAILABLE' }); }
    const current = await queue.list();
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
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, sweep };
