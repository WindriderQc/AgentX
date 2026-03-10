/**
 * Benchmark Results Module
 * Dashboard, statistics, and model comparison
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { calculateCompositeScore } = require('../qualityScorer');
const { calculateAllGeneralistScores } = require('./generalistScore');
const { INFRA_ERROR_REGEX } = require('./errorClassifier');

function calculatePercentDelta(currentValue, referenceValue) {
    const current = Number(currentValue);
    const reference = Number(referenceValue);
    if (!Number.isFinite(current) || !Number.isFinite(reference) || reference === 0) {
        return null;
    }
    return Number((((current - reference) / reference) * 100).toFixed(1));
}

function getHostTestFreshness(ageHours) {
    if (ageHours == null) return 'missing';
    if (ageHours <= 24) return 'fresh';
    if (ageHours <= 72) return 'aging';
    return 'stale';
}

function buildHostTestVerification(snapshot, benchmarkLatency, benchmarkTokensPerSec) {
    if (!snapshot) {
        return {
            host_test_verification: 'unverified',
            host_test_freshness: 'missing',
            host_test_age_hours: null,
            host_test_latency_delta_pct: null,
            host_test_tokens_delta_pct: null
        };
    }

    const ageHours = Math.max(0, Number(((Date.now() - new Date(snapshot.testedAt).getTime()) / 3600000).toFixed(1)));
    const freshness = getHostTestFreshness(ageHours);
    const latencyDelta = calculatePercentDelta(benchmarkLatency, snapshot.latencyMs);
    const tokensDelta = calculatePercentDelta(benchmarkTokensPerSec, snapshot.tokensPerSec);

    let verification = 'unverified';
    if (snapshot.status !== 'pass') {
        verification = snapshot.status === 'timeout' ? 'timeout' : 'failed';
    } else if (freshness === 'stale') {
        verification = 'stale';
    } else {
        const latencyAligned = latencyDelta == null || Math.abs(latencyDelta) <= 20;
        const tokensAligned = tokensDelta == null || Math.abs(tokensDelta) <= 20;
        verification = latencyAligned && tokensAligned ? 'aligned' : 'drift';
    }

    return {
        host_test_verification: verification,
        host_test_freshness: freshness,
        host_test_age_hours: ageHours,
        host_test_latency_delta_pct: latencyDelta,
        host_test_tokens_delta_pct: tokensDelta
    };
}

/**
 * Get paginated test results
 */
async function getResults({ limit = 20 } = {}) {
    const results = await BenchmarkResult.find()
        .sort({ timestamp: -1 })
        .limit(limit);

    const total = await BenchmarkResult.countDocuments();

    return { results, total };
}

/**
 * Generate summary statistics and leaderboard
 */
async function getSummary() {
    const successMatch = {
        success: true,
        model: { $not: /diagnostic/i } // Exclude diagnostic models
    };
    const failureMatch = {
        success: false,
        model: { $not: /diagnostic/i } // Exclude diagnostic models
    };

    const [failed, overallAgg, byModelAgg] = await Promise.all([
        BenchmarkResult.countDocuments(failureMatch),
        BenchmarkResult.aggregate([
            { $match: successMatch },
            {
                $group: {
                    _id: null,
                    successful: { $sum: 1 },
                    avg_latency: { $avg: '$latency' }
                }
            }
        ]),
        BenchmarkResult.aggregate([
            { $match: successMatch },
            {
                $group: {
                    _id: '$model',
                    avg_latency: { $avg: '$latency' },
                    avg_tokens_per_sec: { $avg: { $toDouble: '$tokens_per_sec' } },
                    tests: { $sum: 1 }
                }
            },
            { $sort: { avg_latency: 1 } }
        ])
    ]);

    const summary = overallAgg[0];
    const successful = summary ? summary.successful : 0;

    if (successful === 0) {
        return {
            total_tests: 0,
            successful: 0,
            failed: 0,
            avg_latency: 0,
            leaderboard: []
        };
    }

    const leaderboard = byModelAgg.map(item => ({
        model: item._id,
        avg_latency: Math.round(Number(item.avg_latency) || 0),
        avg_tokens_per_sec: item.avg_tokens_per_sec != null
            ? Number(item.avg_tokens_per_sec).toFixed(2)
            : 0,
        tests: Number(item.tests) || 0
    }));

    return {
        total_tests: successful + failed,
        successful,
        failed,
        avg_latency: Math.round(Number(summary.avg_latency) || 0),
        leaderboard
    };
}

