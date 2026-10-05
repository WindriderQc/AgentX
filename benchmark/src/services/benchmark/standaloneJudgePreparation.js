'use strict';

/**
 * What a standalone judge run (re-judge, rejudge-pending) needs before and
 * around its calls, as the batch path already does (#59):
 *
 * - the judge context: an explicit num_ctx wins, otherwise the one Core's
 *   inference contract freezes for the model and host. A judge call without
 *   num_ctx makes Ollama reload a resident model at its default context,
 *   which outlasts the call timeout and leaves the lease UNKNOWN;
 * - a warm judge, loaded before the first call under a cold-start deadline,
 *   so no judge call pays the model load inside its own timeout;
 * - a drain budget sized to the work: a 147-result re-judge takes about 31
 *   minutes, over the old fixed 30-minute cap.
 */

const { getWorkloadAdmissionIdentity } = require('../../clients/coreApiClient');
const { freezeJudgeConfig } = require('./judgeExecutionContract');
const { warmupModel } = require('./modelWarmup');
const { withInference } = require('./workloadYield');

const MIN_DRAIN_BUDGET_MS = 30 * 60 * 1000;
// About ten times the observed cost of one result (25 s per concurrent slot
// with qwen3.8:27b), so only a stuck run reaches it.
const PER_RESULT_BUDGET_MS = 3 * 60 * 1000;
const JUDGE_WARMUP_COLD_MS = 5 * 60 * 1000;
const JUDGE_WARMUP_LOADED_MS = 90 * 1000;

/** The time a judge queue may take to judge `pendingCount` results. */
function judgeDrainBudgetMs(pendingCount, concurrency, configuredMs = null) {
    const slots = Math.max(1, Number(concurrency) || 1);
    const sized = Math.ceil(Math.max(0, Number(pendingCount) || 0) / slots) * PER_RESULT_BUDGET_MS;
    return Math.max(MIN_DRAIN_BUDGET_MS, Number(configuredMs) || 0, sized);
}

/**
 * Freeze the judge identity and context, then warm it. Returns the config the
 * run's calls use. A warmup that fails throws: the run stops before its first
 * call instead of recording every result as a judge failure.
 */
async function prepareStandaloneJudge(judgeConfig, { workloadId = null, signal = null, _freezeConfig = freezeJudgeConfig, _warmup = warmupModel } = {}) {
    if (judgeConfig?.target?.executionKind === 'harness') return judgeConfig;
    const frozen = await _freezeConfig(judgeConfig, { signal });
    const { host, model, num_ctx: numCtx } = frozen;
    await withInference(workloadId, () => _warmup(host, model, {
        strict: true,
        num_ctx: numCtx,
        preUnloadOthers: false,
        warmupTimeoutCold: JUDGE_WARMUP_COLD_MS,
        warmupTimeoutLoaded: JUDGE_WARMUP_LOADED_MS,
        signal,
        claimIdentity: workloadId ? getWorkloadAdmissionIdentity(workloadId) : null
    }), { signal });
    return frozen;
}

module.exports = { judgeDrainBudgetMs, prepareStandaloneJudge, PER_RESULT_BUDGET_MS, MIN_DRAIN_BUDGET_MS };
