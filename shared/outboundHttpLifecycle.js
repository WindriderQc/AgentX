'use strict';

const { OUTBOUND_ERROR_CODES, outboundError } = require('./outboundHttpErrors');
const { isAbortSignal } = require('./outboundHttpPolicy');

function createLifecycle(policy, initialCallerSignal) {
  const controller = new AbortController();
  let abortCode = null;
  let abortCleanup = null;
  let closed = false;
  const callerListeners = [];
  let resolveAbort;
  const abortPromise = new Promise((resolve) => {
    resolveAbort = resolve;
  });

  const abort = (code) => {
    if (closed || abortCode) return false;
    abortCode = code;
    // Never propagate a caller-controlled AbortSignal reason into the request
    // or into an error: reasons may contain addresses or credentials.
    controller.abort();
    resolveAbort(code);
    if (abortCleanup) {
      Promise.resolve().then(abortCleanup).catch(() => {});
    }
    return true;
  };

  const addCallerSignal = (callerSignal) => {
    if (!isAbortSignal(callerSignal)) {
      throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, policy.sinkId);
    }
    if (!callerSignal || closed || abortCode
      || callerListeners.some(([registered]) => registered === callerSignal)) return;
    if (callerSignal.aborted) {
      abort(OUTBOUND_ERROR_CODES.CALLER_ABORTED);
      return;
    }
    const onCallerAbort = () => abort(OUTBOUND_ERROR_CODES.CALLER_ABORTED);
    try {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      callerListeners.push([callerSignal, onCallerAbort]);
    } catch {
      try {
        callerSignal.removeEventListener('abort', onCallerAbort);
      } catch {
        // The signal-like object is invalid; no further cleanup is possible.
      }
      throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, policy.sinkId);
    }
  };

  addCallerSignal(initialCallerSignal);

  const timer = abortCode
    ? null
    : setTimeout(() => abort(OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED), policy.deadlineMs);
  // A stalled authority, transport, or response body may own no event-loop
  // handles of its own. Keep this timer referenced so the promised deadline
  // remains enforceable even when it is the operation's only live handle.

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    for (const [callerSignal, onCallerAbort] of callerListeners.splice(0)) {
      try {
        callerSignal.removeEventListener('abort', onCallerAbort);
      } catch {
        // A caller-provided signal-like object cannot prevent timer cleanup.
      }
    }
    abortCleanup = null;
  };

  const throwIfAborted = () => {
    if (abortCode) throw outboundError(abortCode, policy.sinkId);
  };

  const race = async (work) => {
    throwIfAborted();
    const settledWork = Promise.resolve(work).then(
      (value) => ({ type: 'value', value }),
      (error) => ({ type: 'error', error })
    );
    const result = await Promise.race([
      settledWork,
      abortPromise.then((code) => ({ type: 'abort', code })),
    ]);
    if (result.type === 'abort') throw outboundError(result.code, policy.sinkId);
    if (result.type === 'error') throw result.error;
    return result.value;
  };

  const setAbortCleanup = (cleanup) => {
    abortCleanup = typeof cleanup === 'function' ? cleanup : null;
    if (abortCode && abortCleanup) {
      Promise.resolve().then(abortCleanup).catch(() => {});
    }
  };

  return Object.freeze({
    abort,
    addCallerSignal,
    close,
    race,
    setAbortCleanup,
    signal: controller.signal,
    throwIfAborted,
    get aborted() { return Boolean(abortCode); },
    get closed() { return closed; },
  });
}

module.exports = { createLifecycle };
