'use strict';

/**
 * The quality cohort of benchmark results: results that one leaderboard may
 * compare because they share the scorer version, the judge, the generation
 * settings and the profile contract.
 *
 * Prompts are not part of the cohort. Each result carries the fingerprint of
 * the prompt it ran (`prompt_fingerprint`, its identity and scoring content),
 * and the leaderboard compares results only on prompts whose fingerprint
 * matches the current catalog. Adding a prompt leaves every existing result
 * comparable; editing one makes only the results on that prompt
 * non-comparable. Batches share a cohort when their frozen contender sets,
 * judge and generation contracts match; prompt levels and repeats do not split it.
 */

const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { SCORER_VERSION } = require('../scoring/scorerVersion');
const { resolveJudgeConfig } = require('../scoring/resolveJudgeConfig');
const { GENERALIST_AGGREGATION_OPTIONS } = require('./generalistScoreConstants');
const {
    buildOllamaTarget,
    buildPromptFingerprint,
    buildQualityCohortFingerprint
} = require('../../../../shared/benchmarkTargetContract');

const missingPromptFingerprint = () => [{ prompt_fingerprint: null }, { prompt_fingerprint: { $exists: false } }];

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
    const resolvedJudge = resolveJudgeConfig(judgeConfig || {});
    return buildQualityCohortFingerprint({
        scorerVersion,
        judgeTarget: judgeTargetFor(judgeConfig),
        judgeThink: judgeConfig?.think,
        judgeConfig: resolvedJudge,
        executionConfig: batch.execution_config || {},
        candidateContracts: batch.inference_contract_campaign?.candidates || null,
        profileContract: profileContractFor(batch.campaign_kind)
    });
}

function snapshotValue(value) {
    return value === undefined || value === null || value === '' ? null : String(value);
}

/**
 * Whether a result's prompt snapshot shows it ran this catalog prompt as the
 * catalog holds it today: same name, level and category, same expected and
 * reference answers, and the text sent was the catalog text, followed only by
 * the execution hints the runner appends after a blank line.
 */
function snapshotMatchesPrompt(result, prompt) {
    const sent = typeof result.prompt === 'string' ? result.prompt : '';
    const text = String(prompt.prompt || '');
    return text !== ''
        && result.prompt_name === prompt.name
        && Number(result.prompt_level) === Number(prompt.level)
        && result.prompt_category === prompt.category
        && snapshotValue(result.expected_answer) === snapshotValue(prompt.expected_answer)
        && snapshotValue(result.reference_answer) === snapshotValue(prompt.reference_answer)
        && (sent === text || sent.startsWith(`${text}\n\n`));
}

/**
 * Give a batch's results without a prompt fingerprint the fingerprint of the
 * catalog prompt they provably ran. Results written before prompt
 * fingerprints existed do not name their prompt: the snapshot must match
 * exactly one catalog prompt, otherwise the result keeps none and the board
 * does not compare it. Idempotent: results with a fingerprint are left alone.
 */
async function recoverPromptFingerprints(batchId, { dryRun = false, signal = null } = {}) {
    const missing = await BenchmarkResult.find(
        { batch_id: batchId, $or: missingPromptFingerprint() },
        { prompt: 1, prompt_name: 1, prompt_level: 1, prompt_category: 1, expected_answer: 1, reference_answer: 1 }
    ).lean();
    if (missing.length === 0) return { recovered: 0, unrecovered: 0 };
    const byName = new Map();
    const names = [...new Set(missing.map(result => result.prompt_name).filter(Boolean))];
    for (const prompt of await BenchmarkPrompt.find({ name: { $in: names } }).lean()) {
        if (!byName.has(prompt.name)) byName.set(prompt.name, []);
        byName.get(prompt.name).push(prompt);
    }
    const updates = [];
    for (const result of missing) {
        const matches = (byName.get(result.prompt_name) || []).filter(prompt => snapshotMatchesPrompt(result, prompt));
        if (matches.length !== 1) continue;
        updates.push({ updateOne: {
            filter: { _id: result._id, $or: missingPromptFingerprint() },
            update: { $set: { prompt_id: String(matches[0]._id), prompt_fingerprint: buildPromptFingerprint(matches[0]) } }
        } });
    }
    if (!dryRun && updates.length) await BenchmarkResult.bulkWrite(updates, signal ? { signal } : undefined);
    return { recovered: updates.length, unrecovered: missing.length - updates.length };
}

/**
 * After a standalone judge run, move the judged results and independent
 * deterministic results to its cohort. Unjudged rows retain their identity.
 * Results written before prompt fingerprints get theirs where it is provable; a
 * result whose prompt cannot be proven leaves every cohort (null), since a
 * cohort no longer pins the catalog and nothing else would pin its prompt.
 */
async function applyJudgeCohort(batchId, judgeConfig, options = {}) {
    const batch = await BenchmarkBatch.findById(batchId).lean();
    if (!batch) return null;
    const qualityCohortFingerprint = await cohortFingerprintForBatch(batch, judgeConfig);
    const writeOptions = options.signal ? { signal: options.signal } : undefined;
    await recoverPromptFingerprints(batch._id, { signal: options.signal });
    await BenchmarkResult.updateMany(
        { batch_id: batch._id, prompt_fingerprint: { $type: 'string' },
            ...(Array.isArray(options.resultIds) ? { $or: [
                { _id: { $in: options.resultIds } },
                { scoring_method: { $in: ['deterministic', 'executable'] } }
            ] } : {}) },
        { $set: { quality_cohort_fingerprint: qualityCohortFingerprint } },
        writeOptions
    );
    await BenchmarkResult.updateMany(
        { batch_id: batch._id, $or: missingPromptFingerprint() },
        { $set: { quality_cohort_fingerprint: null } },
        writeOptions
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
    profileContractFor,
    recoverPromptFingerprints,
    snapshotMatchesPrompt
};
