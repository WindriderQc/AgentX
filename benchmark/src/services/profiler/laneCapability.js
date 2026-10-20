'use strict';

/**
 * Lane capability profile (#832): one normalized view of what an exact model
 * artifact can do on one host runtime, assembled from existing Profiler
 * evidence. Pure: callers supply the context and performance profiles.
 *
 * Workers size their work from this view instead of fixed constants. It never
 * upgrades missing evidence: an unmeasured value stays null and is listed in
 * `gaps`, and readiness says "not measured" rather than guessing.
 */

const SCHEMA = 'agentx.lane-capability/v1';
const MAX_AGE_DAYS = 30;
// Minimums for an autonomous coding or report worker step.
const AGENT_MINIMUMS = Object.freeze({ stepContext: 8192, toolTurns: 8, outputTokens: 1500, toolAccuracy: 0.75 });
// Physical plausibility bounds. A value outside them is a measurement defect
// (one recorded profile claimed 1,000,000 tok/s), not a capability.
const LIMITS = Object.freeze({
  generationTokensPerSec: 2000,
  promptTokensPerSec: 100000,
  context: 4194304,
  ttftMs: 3600000
});

const GAP_TEXT = Object.freeze({
  artifact_unresolved: 'The installed artifact or runtime could not be identified, so no profile can be trusted for it.',
  no_context_profile: 'No context profile exists for this exact artifact and runtime.',
  recommendations_unverified: 'Context recommendations need a fresh standard profile before they can be used.',
  knee_missing: 'The context size where speed starts to drop is not measured.',
  quality_unknown: 'No long-context quality check has passed, so answer quality at large contexts is unknown.',
  no_performance_profile: 'No active performance profile exists for this model on this host.',
  performance_artifact_mismatch: 'The performance profile was measured on a different artifact than the one installed.',
  prompt_speed_missing: 'Prompt reading speed is not measured.',
  long_prefill_missing: 'Reading speed at 32k–128k contexts is not measured (needs a Full profile).',
  agent_workload_missing: 'Agent workload (growing session, long structured output, many tool turns) is not measured yet.',
  agent_session_short: 'In a growing agent session, calls slow down or answers break before an 8k-token step.',
  agent_tools_unreliable: 'The model makes fewer than 8 consecutive valid tool calls.',
  agent_output_short: 'The model cannot return a complete structured answer of about 1,500 tokens.',
  agent_tool_answers_wrong: 'Fewer than three quarters of the checks recorded through tools were right.',
  profile_old: 'The newest measurement is older than 30 days.',
  implausible_values: 'Some recorded values are physically impossible and were ignored.',
  concurrency_unmeasured: 'Speed with other resident models answering at the same time is not measured.',
  concurrency_evicts: 'This model and a co-resident model did not stay loaded together: one evicted the other.'
});

