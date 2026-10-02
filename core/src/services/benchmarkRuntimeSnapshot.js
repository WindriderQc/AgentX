'use strict';
/**
 * Benchmark runtime snapshot: drains in-flight inference, captures the exact
 * Ollama residency for a benchmark claim, and compares residents on restore.
 * Extracted verbatim from hostPreferenceService.js, which re-exports the
 * public names.
 */

const crypto = require('crypto');
const { isOllamaPermanentExpiry } = require('../../../shared/ollamaResidency');
const hostGate = require('./hostGate');
const { readLoadedContextLength, fetchRunningModelInfosStrict, sleep } = require('./hostPinPrimitives');

function benchmarkSnapshotKeepAlive(modelInfo, capturedAt) {
  const expiresAt = modelInfo?.expires_at || modelInfo?.expiresAt;
  const parsed = expiresAt ? new Date(expiresAt) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    const error = new Error(`Ollama did not expose an expiry for resident model ${modelInfo?.name || modelInfo?.model || 'unknown'}`);
    error.code = 'BENCHMARK_RUNTIME_SNAPSHOT_INCOMPLETE';
    throw error;
  }
  // Ollama represents an infinite keep-alive with a far-future timestamp.
  if (isOllamaPermanentExpiry(parsed, capturedAt)) return { keepAlive: -1, expiresAt: parsed };
  return {
    keepAlive: Math.max(1, Math.ceil((parsed.getTime() - capturedAt.getTime()) / 1000)),
    expiresAt: parsed
  };
}

function benchmarkRuntimeSnapshotIdentity(snapshot) {
  const residents = (snapshot?.residents || []).map(entry => ({
    model: entry.model,
    digest: entry.digest,
    artifactSize: Number(entry.artifactSize),
    sizeVram: Number(entry.sizeVram),
    contextLength: Number(entry.contextLength),
    keepAlive: Number(entry.keepAlive),
    expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null
  })).sort((left, right) => left.model.localeCompare(right.model));
  return crypto.createHash('sha256').update(JSON.stringify({
    capturedAt: snapshot?.capturedAt ? new Date(snapshot.capturedAt).toISOString() : null,
    source: snapshot?.source || null,
    exact: snapshot?.exact === true,
    residents
  })).digest('hex');
}

/**
 * Capture the exact observable Ollama residency for a benchmark claim.
 * Called only after Core has fenced the host, and before claim acquisition is
 * returned to Benchmark, so no profiler mutation can precede the snapshot.
 */
async function captureBenchmarkRuntime(hostUrl) {
  const drainTimeoutMs = Math.max(1_000, Number(process.env.BENCHMARK_CLAIM_DRAIN_TIMEOUT_MS) || 30_000);
  const drainDeadline = Date.now() + drainTimeoutMs;
  while (true) {
    while (await hostGate.hostHasInflightAnywhere(hostUrl)) {
      if (Date.now() >= drainDeadline) {
        const error = new Error(`Timed out draining in-flight inference on ${hostUrl} before benchmark snapshot`);
        error.code = 'BENCHMARK_HOST_DRAIN_TIMEOUT';
        throw error;
      }
      await sleep(50);
    }
    // One quiet interval closes the release-to-next-waiter transition:
    // requests admitted before the claim may move from queued to in-flight as
    // the prior request releases, but new requests fail the status fence.
    await sleep(50);
    if (!await hostGate.hostHasInflightAnywhere(hostUrl)) break;
    if (Date.now() >= drainDeadline) {
      const error = new Error(`Timed out draining in-flight inference on ${hostUrl} before benchmark snapshot`);
      error.code = 'BENCHMARK_HOST_DRAIN_TIMEOUT';
      throw error;
    }
  }
  const capturedAt = new Date();
  const running = await fetchRunningModelInfosStrict(hostUrl);
  const residents = running.map((entry) => {
    const model = entry?.name || entry?.model;
    if (!model) {
      const error = new Error('Ollama returned a resident model without an identity');
      error.code = 'BENCHMARK_RUNTIME_SNAPSHOT_INCOMPLETE';
      throw error;
    }
    const contextLength = readLoadedContextLength(entry);
    if (!contextLength) {
      const error = new Error(`Ollama did not expose context_length for resident model ${model}`);
      error.code = 'BENCHMARK_RUNTIME_SNAPSHOT_INCOMPLETE';
      throw error;
    }
    const digest = typeof entry?.digest === 'string' && entry.digest.trim()
      ? entry.digest.trim()
      : null;
    const artifactSize = Number(entry?.size ?? entry?.artifact_size ?? entry?.artifactSize);
    const sizeVram = Number(entry?.size_vram ?? entry?.sizeVram);
    if (!digest
      || !Number.isFinite(artifactSize) || artifactSize <= 0
      || !Number.isFinite(sizeVram) || sizeVram < 0) {
      const error = new Error(`Ollama did not expose digest/size/size_vram for resident model ${model}`);
      error.code = 'BENCHMARK_RUNTIME_SNAPSHOT_INCOMPLETE';
      throw error;
    }
    const expiry = benchmarkSnapshotKeepAlive(entry, capturedAt);
    return {
      model,
      digest,
      artifactSize,
      sizeVram,
      contextLength,
      keepAlive: expiry.keepAlive,
      expiresAt: expiry.expiresAt
    };
  });
  const snapshot = {
    capturedAt,
    source: 'ollama_ps',
    exact: true,
    residents,
    error: null
  };
  return { ...snapshot, identityDigest: benchmarkRuntimeSnapshotIdentity(snapshot) };
}

function desiredBenchmarkResidents(snapshot, now = Date.now()) {
  return (snapshot?.residents || []).filter((entry) => {
    if (Number(entry.keepAlive) === -1) return true;
    const expiry = entry.expiresAt ? new Date(entry.expiresAt).getTime() : NaN;
    return Number.isFinite(expiry) && expiry > now;
  });
}

function benchmarkResidentExpiryMatches(target, runningEntry, now = Date.now()) {
  const actualRaw = runningEntry?.expires_at || runningEntry?.expiresAt;
  const actual = actualRaw ? new Date(actualRaw) : null;
  if (!actual || !Number.isFinite(actual.getTime())) return false;
  const targetIsPermanent = Number(target.keepAlive) === -1
    || isOllamaPermanentExpiry(target.expiresAt, now);
  if (targetIsPermanent) return isOllamaPermanentExpiry(actual, now);
  const expected = target.expiresAt ? new Date(target.expiresAt).getTime() : NaN;
  if (!Number.isFinite(expected) || expected <= now) return false;
  // Ollama exposes second-resolution expiry and reload itself consumes time.
  return Math.abs(actual.getTime() - expected) <= 5_000;
}

module.exports = {
  benchmarkSnapshotKeepAlive,
  benchmarkRuntimeSnapshotIdentity,
  captureBenchmarkRuntime,
  desiredBenchmarkResidents,
  benchmarkResidentExpiryMatches
};