/**
 * Get dashboard data with model statistics
 */
async function getDashboard({ sortBy = 'latency', modelCategory, promptCategory, tag } = {}) {
    // Build match query for filtering
    const matchQuery = {
        success: true
    };

    // Filter by prompt category
    if (promptCategory) {
        matchQuery.prompt_category = promptCategory;
    }

    // Filter by tag (batch-level)
    if (tag) {
        const batches = await BenchmarkBatch.find({ tags: tag }).distinct('_id');
        if (batches.length > 0) {
            matchQuery.batch_id = { $in: batches.map(b => b.toString()) };
        } else {
            // No batches with this tag - return empty results
            matchQuery.batch_id = { $in: [] };
        }
    }

    // Filter by model category (requires ModelRegistry lookup)
    let modelNames = null;
    if (modelCategory) {
        const ModelRegistry = require('../../../models/ModelRegistry');
        const models = await ModelRegistry.findByCategory(modelCategory);
        modelNames = models.map(m => m.modelName);

        if (modelNames.length > 0) {
            matchQuery.model = { $in: modelNames };
        } else {
            // No models in this category - return empty results
            matchQuery.model = { $in: [] };
        }
    }

    const scopedMatch = { ...matchQuery };
    delete scopedMatch.success;
    const failureMatchQuery = { ...scopedMatch, success: false };
    const totalMatchQuery = { ...scopedMatch };

    const judgeMatchQuery = { ...matchQuery, scoring_time_ms: { $ne: null } };

    const [totalTests, successCount, recentTests, modelStats, levelDistribution, failureStats, judgeStats, generalistScores] = await Promise.all([
        BenchmarkResult.countDocuments(totalMatchQuery),
        BenchmarkResult.countDocuments(matchQuery),
        BenchmarkResult.find(matchQuery).sort({ timestamp: -1 }).limit(10),
        BenchmarkResult.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: { model: '$model', host: '$host' },
                    avg_latency: { $avg: '$latency' },
                    avg_tokens_per_sec: { $avg: { $toDouble: '$tokens_per_sec' } },
                    avg_quality: {
                        $avg: {
                            $cond: [
                                { $ne: ['$quality_score', null] },
                                '$quality_score',
                                null
                            ]
                        }
                    },
                    avg_composite: {
                        $avg: {
                            $cond: [
                                { $ne: ['$composite_score', null] },
                                '$composite_score',
                                null
                            ]
                        }
                    },
                    quality_tests: {
                        $sum: {
                            $cond: [
                                { $ne: ['$quality_score', null] },
                                1,
                                0
                            ]
                        }
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { avg_latency: 1 } }
        ]),
        BenchmarkResult.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: {
                        model: '$model',
                        host: '$host',
                        level: '$prompt_level'
                    },
                    count: { $sum: 1 }
                }
            }
        ]),
        BenchmarkResult.aggregate([
            { $match: failureMatchQuery },
            {
                $addFields: {
                    __infra_error: {
                        $cond: [
                            { $eq: ['$infra_error', true] },
                            true,
                            {
                                $regexMatch: {
                                    input: { $ifNull: ['$error', ''] },
                                    regex: INFRA_ERROR_REGEX
                                }
                            }
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: { model: '$model', host: '$host' },
                    failed: { $sum: 1 },
                    infra_failed: { $sum: { $cond: ['$__infra_error', 1, 0] } },
                    model_failed: { $sum: { $cond: ['$__infra_error', 0, 1] } }
                }
            }
        ]),
        BenchmarkResult.aggregate([
            { $match: judgeMatchQuery },
            {
                $group: {
                    _id: { model: '$judge_model', host: '$judge_host' },
                    avg_latency: { $avg: '$scoring_time_ms' },
                    count: { $sum: 1 }
                }
            }
        ]),
        // Calculate generalist scores (with coverage penalty) for all models
        calculateAllGeneralistScores(matchQuery)
    ]);

    const failureByKey = new Map(
        (failureStats || []).map(s => [`${s._id.model}@@${s._id.host}`, {
            failed: s.failed || 0,
            infra_failed: s.infra_failed || 0,
            model_failed: s.model_failed || 0
        }])
    );
    const levelStatsByKey = new Map();
    for (const item of (levelDistribution || [])) {
        const level = Number(item && item._id ? item._id.level : NaN);
        if (!Number.isFinite(level)) continue;
        const key = `${item._id.model}@@${item._id.host}`;
        if (!levelStatsByKey.has(key)) {
            levelStatsByKey.set(key, {});
        }
        levelStatsByKey.get(key)[String(level)] = Number(item.count) || 0;
    }

    // Helper to format composite score (0-100) to display scale (0-10)
    const fmtScore = (s) => (s !== null && s !== undefined && !isNaN(s)) ? (s / 10).toFixed(1) : null;

    // Format and sort model stats
    const successByKey = new Map();
    let sortedStats = modelStats.map(m => {
        const hasQuality = m.avg_quality != null && !isNaN(m.avg_quality);

        // Raw quality (0-10 scale) for display
        const rawQuality = m.avg_quality ?? 0;

        const avgLatency = Number(m.avg_latency) || 0;
        const avgTokens = parseFloat(m.avg_tokens_per_sec) || 0;

        const key = `${m._id.model}@@${m._id.host}`;

        // Get generalist score (with coverage penalty and consistency bonus)
        // This is the single source of truth for quality scoring
        const generalistData = generalistScores.get(key);
        // Generalist score is 0-100 scale, convert to 0-10 for composite calculation
        const adjustedQuality = generalistData
            ? generalistData.generalistScore / 10
            : rawQuality;

        // Calculate profiles using ADJUSTED quality (generalist score)
        const metricsInput = { latency: avgLatency, tokens_per_sec: avgTokens, quality_score: adjustedQuality };
        const balanced = calculateCompositeScore(metricsInput, 'balanced');
        const interactive = calculateCompositeScore(metricsInput, 'interactive');
        const reasoning = calculateCompositeScore(metricsInput, 'reasoning');
        const coding = calculateCompositeScore(metricsInput, 'coding');

        const fail = failureByKey.get(key) || { failed: 0, infra_failed: 0, model_failed: 0 };
        const failedTests = fail.failed || 0;
        const infraFailedTests = fail.infra_failed || 0;
        const modelFailedTests = fail.model_failed || 0;
        const successTests = m.count || 0;

        successByKey.set(key, true);

        return {
            model: m._id.model,
            host: m._id.host,
            avg_latency: Math.round(avgLatency),
            avg_tokens_per_sec: avgTokens.toFixed(2),
            // Display adjusted quality (generalist score on 0-10 scale)
            avg_quality: hasQuality ? adjustedQuality.toFixed(1) : null,
            // Also include raw quality for reference
            raw_quality: hasQuality ? rawQuality.toFixed(1) : null,

            // Generalist breakdown (for transparency)
            generalist_breakdown: generalistData ? {
                coverage: generalistData.coverage,
                coveragePenalty: generalistData.coveragePenalty,
                consistencyBonus: generalistData.consistencyBonus,
                avgWithinCategoryStdDev: generalistData.avgWithinCategoryStdDev,
                testedCategories: generalistData.testedCategories
            } : null,

            // Dynamic scores (converted to 0-10 scale)
            balanced_score: fmtScore(balanced.composite_score),
            interactive_score: fmtScore(interactive.composite_score),
            reasoning_score: fmtScore(reasoning.composite_score),
            coding_score: fmtScore(coding.composite_score),

            // Normalized component scores for frontend (0-10 scale)
            normalized_quality: balanced.normalized ? (balanced.normalized.quality / 10).toFixed(1) : null,
            normalized_latency: balanced.normalized ? (balanced.normalized.latency / 10).toFixed(1) : null,
            normalized_speed: balanced.normalized ? (balanced.normalized.speed / 10).toFixed(1) : null,

            // Legacy field for compat
            avg_composite: fmtScore(balanced.composite_score),

            quality_tests: m.quality_tests || 0,
            level_stats: levelStatsByKey.get(key) || {},
            tests: successTests,
            failed_tests: failedTests,
            infra_failed_tests: infraFailedTests,
            model_failed_tests: modelFailedTests,
            total_tests: successTests + failedTests,
            failure_only: false,
            filtered: generalistData?.filtered || false,
            emptyRate: generalistData?.emptyRate || 0
        };
    });

    // Add failure-only model/host combos so issues are visible in the leaderboard.
    for (const [key, failedTests] of failureByKey.entries()) {
        if (successByKey.has(key)) continue;
        const [model, host] = key.split('@@');
        const fail = failureByKey.get(key) || { failed: 0, infra_failed: 0, model_failed: 0 };
        sortedStats.push({
            model,
            host,
            avg_latency: 0,
            avg_tokens_per_sec: '0',
            avg_quality: null,
            avg_composite: null,
            balanced_score: fmtScore(0),
            interactive_score: fmtScore(0),
            reasoning_score: fmtScore(0),
            coding_score: fmtScore(0),
            quality_tests: 0,
            level_stats: {},
            tests: 0,
            failed_tests: fail.failed || 0,
            infra_failed_tests: fail.infra_failed || 0,
            model_failed_tests: fail.model_failed || 0,
            total_tests: fail.failed || 0,
            failure_only: true
        });
    }

    // Enrich with ModelRegistry data (recommended category, manual categories)
    const ModelRegistry = require('../../../models/ModelRegistry');
    const uniqueModelNames = [...new Set(sortedStats.map(s => s.model))];
    const registryModels = await ModelRegistry.find({
        modelName: { $in: uniqueModelNames }
    }).lean();
    const hostPerformanceByModel = await ModelRegistry.getLatestHostPerformanceForModels(uniqueModelNames);

    const registryByName = new Map();
    registryModels.forEach(rm => {
        registryByName.set(rm.modelName, rm);
    });

    sortedStats = sortedStats.map(stat => {
        const registryData = registryByName.get(stat.model);
        const hostPerfSummary = hostPerformanceByModel[stat.model] || { latestAny: null, latestPass: null, byHost: {} };
        const byExactHost = hostPerfSummary.byHost?.[stat.host];
        const hostSnapshot = byExactHost?.latestPass || byExactHost?.latest || hostPerfSummary.latestPass || hostPerfSummary.latestAny;
        const verification = buildHostTestVerification(
            hostSnapshot,
            stat.avg_latency,
            parseFloat(stat.avg_tokens_per_sec)
        );

        return {
            ...stat,
            recommended_category: registryData?.benchmarkStats?.bestCategory || null,
            manual_categories: registryData?.categories || [],
            host_test_status: hostSnapshot?.status || null,
            host_test_tokens_per_sec: hostSnapshot?.tokensPerSec ?? null,
            host_test_latency_ms: hostSnapshot?.latencyMs ?? null,
            host_test_ttft_ms: hostSnapshot?.timeToFirstTokenMs ?? null,
            host_test_vram_used_mib: hostSnapshot?.vramUsedMiB ?? null,
            host_test_vram_total_mib: hostSnapshot?.vramTotalMiB ?? null,
            host_test_tested_at: hostSnapshot?.testedAt || null,
            host_test_error: hostSnapshot?.error || null,
            ...verification
        };
    });

    // Apply sorting
    switch (sortBy) {
        case 'reliability':
            sortedStats.sort((a, b) => {
                if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;

                // Reliability should not be penalized by infra failures.
                // Compute failure rate using model_failed only, with denominator = successes + model_failed.
                const aSuccess = Number(a.tests) || 0;
                const bSuccess = Number(b.tests) || 0;
                const aModelFailed = Number(a.model_failed_tests ?? a.failed_tests) || 0;
                const bModelFailed = Number(b.model_failed_tests ?? b.failed_tests) || 0;
                const aDen = aSuccess + aModelFailed;
                const bDen = bSuccess + bModelFailed;
                const aRate = aDen > 0 ? (aModelFailed / aDen) : 0;
                const bRate = bDen > 0 ? (bModelFailed / bDen) : 0;
                if (aRate !== bRate) return aRate - bRate;
                // Tie-breakers: more samples first, then latency
                const aTotal = Number(a.total_tests) || 0;
                const bTotal = Number(b.total_tests) || 0;
                if (aTotal !== bTotal) return bTotal - aTotal;
                return a.avg_latency - b.avg_latency;
            });
            break;
        case 'quality':
            sortedStats.sort((a, b) => {
                if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                return (Number(b.avg_quality) || 0) - (Number(a.avg_quality) || 0);
            });
            break;
        case 'composite':
        case 'interactive':
            sortedStats.sort((a, b) => {
                if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                const diff = (Number(b.interactive_score) || 0) - (Number(a.interactive_score) || 0);
                return diff !== 0 ? diff : a.model.localeCompare(b.model); // Stable tie-breaker
            });
            break;
        case 'reasoning':
            sortedStats.sort((a, b) => {
                if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                const diff = (Number(b.reasoning_score) || 0) - (Number(a.reasoning_score) || 0);
                return diff !== 0 ? diff : a.model.localeCompare(b.model); // Stable tie-breaker
            });
            break;
        case 'coding':
            sortedStats.sort((a, b) => {
                if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                const diff = (Number(b.coding_score) || 0) - (Number(a.coding_score) || 0);
                return diff !== 0 ? diff : a.model.localeCompare(b.model); // Stable tie-breaker
            });
            break;
        case 'speed':
            sortedStats.sort((a, b) => {
                if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                return parseFloat(b.avg_tokens_per_sec) - parseFloat(a.avg_tokens_per_sec);
            });
            break;
        case 'latency':
        default:
            sortedStats.sort((a, b) => {
                if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                return a.avg_latency - b.avg_latency;
            });
    }

    return {
        overview: {
            total_tests: totalTests,
            successful: successCount,
            failed: totalTests - successCount,
            success_rate: totalTests > 0
                ? ((successCount / totalTests) * 100).toFixed(1) + '%'
                : '0%'
        },
        recent_tests: recentTests,
        model_stats: sortedStats,
        judge_stats: judgeStats,
        sorted_by: sortBy
    };
}

