'use strict';

/**
 * Operator cancel of a running profile, with proof that Ollama stopped.
 *
 * A cancel that waits for the next checkpoint can take a whole CPU context
 * sample (minutes). When the in-flight request is a direct Ollama JSON request
 * whose model was already resident at the request's context, the cancel
 * aborts it instead and the run journal waits for a stop proof from /api/ps.
 *
 * /api/ps lists no requests, but each runner's `expires_at` is set by Ollama's
 * scheduler only when its last request ends (a runner loaded for the request
 * reports a value recomputed on every read until then). So the aborted request
 * has ended when, after the settle window, two /api/ps samples are identical
 * and the model either shows an `expires_at` different from the sample taken
 * just before the abort, or is no longer loaded (its runner was unloaded).
 * This is stronger than Core's caller-abort release, which relies on the same
 * connection-close cancellation and two identical samples.
 *
 * Without that proof within the budget the request stays UNKNOWN and the host
 * quarantined, as before. Any other in-flight request (streaming, Core-routed
 * or not yet resident) is not aborted: the cancel lands at the next checkpoint.
 *
 * The same tracker owns the deadline of such a request: when it expires, it
 * samples /api/ps, aborts the request and the run journal takes the same stop
 * proof. A proven stop makes the timed-out request terminal and the profile
 * continues; otherwise it stays UNKNOWN. The client's own timeout is extended
 * by a backstop so this deadline fires first.
 */

const { listRunning } = require('../../clients/ollamaClient');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');

const CONTRACT = 'agentx.profile-cancel-abort/v1';
const DEFAULTS = { budgetMs: 60_000, settleMs: 15_000, sampleGapMs: 5_000, backstopMs: 15_000 };

function envMs(raw, fallback, minimum) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function cancelledError() {
  return Object.assign(new Error('Profile cancelled by the operator'), { code: 'PROFILE_CANCELLED' });
}

function deadlineError(timeoutMs) {
  return Object.assign(new Error(`Ollama request timed out after ${timeoutMs}ms`),
    { code: 'ETIMEDOUT', transportFailure: true, deadlineAbort: true });
}

const modelOf = entry => entry?.name || entry?.model || null;
const findModel = (models, name) => (models || []).find(entry => isSameOllamaModel(modelOf(entry), name)) || null;
const residentAt = (entry, numCtx) => Boolean(entry) && (!Number.isSafeInteger(numCtx) || entry.context_length === numCtx);

