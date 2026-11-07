'use strict';
// Keeps the worker's resource receipt for one image operation. A figure is kept only
// when the receipt names this operation's job and passes its own consistency checks;
// nothing here estimates, completes or extrapolates a measurement. Durations come from
// the worker's clock and are never compared with Core's.
const CONTRACT = 'agentx.image-resources/v1';
const WORKER_CONTRACT = 'agentx.image-worker-resources/v1';
const MAX_RAM_KIB = 2 ** 34; // 16 TiB
const MAX_VRAM_MIB = 2 ** 20; // 1 TiB
const MAX_DURATION_MS = 7 * 86_400_000;
const OUTCOMES = ['matched', 'absent', 'failed', 'invalid'];
const SCOPE = 'cuda-child-process';
const count = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const reasonOf = raw => typeof raw?.reason === 'string' ? { reason: raw.reason.slice(0, 120) } : {};

function ram(raw) {
  const base = { scope: SCOPE, method: 'linux-proc-vmhwm' };
  if (raw?.status !== 'measured') return { ...base, status: raw?.status === 'invalid' ? 'invalid' : 'unavailable', ...reasonOf(raw) };
  return count(raw.peakKiB, MAX_RAM_KIB) && raw.peakKiB > 0 ? { ...base, status: 'measured', peakKiB: raw.peakKiB }
    : { ...base, status: 'invalid', reason: 'peak outside the accepted range' };
}

function vram(raw, child) {
  const base = { scope: SCOPE, method: 'nvidia-smi-compute-apps' };
  const samples = raw?.samples;
  if (!samples || !['attempted', ...OUTCOMES].every(key => count(samples[key]))
    || samples.attempted !== OUTCOMES.reduce((sum, key) => sum + samples[key], 0) || !count(raw.intervalMs, 60_000)) {
    return { ...base, status: 'invalid', reason: 'inconsistent sample counts' };
  }
  const kept = { ...base, intervalMs: raw.intervalMs, samples: Object.fromEntries(['attempted', ...OUTCOMES].map(key => [key, samples[key]])) };
  if (raw.status !== 'sampled') return { ...kept, status: 'unavailable', ...reasonOf(raw) };
  const { observedMaxMiB: max, firstMatchedAtMs: first, observedMaxAtMs: at, lastMatchedAtMs: last } = raw;
  // A sample outside its own child's lifetime is stale or forged: no figure is kept.
  const inside = [first, at, last].every(value => count(value))
    && child.readyAtMs <= first && first <= at && at <= last && last <= child.releasedAtMs;
  if (raw.bound !== 'lower' || !count(max, MAX_VRAM_MIB) || samples.matched < 1 || !inside) {
    return { ...kept, status: 'invalid', reason: 'sample outside its child lifetime or range' };
  }
  return { ...kept, status: 'sampled-lower-bound', observedMaxMiB: max,
    observedMaxAfterSpawnMs: at - child.spawnedAtMs, sampledSpanMs: last - first };
}

// released: the worker's /free answer. jobId: the exact prompt identity of this operation.
function normalize(released, jobId) {
  const receipt = released?.resources;
  if (!receipt || typeof receipt !== 'object') return { contract: CONTRACT, status: 'unavailable', reason: 'worker reported no resource receipt' };
  if (receipt.contract !== WORKER_CONTRACT) return { contract: CONTRACT, status: 'unavailable', reason: 'unsupported worker receipt' };
  const child = receipt.child || {};
  const ids = Array.isArray(child.jobIds) ? child.jobIds : [];
  if (typeof jobId !== 'string' || !ids.includes(jobId)) return { contract: CONTRACT, status: 'stale', reason: 'receipt belongs to another worker child' };
  const { spawnedAtMs: spawned, readyAtMs: ready, releasedAtMs: releasedAt } = child;
  if (![spawned, ready, releasedAt].every(value => count(value)) || spawned > ready || ready > releasedAt
    || releasedAt - spawned > MAX_DURATION_MS || ids.length > 32) {
    return { contract: CONTRACT, status: 'invalid', reason: 'inconsistent child lifetime' };
  }
  const job = Array.isArray(receipt.jobs) ? receipt.jobs.find(entry => entry?.jobId === jobId) : null;
  const reserve = child.reserveVramGiB;
  return { contract: CONTRACT, status: 'recorded',
    // Shared: the child also ran other prompts, so its RAM and VRAM figures cover all of them.
    attribution: ids.length === 1 ? 'exclusive' : 'shared-child',
    child: { jobCount: ids.length, startupMs: ready - spawned, lifetimeMs: releasedAt - spawned,
      ...(typeof reserve === 'number' && Number.isFinite(reserve) && reserve >= 0 && reserve <= 64 && { reserveVramGiB: reserve }) },
    executionMs: count(job?.executionMs, MAX_DURATION_MS) ? job.executionMs : null,
    ram: ram(receipt.ram), vram: vram(receipt.vram, child) };
}

// Core's own wall-clock phases: each phase lasts until the next one starts or the operation ends.
function phaseDurations(entries, end) {
  return Object.fromEntries(entries.map(([name, at], index) => [name, (entries[index + 1]?.[1] ?? end) - at]));
}

module.exports = { normalize, phaseDurations, CONTRACT, WORKER_CONTRACT };