/**
 * Compare multiple models
 */
async function compareModels(models) {
    if (!models || !Array.isArray(models)) {
        throw new Error('models array is required');
    }

    const comparison = await Promise.all(
        models.map(model => BenchmarkResult.getModelStats(model))
    );

    return { comparison };
}

/**
 * Get quality score breakdown by category and level
 */
async function getQualityBreakdown(model = null, host = null) {
    const { byCategory, byLevel, byModel } = await BenchmarkResult.getQualityBreakdown(model, host);

    // Restructure category data by model
    const categoryByModel = {};
    byCategory.forEach(item => {
        const modelName = item._id.model;
        if (!categoryByModel[modelName]) categoryByModel[modelName] = {};
        categoryByModel[modelName][item._id.category] = {
            avg_quality: item.avg_quality.toFixed(1),
            avg_latency: Math.round(item.avg_latency),
            tests: item.count
        };
    });

    // Restructure level data by model
    const levelByModel = {};
    byLevel.forEach(item => {
        const modelName = item._id.model;
        if (!levelByModel[modelName]) levelByModel[modelName] = {};
        levelByModel[modelName][`level_${item._id.level}`] = {
            avg_quality: item.avg_quality.toFixed(1),
            avg_latency: Math.round(item.avg_latency),
            tests: item.count
        };
    });

    const categories = Array.from(new Set(
        byCategory
            .map(item => item && item._id ? item._id.category : null)
            .filter(Boolean)
    )).sort();

    const levels = Array.from(new Set(
        byLevel
            .map(item => Number(item && item._id ? item._id.level : NaN))
            .filter(Number.isFinite)
    )).sort((a, b) => a - b);

    return {
        overall: byModel.map(m => ({
            model: m._id,
            avg_quality: m.avg_quality.toFixed(1),
            avg_composite: m.avg_composite ? m.avg_composite.toFixed(1) : null,
            avg_latency: Math.round(m.avg_latency),
            quality_range: {
                max: m.max_quality_score.toFixed(1),
                min: m.min_quality_score.toFixed(1)
            },
            tests: m.count
        })),
        by_category: categoryByModel,
        by_level: levelByModel,
        categories,
        levels
    };
}

