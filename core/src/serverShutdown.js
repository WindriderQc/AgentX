'use strict';

// Cover the default ten-minute inference attempt and final receipts.
// Compose grants eleven minutes; a hung shutdown exits nonzero before SIGKILL.
const SHUTDOWN_TIMEOUT_MS = 630_000;
// After the drain the listener is closed and Core serves nothing, so a leaked
// handle must not keep the dead process for the rest of the deadline (#105).
const POST_DRAIN_LINGER_MS = 15_000;

function activeResourceSummary(processRef) {
  const counts = {};
  for (const type of processRef.getActiveResourcesInfo?.() || []) counts[type] = (counts[type] || 0) + 1;
  return counts;
}

function createServerShutdown({ stop, close, drain, flush, disconnect, logger,
  timeoutMs = SHUTDOWN_TIMEOUT_MS, lingerMs = POST_DRAIN_LINGER_MS, processRef = process }) {
  let stopping = false;
  let pending = null;

  function run(signal) {
    if (pending) return pending;
    stopping = true;
    logger.info('Core shutdown started', { signal });
    const deadline = setTimeout(() => {
      logger.error('Core shutdown exceeded its deadline');
      processRef.exit(1);
    }, timeoutMs);
    deadline.unref();

    // Invoke every stop immediately, before yielding back to timers. Closing
    // the listener and stopping producers must precede draining their work.
    const invoke = (operation) => {
      try { return Promise.resolve(operation()); }
      catch (error) { return Promise.reject(error); }
    };
    const producers = invoke(stop);
    const listener = invoke(close);
    pending = (async () => {
      const results = await Promise.allSettled([producers, listener]);
      results.push(...await Promise.allSettled([invoke(drain)]));
      // Receipts and telemetry still need Mongo while requests are draining.
      results.push(...await Promise.allSettled([invoke(flush)]));
      results.push(...await Promise.allSettled([invoke(disconnect)]));
      const failures = results.filter(result => result.status === 'rejected');
      for (const failure of failures) {
        logger.error('Core shutdown cleanup failed', { error: failure.reason?.message });
      }
      processRef.exitCode = failures.length ? 1 : 0;
      logger.info('Core shutdown drained', { failed: failures.length });
      // Do not force a successful exit: unowned live handles must remain
      // visible. They are named in the log and the exit is nonzero, but only
      // after a short linger, never the whole deadline.
      const linger = setTimeout(() => {
        logger.error('Core shutdown left live handles after drain', { resources: activeResourceSummary(processRef) });
        processRef.exit(1);
      }, lingerMs);
      linger.unref();
    })();
    return pending;
  }

  return { get stopping() { return stopping; }, run };
}

module.exports = { createServerShutdown, SHUTDOWN_TIMEOUT_MS, POST_DRAIN_LINGER_MS };
