/**
 * Benchmark Service
 * Business logic for LLM performance testing and quality scoring
 * Implements Service-Oriented Architecture pattern
 *
 * This is the main facade that preserves the singleton API while
 * delegating to modular sub-components.
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');

// Import sub-modules
const { DEFAULT_EXECUTION_CONFIG } = require('./config');
const { seedPrompts, cleanupStaleBatches, getPrompts, getConfigPresets } = require('./init');
const { residencyOf } = require('../probePlacement');
const { runTest, startBatch, resumeBatch, executeBatch, stopBatch } = require('./execution');
const { getResults, getSummary, getDashboard, compareModels, getQualityBreakdown, getModelTrends, compareBatches, getBatchQualityBreakdown } = require('./results');
const {
    getBatches,
    getBatch,
    getBatchStatsByTag,
    clearResults,
    clearFailedResults,
    getActiveStats
} = require('./batches');
const { getJudgeLeaderboard, getJudgeBreakdown, getJudgeActivity, getTruncationStats } = require('./judges');
const {
    calculateAllGeneralistScores,
    getActiveCategoryWeights,
    getCategoryScoresByModel,
    getLeaderboardEntryStats,
    buildCategoryEvidenceView
} = require('./generalistScore');
const { getLeaderboardPerformanceSummary, scorerVersionsByEntry } = require('./leaderboardPerformance');
const { groupLeaderboard } = require('./leaderboardGrouping');
const { assessLeaderboardRows } = require('./judgeQualification');
const { selectComparisonCohort } = require('./qualityCohort');
const {
    annotatePromptCoverage, annotateSharedWithLeader, currentPromptClause, promptScopeFor, promptSetsByEntry, stalePromptExpression
} = require('./promptComparison');
const { getTopCategoryFromAverages } = require('./modelMetadata');
const { getCurrentHostModelSnapshot, isModelAvailableForRow, serializeHostModelSnapshot } = require('./modelAvailability');
const { judgeResult, judgeBatch, stopJudging, getJudgingStatus } = require('./judging');
const { getEfficiencyMap } = require('./efficiencyMap');

/**
 * BenchmarkService class - facade preserving original API
 */
class BenchmarkService {
    // Initialization
    seedPrompts = seedPrompts;
    cleanupStaleBatches = cleanupStaleBatches;
    getPrompts = getPrompts;
    getConfigPresets = getConfigPresets;

    getExecutionConfigDefaults() {
        return { ...DEFAULT_EXECUTION_CONFIG };
    }

    // Execution
    runTest = runTest;
    startBatch = startBatch;
    resumeBatch = resumeBatch;
    executeBatch = executeBatch;
    stopBatch = stopBatch;

    // Results and Dashboard
    getResults = getResults;
    getSummary = getSummary;
    getDashboard = getDashboard;
    compareModels = compareModels;
    getQualityBreakdown = getQualityBreakdown;
    getBatchQualityBreakdown = getBatchQualityBreakdown;
    getModelTrends = getModelTrends;
    compareBatches = compareBatches;

    // Batches
    getBatches = getBatches;
    getBatch = getBatch;
    getBatchStatsByTag = getBatchStatsByTag;
    clearResults = clearResults;
    clearFailedResults = clearFailedResults;
    getActiveStats = getActiveStats;

    // Judges
    getJudgeLeaderboard = getJudgeLeaderboard;
    getJudgeBreakdown = getJudgeBreakdown;
    getJudgeActivity = getJudgeActivity;
    getTruncationStats = getTruncationStats;

    // Judging (decoupled from execution)
    judgeResult = judgeResult;
    judgeBatch = judgeBatch;
    stopJudging = stopJudging;
    getJudgingStatus = getJudgingStatus;

    // Efficiency Map
    getEfficiencyMap = getEfficiencyMap;