/**
 * Get time-series analytics for model performance trends
 */
async function getModelTrends({ model, days = 7, groupBy = 'day' } = {}) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const matchStage = {
        timestamp: { $gte: cutoff },
        success: true
    };

    if (model) {
        matchStage.model = model;
    }

    // Determine grouping based on parameter
    let dateGroup;
    switch (groupBy) {
        case 'hour':
            dateGroup = {
                year: { $year: '$timestamp' },
                month: { $month: '$timestamp' },
                day: { $dayOfMonth: '$timestamp' },
                hour: { $hour: '$timestamp' }
            };
            break;
        case 'day':
        default:
            dateGroup = {
                year: { $year: '$timestamp' },
                month: { $month: '$timestamp' },
                day: { $dayOfMonth: '$timestamp' }
            };
    }

    const trends = await BenchmarkResult.aggregate([
        { $match: matchStage },
        {
            $group: {
                _id: {
                    ...dateGroup,
                    ...(model ? {} : { model: '$model' })
                },
                avg_latency: { $avg: '$latency' },
                avg_tokens_per_sec: { $avg: { $toDouble: '$tokens_per_sec' } },
                avg_quality: { $avg: '$quality_score' },
                avg_composite: { $avg: '$composite_score' },
                tests_count: { $sum: 1 },
                total_tokens: { $sum: '$tokens' }
            }
        },
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } }
    ]);

    return {
        trends,
        period: { days, groupBy },
        model: model || 'all'
    };
}

