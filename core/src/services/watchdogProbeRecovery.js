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
 *     no maintenance lease or unrelated workload covering it. A Benchmark
 *     workload may remain only after its exact owner closes new dispatch on
 *     this host and all quarantines belong to that workload generation;
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
 * window applies, as for a probe. Core's own deadline abort has the same
 * recovery evidence and a distinct origin. Under a draining Benchmark parent,
 * both aborts always require the full settle window before exact restoration.
 * On a host a Benchmark workload holds as shared (a judge-only host), its own
 * aborts follow the ordinary caller-abort rule instead: the host has no claim
 * to drain, and the models resident there serve other callers.
 *
 * A runtime disconnect (origin `runtime-disconnect`: the runtime end closed
 * the connection of a dispatched request that Core had not aborted) is the
 * ordinary sign of a runtime that died or was restarted. It is released on the
 * same two samples, always after the full settle window: the release rests on
 * a quiet runtime, not on an observed restart. It may also sit under a
 * Benchmark workload whose owner is gone (its lease ended, so it dispatches
 * nothing more); the workload itself stays quarantined for its own recovery.
 * A lost heartbeat or a bridge quarantine has no origin and keeps the operator
 * attestation.
 */

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const { exactParentForHost, parentPredicate } = require('./benchmarkCallerAbortDrain');

const PROBE_KIND = 'watchdog-probe';
const PROBE_PRINCIPAL = 'core-watchdog';
const RECEIPT_CONTRACT = 'agentx.watchdog-probe-recovery/v1';
const CALLER_ABORT_ORIGIN = 'caller-abort';
const CALLER_ABORT_CONTRACT = 'agentx.caller-abort-recovery/v1';
const DEADLINE_ABORT_ORIGIN = 'deadline-abort';
const DEADLINE_ABORT_CONTRACT = 'agentx.inference-deadline-recovery/v1';
const RUNTIME_DISCONNECT_ORIGIN = 'runtime-disconnect';
const RUNTIME_DISCONNECT_CONTRACT = 'agentx.runtime-disconnect-recovery/v1';
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
const isCallerAbort = entry => [CALLER_ABORT_ORIGIN, DEADLINE_ABORT_ORIGIN].includes(entry.unknownOrigin);
const isDisconnect = entry => entry.unknownOrigin === RUNTIME_DISCONNECT_ORIGIN;
const isSettleable = entry => isCallerAbort(entry) || isDisconnect(entry);
const contractFor = entry => (isProbe(entry) ? RECEIPT_CONTRACT : isDisconnect(entry) ? RUNTIME_DISCONNECT_CONTRACT
  : entry.unknownOrigin === DEADLINE_ABORT_ORIGIN ? DEADLINE_ABORT_CONTRACT : CALLER_ABORT_CONTRACT);

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
  const probes = onHost.filter(entry => entry.state === 'UNKNOWN' && (isProbe(entry) || isSettleable(entry)));
  if (probes.length === 0) return { recovered: false, reason: 'no quarantined watchdog probe or caller abort' };
  if (probes.length !== onHost.length) return { recovered: false, reason: 'other inference on host' };
  if (state.maintenance) return { recovered: false, reason: 'maintenance lease present' };
  const hasWorkload = (state.workloads || []).some(w => (w.hosts || []).includes(hostUrl));
  const ownedAborts = hasWorkload && probes.every(isCallerAbort);
  const drainingParent = ownedAborts ? exactParentForHost(state, hostUrl, probes, { draining: true }) : null;
  // A host the batch only shares (its judge host) carries no claim, so nothing
  // ever closes dispatch on it: without this it stays fenced until the whole
  // workload ends, and its resident models stop serving everyone else.
  const sharedParent = ownedAborts && !drainingParent
    ? exactParentForHost(state, hostUrl, probes, { shared: true }) : null;
  // A workload whose owner lease ended dispatches nothing more: its recovery
  // worker only restores hosts, and that waits for these quarantines.
  const ownerGone = w => new Date(w.expiresAt).getTime() <= now();
  const goneParent = hasWorkload && !drainingParent && !sharedParent && probes.every(isSettleable)
    ? [exactParentForHost(state, hostUrl, probes)].find(w => w && ownerGone(w)) || null : null;
  const parent = drainingParent || sharedParent || goneParent;
  if (hasWorkload && !parent) {
    return { recovered: false, reason: 'workload covers host' };
  }
  const quarantinedFor = p => (p.unknownAt ? now() - new Date(p.unknownAt).getTime() : -1);
  // A batch can also issue direct runtime warmups on a host it reserves. Its
  // drained Core callers there always use the full loading/cancellation
  // window, even resident. On a shared host every batch call goes through
  // Core, so an abort there follows the ordinary caller-abort rule.
  const minimumWindow = p => (isProbe(p) || isDisconnect(p) || drainingParent || goneParent
    ? settleMs : Math.min(settleMs, abortSettleMs));
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
    contract: contractFor(p), coordinationKind: 'inference', released: true,
    ...(!isProbe(p) && { unknownOrigin: p.unknownOrigin, quarantinedForMs: quarantinedFor(p), residentAtRequest: settledAbort(p) }),
    admissionId: p.admissionId, generation: p.generation, principal: p.principal,
    host: p.host, model: p.model, kind: p.kind, mode: p.mode,
    residencyKey: p.residencyKey, residencySpec: p.residencySpec,
    acquiredAt: p.acquiredAt, unknownAt: p.unknownAt, unknownReason: p.unknownReason,
    evidence, releasedAt,
    ...(parent && { parentWorkload: { admissionId: parent.admissionId,
      generation: parent.generation, workloadId: parent.workloadId, ...(sharedParent && { sharedHost: true }) } }),
  }));
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      maintenance: null,
      workloads: parent
        ? { $elemMatch: { ...parentPredicate(parent, hostUrl),
          ...(sharedParent ? { sharedHosts: hostUrl } : goneParent
            ? { expiresAt: { $lte: new Date(now()) } } : { drainingHosts: hostUrl }) } }
        : { $not: { $elemMatch: { hosts: hostUrl } } },
      $and: [
        ...(parent ? [{ workloads: { $not: { $elemMatch: {
          hosts: hostUrl, admissionId: { $ne: parent.admissionId }
        } } } }] : []),
        ...probes.map(p => ({ inferences: { $elemMatch: {
          admissionId: p.admissionId, generation: p.generation, state: 'UNKNOWN',
          host: hostUrl, principal: p.principal,
          ...(isProbe(p) ? { kind: PROBE_KIND } : { unknownOrigin: p.unknownOrigin }),
          ...(parent && { workloadAdmissionId: parent.admissionId, workloadGeneration: parent.generation }),
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
    if (unknown.length && unknown.every(item => item.kind === PROBE_KIND || isSettleable(item))
      && !coordination.maintenance) {
      const result = await recoverSettledWatchdogProbes(host.url, { readPs, ...(now && { now }), ...(sleep && { sleep }) })
        .catch(error => ({ recovered: false, reason: error.message }));
      if (result.recovered) {
        const contracts = result.released.map(r => r.contract);
        recordEvent(contracts.includes(RUNTIME_DISCONNECT_CONTRACT) ? 'runtime_disconnect_recovered'
          : contracts.some(c => [CALLER_ABORT_CONTRACT, DEADLINE_ABORT_CONTRACT].includes(c))
            ? 'caller_abort_recovered' : 'probe_recovered', host,
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
