'use strict';

/**
 * Release of quarantined watchdog probes without an Ollama restart.
 *
 * A watchdog probe asks for one token (num_predict 1) with keep_alive -1. When
 * its deadline fires after dispatch, Core cannot know whether Ollama finished,
 * so the admission is quarantined (UNKNOWN) and blocks the host until an
 * operator proves a runtime restart. That is right for real generations, but
 * a probe's worst case is bounded: it can at most load its model resident.
 *
 * A probe is released only when all of this holds, checked atomically where it
 * concerns coordination state:
 *   - it is an UNKNOWN watchdog-probe owned by core-watchdog, quarantined for at
 *     least the settle window (longer than Ollama's model load timeout, so a
 *     queued or loading request has ended);
 *   - nothing else Core admitted touches the host: no other inference entry,
 *     no workload covering it, no maintenance lease;
 *   - two /api/ps samples taken apart are identical, and the probed model, if
 *     resident, runs at the probe's context. The probe then left no pending
 *     side effect beyond an already visible residency.
 * The receipt keeps the quarantine reason and the evidence.
 *
 * A caller abort (origin `caller-abort`: Core itself closed the upstream
 * connection after a client disconnect, a busy reply or a superseded turn) is
 * released on the same evidence. Ollama cancels a generation whose connection
 * closed, so the only lasting effect is a model load. When the requested model
 * is resident at the request's context in both samples, that load has ended
 * and the shorter caller-abort window suffices; otherwise the full settle
 * window applies, as for a probe.
 */

const RuntimeCoordination = require('../../models/RuntimeCoordination');

const PROBE_KIND = 'watchdog-probe';
const PROBE_PRINCIPAL = 'core-watchdog';
const RECEIPT_CONTRACT = 'agentx.watchdog-probe-recovery/v1';
const CALLER_ABORT_ORIGIN = 'caller-abort';
const CALLER_ABORT_CONTRACT = 'agentx.caller-abort-recovery/v1';
const DEFAULT_SETTLE_MS = 10 * 60_000;
const DEFAULT_CALLER_ABORT_SETTLE_MS = 60_000;
const DEFAULT_SAMPLE_GAP_MS = 5_000;

function settleWindowMs() {
  const parsed = Number(process.env.WATCHDOG_PROBE_RECOVERY_SETTLE_MS);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_SETTLE_MS;
}

function callerAbortSettleMs() {
  const parsed = Number(process.env.CALLER_ABORT_RECOVERY_SETTLE_MS);
  return Number.isFinite(parsed) && parsed >= 15_000 ? parsed : DEFAULT_CALLER_ABORT_SETTLE_MS;
}

const isProbe = entry => entry.kind === PROBE_KIND && entry.principal === PROBE_PRINCIPAL;
const isCallerAbort = entry => entry.unknownOrigin === CALLER_ABORT_ORIGIN;