    // Generalist Leaderboard
    // axis param ∈ {'composite' (default), 'deterministic', 'subjective', 'quality'}
    // selects which numeric field aggregations key off:
    //   composite     → composite_score (latency-aware "headline" leaderboard)
    //   quality       → quality_score (judge quality only, 0-10 scale)
    //   deterministic → deterministic_score (0-10 scale)
    //   subjective    → subjective_score (0-10 scale)
    async getGeneralistLeaderboard(options = {}) {
        const requestedAxis = options.axis === 'deterministic' ? 'deterministic'
            : options.axis === 'subjective' ? 'subjective'
            : options.axis === 'quality' ? 'quality'
            : 'composite';
        const includeCloud = options.includeCloud !== false;
        // The latency-aware composite mixes hardware-local latency with WAN and
        // provider queueing. It is intentionally available only on the
        // local-only board.
        const axis = includeCloud && requestedAxis === 'composite' ? 'quality' : requestedAxis;
        const hostScope = options.hostScope === 'primary' ? 'primary'
            : options.hostScope === 'current' ? 'current'
            : 'all';
        const challengeScope = options.challengeScope === 'advanced' ? 'advanced'
            : options.challengeScope === 'foundation' ? 'foundation'
            : 'all';
        const includeUnavailableModels = options.includeUnavailableModels === true;
        const scoreField = axis === 'deterministic' ? 'deterministic_score'
            : axis === 'subjective' ? 'subjective_score'
            : axis === 'quality' ? 'quality_score'
            : 'composite_score';

        const categoryWeights = await getActiveCategoryWeights();
        // Defense in depth per scoring-contract-v1 §2.7: infra-failed rows never surface
        // in a leaderboard, even though success:true already excludes them.
        const leaderboardMatch = {
            success: true,
            infra_error: { $ne: true },
            // Flagged for review still counts; see generalistScoreAggregation.
            excluded_from_leaderboard: { $ne: true },
            // Every axis is now driven by a populated score field; without
            // this filter the aggregate averages over a sea of nulls and
            // produces phantom rankings. Pre-fix this guard was skipped for
            // the composite axis because composite resolved to quality_score,
            // which was almost always present once judging completed —
            // composite_score has the same property post-judging, but the
            // explicit guard removes that implicit assumption.
            [scoreField]: { $ne: null }
        };
        const addMatchClause = (clause) => {
            leaderboardMatch.$and = [...(leaderboardMatch.$and || []), clause];
        };
        if (!includeCloud) {
            addMatchClause({
                $or: [
                    { 'execution_target.tier': 'local' },
                    { execution_target: null },
                    { execution_target: { $exists: false } }
                ]
            });
        }
        const configuredHosts = getConfiguredHosts()
            .map((host) => ({ name: host.name, url: host.url }))
            .filter((host) => host.url);
        const configuredHostUrls = configuredHosts.map((host) => host.url);
        const primaryHostUrl = configuredHosts[0]?.url || null;
        const hostFilterApplied = Boolean((hostScope === 'current' && configuredHostUrls.length > 0)
            || (hostScope === 'primary' && primaryHostUrl));
        if (hostScope === 'primary' && primaryHostUrl) {
            leaderboardMatch.host = primaryHostUrl;
        } else if (hostFilterApplied) {
            if (includeCloud) {
                addMatchClause({
                    $or: [
                        { host: { $in: configuredHostUrls } },
                        { 'execution_target.tier': { $in: ['free_cloud', 'paid_cloud'] } }
                    ]
                });
            } else {
                leaderboardMatch.host = { $in: configuredHostUrls };
            }
        }
        if (challengeScope === 'advanced') {
            leaderboardMatch.prompt_level = { $gte: 4, $lte: 5 };
        } else if (challengeScope === 'foundation') {
            leaderboardMatch.prompt_level = { $gte: 1, $lte: 3 };
        }
        let selectedQualityCohortFingerprint = null;
        let nonComparableRows = [];
        let promptScope = { pinned: false };
        // Scope for the per-cohort performance and attempt summaries: every
        // filter above, before the match is narrowed to one quality cohort.
        const summaryScopeMatch = { ...leaderboardMatch };
        if (includeCloud) {
            // Rank only one exact quality cohort. Historical rows without the
            // additive fingerprint stay visible below as non-comparable; they
            // are never silently treated as proof-equivalent.
            const cohortBaseMatch = { ...leaderboardMatch };
            selectedQualityCohortFingerprint = await selectComparisonCohort(cohortBaseMatch);
            leaderboardMatch.quality_cohort_fingerprint = selectedQualityCohortFingerprint || { $in: [] };
            // Inside the cohort, compare only results on prompts as the
            // catalog holds them today (see promptComparison).
            promptScope = await promptScopeFor(selectedQualityCohortFingerprint);
            if (promptScope.pinned) addMatchClause(currentPromptClause(promptScope));
            nonComparableRows = await BenchmarkResult.aggregate([
                {
                    $match: selectedQualityCohortFingerprint
                        ? {
                            ...cohortBaseMatch,
                            $and: [
                                ...(cohortBaseMatch.$and || []),
                                {
                                $or: [
                                    { quality_cohort_fingerprint: { $ne: selectedQualityCohortFingerprint } },
                                    { quality_cohort_fingerprint: null },
                                    { quality_cohort_fingerprint: { $exists: false } },
                                    ...(promptScope.pinned ? [{ prompt_fingerprint: { $nin: promptScope.fingerprints } }] : [])
                                ]
                                }
                            ]
                        }
                        : cohortBaseMatch
                },
                { $sort: { timestamp: -1 } },
                {
                    $group: {
                        _id: {
                            model: '$model', host: '$host', cohort: '$quality_cohort_fingerprint',
                            stalePrompt: stalePromptExpression(selectedQualityCohortFingerprint, promptScope)
                        },
                        promptNames: { $addToSet: '$prompt_name' },
                        target: { $first: '$execution_target' },
                        latestTimestamp: { $first: '$timestamp' },
                        totalTests: { $sum: 1 },
                        providerCostNanodollars: { $sum: { $ifNull: ['$provider_cost.costNanodollars', 0] } }
                    }
                },
                { $limit: 200 }
            ]);
        }
        const [performanceSummary, scorerVersionsByRow] = await Promise.all([
            getLeaderboardPerformanceSummary(summaryScopeMatch, { scoreField }),
            scorerVersionsByEntry(leaderboardMatch)
        ]);
        const challengeFilterApplied = challengeScope !== 'all';
        const [generalistScores, categoryMap, availabilitySnapshot] = await Promise.all([
            calculateAllGeneralistScores(leaderboardMatch, {
                categoryWeights,
                scoreField,
                difficultyPenaltyEnabled: challengeScope !== 'foundation',
                generalistProfileOverrides: null
            }),
            getCategoryScoresByModel(leaderboardMatch, { scoreField }),
            getCurrentHostModelSnapshot()
        ]);
        const entryStats = await getLeaderboardEntryStats(leaderboardMatch);
        const leaderboard = [];
        const rankedRows = [];
        for (const [key, data] of generalistScores) {
            const [model, host] = key.split('@@');
            const catScores = categoryMap.get(key) || {};
            const totalTests = Object.values(catScores).reduce((sum, c) => sum + (c.count || 0), 0);
            const stats = entryStats.get(key) || {};
            const harnessEvidence = stats.harnessEvidence || { rankable: true, reason: null };
            const categoryView = buildCategoryEvidenceView(
                catScores,
                data.categoryAverages,
                categoryWeights
            );

            const row = {
                model,
                host: host || null,
                host_available: stats.executionTarget?.executionKind === 'harness'
                    ? stats.executionTarget.available !== false
                    : isModelAvailableForRow({ model, host: host || null }, availabilitySnapshot),
                executionTarget: stats.executionTarget || null,
                provider: stats.executionTarget?.provider || 'ollama',
                tier: stats.executionTarget?.tier || 'local',
                harness: stats.executionTarget?.harness || null,
                pricing: stats.executionTarget?.pricing || null,
                providerCostNanodollars: stats.providerCostNanodollars || 0,
                qualityCohortFingerprint: stats.qualityCohortFingerprint || selectedQualityCohortFingerprint,
                rankable: harnessEvidence.rankable !== false,
                harnessEvidence,
                generalistScore: data.generalistScore,
                weightedSum: data.weightedSum,
                coveragePenalty: data.coveragePenalty,
                difficultyPenalty: data.difficultyPenalty || 0,
                difficultyCoverage: data.difficultyCoverage,
                fullScopeMinLevel: data.fullScopeMinLevel,
                requiredPromptLevels: data.requiredPromptLevels || [],
                missingRequiredLevelsByCategory: data.missingRequiredLevelsByCategory || {},
                minFullScopeResults: data.minFullScopeResults || 0,
                fullScopeEligible: data.fullScopeEligible === true,
                evidenceStatus: data.evidenceStatus || null,
                evidenceConfidence: data.evidenceConfidence ?? null,
                evidenceConfidenceCoverage: data.evidenceConfidenceCoverage ?? null,
                evidenceConfidenceTarget: data.evidenceConfidenceTarget ?? null,
                evidenceConfidencePenalty: data.evidenceConfidencePenalty || 0,
                avgWithinCategoryStdDev: data.avgWithinCategoryStdDev,
                coverage: data.coverage,
                testedCategories: data.testedCategories,
                totalTests,
                confidenceMargin: data.confidenceMargin ?? null,
                confidenceMethod: data.confidenceMethod || null,
                confidenceSampleSize: data.confidenceSampleSize || 0,
                confidenceRepeatCount: data.confidenceRepeatCount || 0,
                confidenceWeighted: data.confidenceWeighted || false,
                categoryConfidence: data.categoryConfidence || null,
                recommended_category: getTopCategoryFromAverages(categoryView.categoryAverages, model),
                categoryAverages: categoryView.categoryAverages,
                categoryEvidence: categoryView.categoryEvidence,
                promptLevelCounts: stats.promptLevelCounts || {},
                minPromptLevel: stats.minPromptLevel || null,
                maxPromptLevel: stats.maxPromptLevel || null,
                contextCounts: stats.contextCounts || {},
                judgeModels: stats.judgeModels || [],
                judgeTargets: stats.judgeTargets || [],
                judgedRows: stats.judgedRows ?? null,
                judgeIdentityMissingRows: stats.judgeIdentityMissingRows ?? null,
                needsReviewCount: stats.needsReviewCount || 0,
                lowConfidenceCount: stats.lowConfidenceCount || 0,
                earliestTimestamp: stats.earliestTimestamp || null,
                latestTimestamp: stats.latestTimestamp || null,
                evidenceCompatibility: harnessEvidence.rankable === false
                    ? 'incomplete_harness_evidence'
                    : 'comparable',
                filtered: data.filtered || false,
                filterReason: data.filterReason || harnessEvidence.reason || null,
                emptyRate: data.emptyRate || 0
            };
            Object.assign(row, performanceSummary.lookup(model, host, row.qualityCohortFingerprint));
            // Rows behind one score must share a scorer generation; mixed
            // generations are different scales and cannot be averaged.
            const versions = scorerVersionsByRow.get(key) || null;
            row.scorerVersions = versions ? versions.counts : {};
            if (versions?.mixed) {
                row.rankable = false;
                row.filterReason = row.filterReason || 'mixed_scorer_versions';
            }

            rankedRows.push(row);
            if (includeUnavailableModels || row.host_available) {
                leaderboard.push(row);
            }
        }
        const promptSets = promptScope.pinned ? await promptSetsByEntry(leaderboardMatch) : null;
        const promptSet = promptSets
            ? { perPrompt: true, ...annotatePromptCoverage(rankedRows, promptSets, promptScope.catalog) }
            : { perPrompt: false };

        for (const item of nonComparableRows) {
            const target = item.target || null;
            const stalePrompt = item._id.stalePrompt === true;
            const row = {
                model: item._id.model,
                host: item._id.host || null,
                host_available: target?.executionKind === 'harness'
                    ? target.available !== false
                    : isModelAvailableForRow({ model: item._id.model, host: item._id.host || null }, availabilitySnapshot),
                executionTarget: target,
                provider: target?.provider || 'ollama',
                tier: target?.tier || 'local',
                harness: target?.harness || null,
                pricing: target?.pricing || null,
                providerCostNanodollars: item.providerCostNanodollars || 0,
                qualityCohortFingerprint: item._id.cohort || null,
                rankable: false,
                generalistScore: null,
                totalTests: item.totalTests || 0,
                evidenceStatus: stalePrompt ? 'stale_prompt_content' : 'non_comparable_cohort',
                evidenceCompatibility: 'non_comparable',
                filterReason: stalePrompt ? 'prompt_content_changed' : 'quality_cohort_fingerprint_mismatch',
                promptContentStale: stalePrompt,
                stalePrompts: stalePrompt ? (item.promptNames || []).filter(Boolean).sort().slice(0, 25) : [],
                latestTimestamp: item.latestTimestamp || null,
                categoryAverages: {},
                categoryEvidence: {},
                testedCategories: 0,
                coverage: 0,
                fullScopeEligible: false,
                filtered: false
            };
            // Stale-prompt rows share the cohort of the ranked row, whose
            // performance summary they would only repeat.
            if (!stalePrompt) Object.assign(row, performanceSummary.lookup(row.model, row.host, row.qualityCohortFingerprint));
            row.scorerVersions = row.performance?.scorerVersions || {};
            if (includeUnavailableModels || row.host_available) leaderboard.push(row);
        }

        // A judged rank is authoritative only when its grader is qualified for
        // the exact judge and scorer version; the verdict carries the causes.
        const graderQualifications = await assessLeaderboardRows(leaderboard, { axis });
        leaderboard.forEach((row, index) => { row.graderQualification = graderQualifications[index]; });
        // Residency of the host behind each row, so CPU and GPU runs compare like with like.
        leaderboard.forEach((row) => { row.residency = row.host ? residencyOf(row.host) : null; });
        if (['cpu', 'gpu'].includes(options.residency)) {
            leaderboard.splice(0, leaderboard.length, ...leaderboard.filter(row => row.residency === options.residency));
        }

        // Full-scope rows rank ahead of partial evidence. Partial rows remain
        // visible/auditable, but they no longer masquerade as comparable
        // leaders just because a narrow hard-level slice scored well.
        leaderboard.sort((a, b) => {
            if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
            if (a.fullScopeEligible !== b.fullScopeEligible) return a.fullScopeEligible ? -1 : 1;
            return (b.generalistScore ?? -Infinity) - (a.generalistScore ?? -Infinity);
        });

        const confidenceWeighted = leaderboard.some(e => e.confidenceWeighted);
        // One group per model and host: the comparable cohort's row as the
        // headline, the other cohorts as history. The flat `leaderboard`
        // keeps every row.
        const grouped = groupLeaderboard(leaderboard, { selectedQualityCohortFingerprint });
        if (promptSets) annotateSharedWithLeader(rankedRows, promptSets, grouped.groups.find(group => group.comparable)?.headline);

        return {
            leaderboard,
            groups: grouped.groups,
            comparison: {
                comparableCount: grouped.comparableCount,
                authoritativeCount: grouped.authoritativeCount,
                groupCount: grouped.groupCount,
                scorerFamily: grouped.comparisonScorerFamily,
                selectedQualityCohortFingerprint,
                promptSet,
                rule: selectedQualityCohortFingerprint
                    ? 'quality cohort (judge, scorer version, contexts) covering the most models in scope, the most recent on a tie; results compared only on prompts as the catalog holds them today'
                    : 'every cohort pooled per model and host; one scorer generation per row'
            },
            categoryWeights,
            confidenceWeighted,
            axis,
            hostScope,
            hostFilterApplied,
            configuredHosts,
            primaryHostUrl,
            includeUnavailableModels,
            includeCloud,
            requestedAxis,
            selectedQualityCohortFingerprint,
            hostModelSnapshot: serializeHostModelSnapshot(availabilitySnapshot),
            challengeScope,
            challengeFilterApplied,
            challengeLevelRange: challengeScope === 'advanced'
                ? { min: 4, max: 5 }
                : challengeScope === 'foundation'
                    ? { min: 1, max: 3 }
                    : null
        };
    }
}

// Export singleton instance (preserves original API)
module.exports = new BenchmarkService();
