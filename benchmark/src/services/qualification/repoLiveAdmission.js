'use strict';

const crypto = require('crypto');
const { exactModelNamesMatch } = require('../../../../shared/artifactIdentity');

function dependencies(overrides) {
  const client = require('../../clients/coreApiClient');
  const mongoose = require('mongoose');
  return {
    ...client,
    configuredCoreOrigin: client._internal.configuredCoreOrigin,
    connectDB: require('../../../config/db'),
    disconnectDB: () => mongoose.disconnect(),
    beginManagedWorkload: require('../benchmark/workloadAdmissionLifecycle').beginManagedWorkload,
    startHeartbeat: require('./toolCallCampaignRunner').startGuardedHeartbeat,
    ...overrides
  };
}

// Own the admission and exact claim, rather than borrowing another process's
// claim id. Core records each inference through generateWithWorkloadAdmission.
async function withRepoAdmission(args, operation, overrides = {}) {
  const deps = dependencies(overrides);
  if (new URL(args.core).origin !== deps.configuredCoreOrigin()) {
    throw new Error('--core must match the authenticated CORE_URL configuration');
  }
  const workloadId = args.claimId || `repo-coding:${crypto.randomUUID()}`;
  const ttlMs = Math.max(60_000, args.modelTimeoutMs + args.gradeTimeoutMs + 60_000);
  let workload, claim, heartbeat, connected = false;
  try {
    await deps.connectDB();
    connected = true;
    workload = await deps.beginManagedWorkload(workloadId, {
      requestId: workloadId, kind: 'benchmark', hosts: [args.host], ttlMs
    });
    const receipt = await deps.claimHostForBenchmark(args.host, workloadId, ttlMs,
      { source: 'repo-coding-qualification', owner: 'agentx-benchmark' });
    if (receipt?.claimed !== true) throw new Error(receipt?.reason || 'Host claim refused');
    claim = { hostUrl: args.host, batchId: workloadId,
      claimGeneration: receipt.claimGeneration || receipt.pref?.benchmarkClaim?.claimGeneration };
    if (!claim.claimGeneration) throw Object.assign(new Error('Exact claim generation missing'), { retainAdmission: true });
    heartbeat = deps.startHeartbeat(claim, ttlMs, deps);
    await heartbeat.ready;
    const session = {
      workloadId, signal: workload.signal,
      async assertActive() {
        workload.assertActive();
        heartbeat.assertActive();
        const claims = await deps.getBenchmarkClaims();
        if (!claims.some(row => row.hostUrl === args.host && row.batchId === workloadId
          && row.claimGeneration === claim.claimGeneration)) {
          throw Object.assign(new Error('Exact repository campaign claim was lost'), { retainAdmission: true });
        }
      }
    };
    await session.assertActive();
    const result = await operation(session);
    await session.assertActive();
    const released = await deps.releaseBenchmarkClaim(args.host, workloadId);
    if (released?.released !== true) throw Object.assign(new Error('Claim restoration not confirmed'), { retainAdmission: true });
    claim = null;
    await workload.complete();
    workload = null;
    return result;
  } catch (error) {
    if (workload && error.retainAdmission !== true) {
      try {
        if (claim) {
          const released = await deps.releaseBenchmarkClaim(args.host, workloadId);
          if (released?.released !== true) throw new Error('Claim restoration not confirmed');
          claim = null;
        }
        await workload.complete();
        workload = null;
      } catch (releaseError) {
        error.releaseError = releaseError;
        error.retainAdmission = true;
      }
    }
    if (workload) await workload.retainForRecovery(error);
    throw error;
  } finally {
    if (heartbeat) await heartbeat.stop();
    if (connected) await deps.disconnectDB();
  }
}

function buildAdmittedCallModel({ host, modelConfigs, timeoutMs, session, generateImpl, assertArtifact }) {
  if (!session?.workloadId || !session.signal || typeof session.assertActive !== 'function') {
    throw new Error('An owned workload admission is required for repository inference');
  }
  const generate = generateImpl || require('../../clients/coreApiClient').generateWithWorkloadAdmission;
  return async ({ model, prompt, seed }) => {
    try {
      await session.assertActive();
      if (assertArtifact) await assertArtifact(model);
      const config = modelConfigs.get(model);
      if (!config?.artifact_digest) throw new Error('Frozen repository candidate is missing');
      const signal = AbortSignal.any([session.signal, AbortSignal.timeout(timeoutMs)]);
      const options = { num_ctx: config.num_ctx, num_predict: config.response_max_tokens };
      for (const key of ['temperature', 'top_p', 'top_k', 'repeat_penalty']) {
        if (Number.isFinite(config[key])) options[key] = config[key];
      }
      if (Number.isFinite(seed)) options.seed = seed;
      const raw = await generate(session.workloadId, { model, host, stream: false, rawResponse: true,
        messages: [{ role: 'user', content: prompt }], options,
        ...(config.send_think !== false ? { think: config.think === true } : {}) }, { signal });
      if (raw?.done !== true || raw.error || !exactModelNamesMatch(model, raw.model)) {
        throw new Error('Repository response lacks a terminal result from the frozen model');
      }
      await session.assertActive();
      return { content: raw.message?.content || raw.response || '', thinking: raw.message?.thinking || raw.thinking || '',
        doneReason: raw.done_reason || null,
        metrics: { effectiveModel: raw.model, promptEvalCount: raw.prompt_eval_count ?? null,
          evalCount: raw.eval_count ?? null, totalDuration: raw.total_duration ?? null } };
    } catch (error) {
      // A client failure cannot prove remote termination. Stop the matrix;
      // retain admission and host authority for shared reconciliation.
      error.retainAdmission = true;
      throw error;
    }
  };
}

module.exports = { withRepoAdmission, buildAdmittedCallModel };