function psSignature(models) {
  return JSON.stringify((Array.isArray(models) ? models : [])
    .map(m => [m.name || m.model || null, m.digest || null, m.size_vram ?? null,
      m.context_length ?? null, m.expires_at || null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function residencyMatches(models, probe) {
  const numCtx = probe.residencySpec?.runner?.num_ctx;
  const resident = (models || []).find(m => (m.name || m.model) === probe.model);
  return !resident || !Number.isSafeInteger(numCtx) || resident.context_length === numCtx;
}

/** The requested model is loaded at the request's own context: no load is pending. */
function residentAtRequest(models, entry) {
  const numCtx = entry.residencySpec?.runner?.num_ctx;
  const resident = (models || []).find(m => (m.name || m.model) === entry.model);
  return Boolean(resident) && (!Number.isSafeInteger(numCtx) || resident.context_length === numCtx);
}

/**
 * Try to release the quarantined watchdog probes and caller aborts on one host.
 * @param {string} hostUrl host as stored in coordination state
 * @param {object} deps readPs(hostUrl) -> models array; sleep(ms); now()
 * @returns {{ recovered: boolean, reason?: string, released?: object[] }}
 */
async function recoverSettledWatchdogProbes(hostUrl, {
  readPs,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  settleMs = settleWindowMs(),
  sampleGapMs = DEFAULT_SAMPLE_GAP_MS,
  abortSettleMs = callerAbortSettleMs(),
} = {}) {
  const state = await RuntimeCoordination.findById('runtime').lean();
  const onHost = (state?.inferences || []).filter(entry => entry.host === hostUrl);
  const probes = onHost.filter(entry => entry.state === 'UNKNOWN' && (isProbe(entry) || isCallerAbort(entry)));
  if (probes.length === 0) return { recovered: false, reason: 'no quarantined watchdog probe or caller abort' };
  if (probes.length !== onHost.length) return { recovered: false, reason: 'other inference on host' };
  if (state.maintenance) return { recovered: false, reason: 'maintenance lease present' };
  if ((state.workloads || []).some(w => (w.hosts || []).includes(hostUrl))) {
    return { recovered: false, reason: 'workload covers host' };
  }
  const quarantinedFor = p => (p.unknownAt ? now() - new Date(p.unknownAt).getTime() : -1);
  const minimumWindow = p => (isProbe(p) ? settleMs : Math.min(settleMs, abortSettleMs));
  if (probes.some(p => quarantinedFor(p) < minimumWindow(p))) {
    return { recovered: false, reason: 'settle window not elapsed' };
  }

  const first = await readPs(hostUrl);
  await sleep(sampleGapMs);
  const second = await readPs(hostUrl);
  if (!Array.isArray(first) || !Array.isArray(second) || psSignature(first) !== psSignature(second)) {
    return { recovered: false, reason: 'runtime not stable' };
  }
  if (!probes.every(p => residencyMatches(second, p))) {
    return { recovered: false, reason: 'probe residency mismatch' };
  }
  // A caller abort whose model is not visibly loaded at its context may still
  // be loading it: it waits for the full settle window.
  const settledAbort = p => residentAtRequest(first, p) && residentAtRequest(second, p);
  if (probes.some(p => !isProbe(p) && !settledAbort(p) && quarantinedFor(p) < settleMs)) {
    return { recovered: false, reason: 'settle window not elapsed' };
  }

  const ids = probes.map(p => p.admissionId);
  const releasedAt = new Date(now());
  const evidence = { settleMs, sampleGapMs, psSignature: psSignature(second) };
  const receipts = probes.map(p => ({
    contract: isProbe(p) ? RECEIPT_CONTRACT : CALLER_ABORT_CONTRACT, coordinationKind: 'inference', released: true,
    ...(!isProbe(p) && { unknownOrigin: CALLER_ABORT_ORIGIN, quarantinedForMs: quarantinedFor(p), residentAtRequest: settledAbort(p) }),
    admissionId: p.admissionId, generation: p.generation, principal: p.principal,
    host: p.host, model: p.model, kind: p.kind, mode: p.mode,
    residencyKey: p.residencyKey, residencySpec: p.residencySpec,
    acquiredAt: p.acquiredAt, unknownAt: p.unknownAt, unknownReason: p.unknownReason,
    evidence, releasedAt,
  }));
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      maintenance: null,
      workloads: { $not: { $elemMatch: { hosts: hostUrl } } },
      $and: [
        ...probes.map(p => ({ inferences: { $elemMatch: {
          admissionId: p.admissionId, generation: p.generation, state: 'UNKNOWN',
          ...(isProbe(p) ? { kind: PROBE_KIND, principal: PROBE_PRINCIPAL } : { unknownOrigin: CALLER_ABORT_ORIGIN }),
        } } })),
        { inferences: { $not: { $elemMatch: { host: hostUrl, admissionId: { $nin: ids } } } } },
      ],
    },
    {
      $pull: { inferences: { admissionId: { $in: ids } } },
      $push: { releaseReceipts: { $each: receipts, $slice: -100 } },
    },
    { new: false }
  ).lean();
  return updated
    ? { recovered: true, released: receipts }
    : { recovered: false, reason: 'coordination state changed' };
}

/**
 * The watchdog's per-cycle view of hosts that need recovery. Hosts whose only
 * quarantines are settled watchdog probes or caller aborts are released first.
 */
async function collectRecoveryRequired({ hosts, coordination, previous, target, recordEvent, readPs, now, sleep }) {
  for (const host of hosts) {
    let unknown = coordination.inferences.filter(item => item.quarantined && item.host === host.url);
    if (unknown.length && unknown.every(item => item.kind === PROBE_KIND || item.unknownOrigin === CALLER_ABORT_ORIGIN)
      && !coordination.maintenance) {
      const result = await recoverSettledWatchdogProbes(host.url, { readPs, ...(now && { now }), ...(sleep && { sleep }) })
        .catch(error => ({ recovered: false, reason: error.message }));
      if (result.recovered) {
        const aborts = result.released.filter(r => r.contract === CALLER_ABORT_CONTRACT);
        recordEvent(aborts.length ? 'caller_abort_recovered' : 'probe_recovered', host,
          { models: result.released.map(r => r.model) });
        unknown = [];
      }
    }
    if (unknown.length || coordination.maintenance?.quarantined) {
      const details = {
        reason: unknown.length ? 'inference_outcome_unknown' : 'maintenance_outcome_unknown',
        models: [...new Set(unknown.map(item => item.model))]
      };
      target.set(host.url, details);
      if (!previous.has(host.url)) recordEvent('recovery_required', host, details);
    }
  }
}

module.exports = {
  DEFAULT_CALLER_ABORT_SETTLE_MS,
  DEFAULT_SETTLE_MS,
  collectRecoveryRequired,
  psSignature,
  recoverSettledWatchdogProbes,
};
