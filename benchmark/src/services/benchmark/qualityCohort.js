'use strict';

/**
 * The quality cohort of benchmark results: results that one leaderboard may
 * compare because they share the prompt catalog, the scorer version, the
 * judge and the generation settings.
 *
 * The cohort is fingerprinted over the whole library catalog, not over the
 * prompts one batch selected. A campaign split into batches (one per level or
 * per host) is one cohort; a catalog edit, another judge or other generation
 * settings start a new one. Custom prompts a batch selected are added, since
 * they are not part of the catalog.
 */

const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { SCORER_VERSION } = require('../scoring/scorerVersion');
const { GENERALIST_AGGREGATION_OPTIONS } = require('./generalistScoreConstants');
const {
    buildOllamaTarget,
    buildQualityCohortFingerprint
} = require('../../../../shared/benchmarkTargetContract');

async function loadCohortCatalog(selectedPrompts = []) {
    const library = await BenchmarkPrompt.find({ custom: { $ne: true } }).lean();
    const seen = new Set(library.map(prompt => String(prompt._id)));
    const custom = (selectedPrompts || []).filter(prompt => prompt && !seen.has(String(prompt._id)));
    return [...library, ...custom];
}

function profileContractFor(campaignKind) {
    return campaignKind === 'native_agent' ? 'native-agent-v1' : 'isolated-model-v1';
}

function judgeTargetFor(judgeConfig = {}) {
    if (judgeConfig.target) return judgeConfig.target;
    return judgeConfig.host && judgeConfig.model ? buildOllamaTarget(judgeConfig.host, judgeConfig.model) : null;
}

/**
 * The cohort a batch's results belong to once `judgeConfig` has judged them.
 */
async function cohortFingerprintForBatch(batch, judgeConfig, { scorerVersion = SCORER_VERSION } = {}) {
    const selectedCustom = Array.isArray(batch.prompt_ids) && batch.prompt_ids.length
        ? await BenchmarkPrompt.find({ _id: { $in: batch.prompt_ids }, custom: true }).lean()
        : [];
    return buildQualityCohortFingerprint({
        prompts: await loadCohortCatalog(selectedCustom),
        scorerVersion,
        judgeTarget: judgeTargetFor(judgeConfig),
        executionConfig: batch.execution_config || {},
        profileContract: profileContractFor(batch.campaign_kind)
    });
}

/**
 * After a standalone judge run, every result of the batch belongs to the
 * cohort of the judge that ran, deterministic results included.
 */
async function applyJudgeCohort(batchId, judgeConfig, options = {}) {
    const batch = await BenchmarkBatch.findById(batchId).lean();
    if (!batch) return null;
    const qualityCohortFingerprint = await cohortFingerprintForBatch(batch, judgeConfig);
    await BenchmarkResult.updateMany(
        { batch_id: batch._id },
        { $set: { quality_cohort_fingerprint: qualityCohortFingerprint } },
        options.signal ? { signal: options.signal } : undefined
    );
    return qualityCohortFingerprint;
}

/**
 * The cohort a leaderboard compares: the one covering the most model/host
 * pairs among the results in `match`, the most recent on a tie. A newer
 * cohort with fewer models (a two-model rerun under other settings, a
 * campaign still starting) does not replace a wider one.
 */
async function selectComparisonCohort(match) {
    const [widest] = await BenchmarkResult.aggregate([
        { $match: { ...match, quality_cohort_fingerprint: { $type: 'string', $ne: '' } } },
        { $group: { _id: { cohort: '$quality_cohort_fingerprint', model: '$model', host: '$host' }, latest: { $max: '$timestamp' } } },
        { $group: { _id: '$_id.cohort', pairs: { $sum: 1 }, latest: { $max: '$latest' } } },
        { $sort: { pairs: -1, latest: -1 } },
        { $limit: 1 }
    ], GENERALIST_AGGREGATION_OPTIONS);
    return widest?._id || null;
}

module.exports = {
    applyJudgeCohort,
    selectComparisonCohort,
    cohortFingerprintForBatch,
    judgeTargetFor,
    loadCohortCatalog,
    profileContractFor
};
