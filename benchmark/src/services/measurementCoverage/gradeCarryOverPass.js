'use strict';

/**
 * Carries the stored grades of catalog answers over to the current scorer
 * version (#461), so a scorer change re-opens only what it affects.
 *
 * For each answer scored under an earlier version the scorer declares a
 * carry-over from (scorerVersion.js), the pass derives the grade under the
 * current version (scoring/gradeCarryOver.js) and the cohort the leaderboard
 * compares it in, then rewrites the row: version, cohort and, where a rule
 * changed it, the grade and what follows from it. What the row held before
 * is kept in `scorer_history`. The matrix and the board read the same rows,
 * so they stay consistent.
 *
 * Nothing is guessed. A row is left exactly as it is, and its answer is
 * scored again the ordinary way, when its grade cannot be derived, when its
 * cohort cannot be reproduced from its batch, when its prompt is no longer
 * the catalog's, or when it is excluded from the leaderboard.
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { loadCatalogPrompts } = require('../benchmark/promptComparison');
const { cohortFingerprintForBatch } = require('../benchmark/qualityCohort');
const { calculateCompositeScore } = require('../scoring/compositeScorer');
const { DEFAULT_SCORING_CATEGORY } = require('../scoring/scoringConfigs');
const { SCORER_VERSION } = require('../scoring/scorerVersion');
const { carryGrade, carriableVersions } = require('../scoring/gradeCarryOver');

const ROW_FIELDS = 'batch_id scorer_version quality_score scoring_method scoring_type prompt_category '
    + 'quality_breakdown judge_quality_score judge_scores quality_cohort_fingerprint quality_explanation '
    + 'composite_score subjective_score semantic_score latency tokens_per_sec time_to_first_token_ms performance_baseline';

/**
 * The row's cohort under the current version, or a refusal when its stored
 * cohort is not the one its batch settings give under its own version.
 */
async function carryCohort(row, batches, cache) {
    if (typeof row.quality_cohort_fingerprint !== 'string' || !row.quality_cohort_fingerprint) return { fingerprint: null };
    const batch = batches.get(String(row.batch_id));
    if (!batch) return { refused: 'batch not found' };
    const key = `${batch._id}:${row.scorer_version}`;
    if (!cache.has(key)) {
        cache.set(key, {
            before: await cohortFingerprintForBatch(batch, batch.judge_config, { scorerVersion: row.scorer_version }),
            after: await cohortFingerprintForBatch(batch, batch.judge_config)
        });
    }
    const { before, after } = cache.get(key);
    return before === row.quality_cohort_fingerprint
        ? { fingerprint: after }
        : { refused: 'cohort does not follow from the batch settings' };
}

/** The fields a changed grade drags with it, as the judge path writes them. */
function changedGradeFields(row, grade) {
    const composite = calculateCompositeScore({
        latency: row.latency,
        tokens_per_sec: row.tokens_per_sec,
        time_to_first_token_ms: row.time_to_first_token_ms,
        performance_baseline: row.performance_baseline,
        quality_score: grade.quality_score
    }, row.prompt_category || DEFAULT_SCORING_CATEGORY);
    const bounded = (grade.secondary_bounds || []).filter(bound => bound.applied)
        .map(bound => ` Bounded at ${bound.dimension.replace(/_/g, ' ')} + ${bound.margin}.`).join('');
    return {
        quality_score: grade.quality_score,
        composite_score: composite.composite_score,
        composite_profile_used: composite.composite_profile_used,
        normalized_scores: composite.normalized,
        // These mirror the grade on judge paths; keep the mirror.
        ...(row.subjective_score === row.quality_score ? { subjective_score: grade.quality_score } : {}),
        ...(row.semantic_score === row.quality_score ? { semantic_score: grade.quality_score } : {}),
        quality_explanation: `${row.quality_explanation || ''}${bounded} Carried over from scorer ${row.scorer_version} (was ${row.quality_score}).`.trim()
    };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.dryRun] report without writing
 * @returns {{ scorerVersion, examined, carried, changed, left, reasons, dryRun }}
 */
async function carryOverStoredGrades({ dryRun = false } = {}) {
    const summary = { scorerVersion: SCORER_VERSION, examined: 0, carried: 0, changed: 0, left: 0, reasons: {}, dryRun };
    const versions = carriableVersions();
    if (!versions.length) return summary;
    const catalog = await loadCatalogPrompts();
    if (!catalog.size) return summary;
    const rows = await BenchmarkResult.find({
        scorer_version: { $in: versions },
        quality_score: { $type: 'number' },
        excluded_from_leaderboard: { $ne: true },
        prompt_fingerprint: { $in: [...catalog.keys()] }
    }).select(ROW_FIELDS).lean();
    if (!rows.length) return summary;
    const batchIds = [...new Set(rows.map(row => String(row.batch_id)))];
    const batches = new Map((await BenchmarkBatch.find({ _id: { $in: batchIds } })
        .select('judge_config execution_config campaign_kind').lean()).map(batch => [String(batch._id), batch]));
    const cohorts = new Map();
    const leave = reason => { summary.left += 1; summary.reasons[reason] = (summary.reasons[reason] || 0) + 1; };

    for (const row of rows) {
        summary.examined += 1;
        const grade = carryGrade(row);
        if (!grade.carried) { leave(grade.reason); continue; }
        const cohort = await carryCohort(row, batches, cohorts);
        if (cohort.refused) { leave(cohort.refused); continue; }
        if (!dryRun) {
            const written = await BenchmarkResult.updateOne(
                { _id: row._id, scorer_version: row.scorer_version, quality_score: row.quality_score },
                {
                    $set: {
                        scorer_version: SCORER_VERSION,
                        quality_cohort_fingerprint: cohort.fingerprint,
                        ...(grade.changed ? changedGradeFields(row, grade) : {})
                    },
                    $push: { scorer_history: {
                        scorer_version: row.scorer_version,
                        quality_score: row.quality_score,
                        composite_score: row.composite_score ?? null,
                        quality_cohort_fingerprint: row.quality_cohort_fingerprint ?? null,
                        rules: grade.rules,
                        carried_at: new Date()
                    } }
                }
            );
            if (written.matchedCount !== 1) { leave('row changed meanwhile'); continue; }
        }
        summary.carried += 1;
        if (grade.changed) summary.changed += 1;
    }
    if (!dryRun && summary.examined) logger.info('[Coverage] Stored grades carried over to the current scorer', summary);
    return summary;
}

module.exports = { carryOverStoredGrades };