function psSignature(models) {
  return JSON.stringify((Array.isArray(models) ? models : [])
    .map(m => [modelOf(m), m.digest || null, m.size_vram ?? null, m.context_length ?? null, m.expires_at || null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

async function readModels(hostUrl) {
  const data = await listRunning(hostUrl, { timeoutMs: 5_000 });
  return Array.isArray(data?.models) ? data.models : null;
}

function createProfileCancellation({
  hostUrl,
  parentSignal = null,
  readPs = readModels,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  budgetMs = envMs(process.env.PROFILE_CANCEL_PROOF_BUDGET_MS, DEFAULTS.budgetMs, 10_000),
  settleMs = envMs(process.env.PROFILE_CANCEL_SETTLE_MS, DEFAULTS.settleMs, 5_000),
  sampleGapMs = DEFAULTS.sampleGapMs,
  backstopMs = DEFAULTS.backstopMs
} = {}) {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  let requestedAt = null;
  let inFlight = null;
  let abort = null;
  let phase = null;

  const status = () => {
    const cancelAbort = abort?.trigger === 'cancel' ? abort : null;
    return {
      phase,
      requestedAt,
      abortedAt: cancelAbort?.abortedAt ?? null,
      proofDeadlineAt: cancelAbort ? cancelAbort.abortedAt + budgetMs : null,
      remainingMs: cancelAbort ? Math.max(0, cancelAbort.abortedAt + budgetMs - now()) : null,
      budgetMs
    };
  };

  async function proveStopped() {
    const { request, baseline, abortedAt } = abort;
    const before = findModel(baseline, request.model);
    const evidence = { contract: CONTRACT, trigger: abort.trigger, model: request.model, numCtx: request.numCtx ?? null,
      requestedAt, abortedAt, settleMs, sampleGapMs, budgetMs, timeoutMs: request.timeoutMs ?? null,
      baseline: before ? { expiresAt: before.expires_at || null, contextLength: before.context_length ?? null,
        size: before.size ?? null, sizeVram: before.size_vram ?? null } : null };
    if (!Array.isArray(baseline) || !residentAt(before, request.numCtx)) {
      const when = abort.trigger === 'deadline' ? 'the request deadline expired' : 'the cancel arrived';
      return { proven: false, evidence, reason: `The model was not resident at the request context when ${when}; a load may still be running` };
    }
    const deadline = abortedAt + budgetMs;
    let previous = null;
    let samples = 0;
    for (;;) {
      const models = await readPs(hostUrl).catch(() => null);
      samples += 1;
      if (Array.isArray(models) && previous && psSignature(models) === psSignature(previous)
        && now() - abortedAt >= settleMs) {
        const after = findModel(models, request.model);
        const outcome = !after ? 'runner_unloaded'
          : residentAt(after, request.numCtx) && after.expires_at && after.expires_at !== before.expires_at ? 'expiry_refreshed'
            : null;
        if (outcome) {
          return { proven: true, receipt: { ...evidence, outcome, samples, provenAt: now(),
            after: after ? { expiresAt: after.expires_at, contextLength: after.context_length ?? null } : null,
            psSignature: psSignature(models) } };
        }
      }
      previous = Array.isArray(models) ? models : null;
      if (now() + sampleGapMs > deadline) break;
      await sleep(sampleGapMs);
    }
    return { proven: false, evidence: { ...evidence, samples },
      reason: `Ollama did not show the aborted request ending within ${Math.round(budgetMs / 1000)} s` };
  }

  const disarm = target => { if (target?.timer) clearTimeout(target.timer); };
  // A request that ended (answered, or proven stopped after its deadline) frees the tracker.
  const settle = ticket => {
    if (inFlight?.ticket === ticket) { disarm(inFlight); inFlight = null; }
    if (abort?.trigger === 'deadline' && abort.ticket === ticket) abort = null;
  };
  const requestOf = target => ({ model: target.model, numCtx: target.numCtx, timeoutMs: target.timeoutMs });

  // The request deadline expired: sample /api/ps, then abort only that request.
  async function expire(target) {
    if (inFlight !== target || abort) return;
    const baseline = await readPs(hostUrl).catch(() => null);
    if (inFlight !== target || abort) return;
    abort = { trigger: 'deadline', ticket: target.ticket, request: requestOf(target), baseline, abortedAt: now() };
    target.controller.abort(deadlineError(target.timeoutMs));
  }

  return {
    signal,
    get requested() { return requestedAt !== null; },
    status,
    /** The run journal reports each dispatched request and its settlement. */
    track(ticket, request) {
      disarm(inFlight);
      inFlight = { ticket, ...(request || {}) };
      const target = inFlight;
      if (!target.abortable || !target.model || !(target.timeoutMs > 0)) return;
      target.controller = new AbortController();
      target.timer = setTimeout(() => { expire(target).catch(() => {}); }, target.timeoutMs);
      target.timer.unref?.();
    },
    /** Signal and client backstop for a request whose deadline this tracker owns. */
    requestControl(ticket) {
      const target = inFlight?.ticket === ticket ? inFlight : null;
      return target?.controller ? { signal: target.controller.signal, timeoutMs: target.timeoutMs + backstopMs } : null;
    },
    disarm(ticket) { if (inFlight?.ticket === ticket) disarm(inFlight); },
    settle,
    assertNotCancelled() { if (requestedAt !== null) throw cancelledError(); },
    isAbortedTicket: ticket => abort?.trigger === 'cancel' && abort.ticket === ticket,
    isExpiredTicket: ticket => abort?.trigger === 'deadline' && abort.ticket === ticket,
    async cancel() {
      if (requestedAt !== null) return status();
      requestedAt = now();
      phase = 'checkpoint';
      const target = inFlight;
      // A request already aborted at its deadline gets its own stop proof first.
      if (!target?.abortable || !target.model || abort) return status();
      const baseline = await readPs(hostUrl).catch(() => null);
      // The request may have ended during the sample; the checkpoint stops the run.
      if (inFlight !== target || abort) return status();
      disarm(target);
      abort = { trigger: 'cancel', ticket: target.ticket, request: requestOf(target), baseline, abortedAt: now() };
      phase = 'awaiting_stop_proof';
      controller.abort(cancelledError());
      return status();
    },
    async resolveAbort() {
      const current = abort;
      const result = await proveStopped();
      if (current.trigger === 'deadline') {
        // A proven stop ends this request only; the tracker is ready for the next.
        if (result.proven) settle(current.ticket);
        return result;
      }
      phase = result.proven ? 'stopped' : 'stop_unproven';
      return result;
    }
  };
}

module.exports = { createProfileCancellation, psSignature, PROFILE_CANCEL_CONTRACT: CONTRACT };