/**
 * Get comparative batch analysis
 */
async function compareBatches(batchIds) {
    if (!Array.isArray(batchIds) || batchIds.length === 0) {
        throw new Error('batchIds array is required');
    }

    const batches = await Promise.all(
        batchIds.map(id => BenchmarkBatch.findById(id))
    );

    const validBatches = batches.filter(b => b !== null);

    if (validBatches.length === 0) {
        throw new Error('No valid batches found');
    }

    const comparison = await Promise.all(validBatches.map(async batch => {
        // Calculate aggregated scores for this batch
        let avg_quality = null;
        let avg_composite = null;

        const scores = await BenchmarkResult.aggregate([
            { $match: { batch_id: batch._id.toString() } },
            {
                $group: {
                    _id: null,
                    avg_quality: { $avg: '$quality_score' },
                    avg_composite: { $avg: '$composite_score' }
                }
            }
        ]);
        if (scores.length > 0) {
            avg_quality = scores[0].avg_quality !== null ? parseFloat(scores[0].avg_quality.toFixed(1)) : null;
            avg_composite = scores[0].avg_composite !== null ? parseFloat(scores[0].avg_composite.toFixed(1)) : null;
        }

        return {
            batch_id: batch._id.toString(),
            run_name: batch.run_name,
            models: batch.models,
            status: batch.status,
            total_tests: batch.total_tests,
            completed: batch.completed,
            success_rate: batch.success_rate,
            execution_metrics: batch.execution_metrics,
            config_snapshot: batch.config_snapshot,
            created_at: batch.created_at,
            completed_at: batch.completed_at,
            avg_quality,
            avg_composite
        };
    }));

    // Calculate comparative statistics
    const stats = {
        avg_duration_ms: null,
        avg_tests_per_minute: null,
        avg_tokens_generated: null,
        fastest_batch: null,
        slowest_batch: null
    };

    const durations = validBatches
        .filter(b => b.execution_metrics?.total_duration_ms)
        .map(b => ({
            id: b._id.toString(),
            name: b.run_name,
            duration: b.execution_metrics.total_duration_ms
        }));

    if (durations.length > 0) {
        stats.avg_duration_ms = Math.round(
            durations.reduce((a, b) => a + b.duration, 0) / durations.length
        );
        stats.fastest_batch = durations.reduce((a, b) => (a.duration < b.duration ? a : b));
        stats.slowest_batch = durations.reduce((a, b) => (a.duration > b.duration ? a : b));
    }

    const throughputs = validBatches
        .filter(b => b.execution_metrics?.tests_per_minute)
        .map(b => b.execution_metrics.tests_per_minute);

    if (throughputs.length > 0) {
        stats.avg_tests_per_minute = Math.round(
            throughputs.reduce((a, b) => a + b, 0) / throughputs.length
        );
    }

    const tokens = validBatches
        .filter(b => b.execution_metrics?.total_tokens_generated)
        .map(b => b.execution_metrics.total_tokens_generated);

    if (tokens.length > 0) {
        stats.avg_tokens_generated = Math.round(
            tokens.reduce((a, b) => a + b, 0) / tokens.length
        );
    }

    return { comparison, stats };
}

module.exports = {
    getResults,
    getSummary,
    getDashboard,
    compareModels,
    getQualityBreakdown,
    getModelTrends,
    compareBatches
};