// Why a lane should be measured again. Each proposal is a Full profile the
// owner may queue; none starts by itself.
const REMEASURE_TEXT = Object.freeze({
  never_measured: 'This model has never been profiled on this host.',
  model_changed: 'The installed model artifact changed since the last profile.',
  runtime_changed: 'Ollama, its settings or the host hardware changed since the last profile.',
  profile_old: 'The newest measurement is older than 30 days.',
  recommendations_unverified: 'Context recommendations need a fresh profile.',
  full_missing: 'No Full profile exists yet: quality, agent work and concurrency are unmeasured.'
});

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function plausible(field, value, max, rejected, { integer = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = finite(value);
  if (n === null || n <= 0 || n > max) {
    rejected.push({ field, value, reason: n !== null && n > max ? 'above plausible maximum' : 'not a positive number' });
    return null;
  }
  return integer ? Math.round(n) : Number(n.toFixed(2));
}

function dateOrNull(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? new Date(time) : null;
}

function digestsMatch(left, right) {
  const clean = value => String(value || '').replace(/^sha256:/, '').toLowerCase();
  return Boolean(clean(left)) && clean(left) === clean(right);
}

function longPrefillRows(profile, rejected) {
  const sizes = profile?.prefillDecodeMatrix?.longPrefill?.sizes;
  if (!Array.isArray(sizes)) return [];
  return sizes
    .filter(size => size?.status === 'pass')
    .map(size => ({
      numCtx: plausible('longPrefill.numCtx', size.numCtx, LIMITS.context, rejected, { integer: true }),
      promptTokensPerSec: plausible('longPrefill.prefillTokensPerSec', size.prefillTokensPerSec, LIMITS.promptTokensPerSec, rejected),
      ttftMs: plausible('longPrefill.ttftMs', size.ttftMs, LIMITS.ttftMs, rejected, { integer: true })
    }))
    .filter(row => row.numCtx && row.promptTokensPerSec)
    .sort((a, b) => a.numCtx - b.numCtx);
}

function agentCapability(profile, rejected) {
  const summary = profile?.agentWorkload?.summary;
  if (!summary) return { status: 'not_measured' };
  const value = (field, max) => plausible(`agent.${field}`, summary[field], max, rejected, { integer: true });
  const agent = {
    status: 'measured',
    sessionLatencyKneeContext: value('sessionLatencyKneeContext', LIMITS.context),
    sessionAccuracyContext: value('sessionAccuracyContext', LIMITS.context),
    verificationVerifiedContext: value('verificationVerifiedContext', LIMITS.context),
    reliableOutputItems: value('reliableOutputItems', 100000),
    reliableOutputTokens: value('reliableOutputTokens', LIMITS.context),
    reliableToolTurns: finite(summary.reliableToolTurns) ?? 0,
    toolChecksCorrect: finite(summary.toolChecksCorrect),
    toolChecksTotal: finite(summary.toolChecksTotal),
    sessionCurve: (profile.agentWorkload.session?.turns || [])
      .filter(row => row?.status === 'pass')
      .slice(0, 60)
      .map(row => ({ contextTokens: finite(row.contextTokens), latencyMs: finite(row.latencyMs), correct: row.correct === true })),
    measuredAt: profile.agentWorkload.measuredAt || null
  };
  // The step a worker can give this model: the smallest of the measured
  // limits, so a step stays fast, exact and verifiable.
  const limits = [agent.sessionLatencyKneeContext, agent.sessionAccuracyContext, agent.verificationVerifiedContext]
    .filter(limit => Number(limit) > 0);
  agent.recommendedStepContext = limits.length ? Math.min(...limits) : null;
  return agent;
}

function concurrencyCapability(profile) {
  const evidence = profile?.concurrency;
  if (!evidence?.status) return { status: 'not_measured' };
  const pct = value => (Number.isFinite(Number(value)) ? Number(value) : null);
  return {
    status: evidence.status,
    scope: evidence.scope || 'same_endpoint',
    worstSelfSlowdownPct: pct(evidence.worstSelfSlowdownPct),
    worstOtherSlowdownPct: pct(evidence.worstOtherSlowdownPct),
    worstSiblingSelfSlowdownPct: pct(evidence.worstSiblingSelfSlowdownPct),
    worstSiblingOtherSlowdownPct: pct(evidence.worstSiblingOtherSlowdownPct),
    pairs: (Array.isArray(evidence.pairs) ? evidence.pairs : []).slice(0, 6).map(pair => ({
      model: pair.model || null, status: pair.status || null, endpoint: pair.endpoint || 'same',
      selfSlowdownPct: pct(pair.selfSlowdownPct), otherSlowdownPct: pct(pair.otherSlowdownPct)
    })),
    // Evidence from before sibling pairing (probe v1) never covered other endpoints.
    separateEndpoints: evidence.scope === 'same_machine' && evidence.separateEndpoints ? evidence.separateEndpoints : 'not_measured'
  };
}

function toolAccuracy(agent) {
  return agent.toolChecksTotal > 0 ? (agent.toolChecksCorrect || 0) / agent.toolChecksTotal : 0;
}

function readiness({ context, quality, agent }) {
  const chat = context.interactive ? 'ready' : context.max ? 'unverified' : 'not_measured';
  let documents = 'not_measured';
  if (context.document) {
    documents = quality.status === 'verified' && quality.context >= context.document ? 'ready' : 'speed_only';
  } else if (context.max) {
    documents = 'unverified';
  }
  let codingAgent = 'not_measured';
  if (agent.status === 'measured') {
    codingAgent = (agent.recommendedStepContext || 0) >= AGENT_MINIMUMS.stepContext
      && agent.reliableToolTurns >= AGENT_MINIMUMS.toolTurns
      && (agent.reliableOutputTokens || 0) >= AGENT_MINIMUMS.outputTokens
      && toolAccuracy(agent) >= AGENT_MINIMUMS.toolAccuracy ? 'ready' : 'limited';
  }
  return { chat, documents, codingAgent };
}

/**
 * @param {object} input
 * @param {string} input.model
 * @param {string} input.hostUrl
 * @param {string|null} [input.hostId]
 * @param {{digest?:string, runtimeFingerprint?:string}|null} [input.artifact] installed identity
 * @param {object|null} [input.contextProfile] normalized ModelContextProfile for that identity
 * @param {object|null} [input.performanceProfile] active ModelPerformanceProfile document
 * @param {Date} [input.now]
 */
function buildLaneCapability({
  model, hostUrl, hostId = null, artifact = null, contextProfile = null, performanceProfile = null,
  now = new Date(), maxAgeDays = MAX_AGE_DAYS
} = {}) {
  const rejected = [];
  const gaps = [];
  const identified = Boolean(artifact?.digest && artifact?.runtimeFingerprint);
  if (!identified) gaps.push('artifact_unresolved');
  const ctxProfile = identified ? contextProfile : null;
  if (identified && !ctxProfile) gaps.push('no_context_profile');

  const perf = performanceProfile?.profile ? performanceProfile : null;
  const perfDigest = perf?.artifact?.digest || perf?.profile?.artifact?.digest || null;
  const perfRuntime = perf?.artifact?.runtimeFingerprint || perf?.profile?.artifact?.runtimeFingerprint || null;
  // Quality and agent evidence are bound to the exact artifact and runtime:
  // a different Ollama build or setting is a different measurement.
  const modelChanged = Boolean(perf) && identified && Boolean(perfDigest) && !digestsMatch(perfDigest, artifact.digest);
  const runtimeChanged = Boolean(perf) && identified && !modelChanged && Boolean(perfRuntime) && perfRuntime !== artifact.runtimeFingerprint;
  const perfMatches = Boolean(perf) && !modelChanged && !runtimeChanged;
  if (!perf) gaps.push('no_performance_profile');
  else if (!perfMatches) gaps.push('performance_artifact_mismatch');
  const p = perfMatches ? perf.profile : {};

  const recommendationsVerified = ctxProfile?.recommendationStatus === 'verified';
  const context = {
    max: plausible('context.max', ctxProfile?.maxVerifiedContext, LIMITS.context, rejected, { integer: true }),
    interactive: plausible('context.interactive', ctxProfile?.recommendedInteractiveContext, LIMITS.context, rejected, { integer: true }),
    document: plausible('context.document', ctxProfile?.recommendedDocumentContext, LIMITS.context, rejected, { integer: true }),
    knee: plausible('context.knee', ctxProfile?.performanceKneeContext, LIMITS.context, rejected, { integer: true }),
    kneeDegradationPct: finite(ctxProfile?.performanceKneeDegradationPct) || 15,
    theoreticalMax: plausible('context.theoreticalMax', ctxProfile?.modelTheoreticalMax, LIMITS.context, rejected, { integer: true }),
    recommendationStatus: recommendationsVerified ? 'verified' : 'unknown'
  };
  if (ctxProfile && !recommendationsVerified) gaps.push('recommendations_unverified');
  if (ctxProfile && recommendationsVerified && !context.knee) gaps.push('knee_missing');

  // Quality may come from the context profile (qualified campaign) or from a
  // Full performance profile's long-context probe for the same artifact.
  const qualityContext = [ctxProfile?.qualityContextStatus === 'verified' ? ctxProfile.qualityVerifiedContext : null,
    p?.qualityContextStatus === 'verified' ? p.qualityVerifiedContext : null]
    .map(value => plausible('quality.context', value, LIMITS.context, rejected, { integer: true }))
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || null;
  const quality = {
    status: qualityContext ? 'verified' : 'unknown',
    context: qualityContext,
    method: qualityContext ? 'synthetic recall and one-hop reasoning' : null
  };
  if (!qualityContext) gaps.push('quality_unknown');

  const longPrefill = longPrefillRows(p, rejected);
  const throughput = {
    generationTokensPerSec: plausible('throughput.generation', p?.tokensPerSec ?? ctxProfile?.latestEvidence?.tokensPerSec,
      LIMITS.generationTokensPerSec, rejected),
    promptTokensPerSec: plausible('throughput.prompt', p?.promptEvalTokensPerSec, LIMITS.promptTokensPerSec, rejected),
    ttftP50Ms: plausible('throughput.ttftP50Ms', p?.ttftP50Ms, LIMITS.ttftMs, rejected, { integer: true }),
    measuredAtNumCtx: plausible('throughput.numCtx', p?.comparisonNumCtx, LIMITS.context, rejected, { integer: true }),
    longPrefill
  };
  if (perfMatches && !throughput.promptTokensPerSec) gaps.push('prompt_speed_missing');
  if (perfMatches && longPrefill.length === 0) gaps.push('long_prefill_missing');

  const agent = agentCapability(perfMatches ? p : null, rejected);
  if (agent.status !== 'measured') gaps.push('agent_workload_missing');
  else {
    if ((agent.recommendedStepContext || 0) < AGENT_MINIMUMS.stepContext) gaps.push('agent_session_short');
    if (agent.reliableToolTurns < AGENT_MINIMUMS.toolTurns) gaps.push('agent_tools_unreliable');
    if ((agent.reliableOutputTokens || 0) < AGENT_MINIMUMS.outputTokens) gaps.push('agent_output_short');
    if (toolAccuracy(agent) < AGENT_MINIMUMS.toolAccuracy) gaps.push('agent_tool_answers_wrong');
  }

  const concurrency = concurrencyCapability(perfMatches ? p : null);
  if (concurrency.status === 'not_measured') gaps.push('concurrency_unmeasured');
  if (concurrency.status === 'evicted') gaps.push('concurrency_evicts');

  const dates = [dateOrNull(ctxProfile?.lastValidatedAt), dateOrNull(p?.profiledAt || perf?.updatedAt)].filter(Boolean);
  const measuredAt = dates.length ? new Date(Math.max(...dates.map(date => date.getTime()))) : null;
  const ageDays = measuredAt ? Math.max(0, Math.floor((now.getTime() - measuredAt.getTime()) / 86400000)) : null;
  if (ageDays !== null && ageDays > maxAgeDays) gaps.push('profile_old');
  if (rejected.length) gaps.push('implausible_values');

  const reasons = [];
  if (!ctxProfile && !perf) reasons.push('never_measured');
  if (modelChanged) reasons.push('model_changed');
  if (runtimeChanged) reasons.push('runtime_changed');
  if (ageDays !== null && ageDays > maxAgeDays) reasons.push('profile_old');
  if (ctxProfile && !recommendationsVerified) reasons.push('recommendations_unverified');
  // A Full profile that ran and failed a check is a result, not a reason to
  // measure again; only a lane that never had one is proposed for it.
  const fullDone = perfMatches && p?.profileDepth === 'full' && Boolean(p?.agentWorkload);
  if (!fullDone && !reasons.includes('never_measured')) reasons.push('full_missing');
  const remeasure = identified
    ? { needed: reasons.length > 0, depth: 'full', reasons: reasons.map(code => ({ code, text: REMEASURE_TEXT[code] })) }
    : { needed: false, depth: null, reasons: [], blocked: 'The installed artifact or runtime could not be identified.' };

  return {
    schema: SCHEMA,
    model,
    hostUrl,
    hostId,
    artifact: identified ? { digest: artifact.digest, runtimeFingerprint: artifact.runtimeFingerprint } : null,
    context,
    quality,
    throughput,
    agent,
    concurrency,
    remeasure,
    readiness: readiness({ context, quality, agent }),
    provenance: {
      contextProfileId: ctxProfile?._id ? String(ctxProfile._id) : null,
      performanceProfileId: perfMatches && perf?._id ? String(perf._id) : null,
      depth: (perfMatches && p?.profileDepth) || ctxProfile?.profileDepth || null,
      measuredAt: measuredAt ? measuredAt.toISOString() : null,
      ageDays
    },
    rejected,
    gaps: gaps.map(code => ({ code, text: GAP_TEXT[code] }))
  };
}

module.exports = { buildLaneCapability, SCHEMA, LIMITS, MAX_AGE_DAYS, GAP_TEXT, REMEASURE_TEXT, AGENT_MINIMUMS };
