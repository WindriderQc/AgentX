/**
 * Judge Validation Service
 * Comprehensive validation framework for LLM-as-Judge performance
 *
 * Features:
 * - Consistency testing (same input → consistent output)
 * - Ground truth evaluation (compare to expert scores)
 * - Bias detection (model favoritism, length bias, format bias)
 * - Calibration analysis (score distribution, discrimination)
 * - Failure mode analysis
 */

const logger = require('../../config/logger');
const BenchmarkResult = require('../../models/BenchmarkResult');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const { scoreResponse, JUDGE_CONFIG, ENHANCED_SCORING_CONFIGS } = require('./qualityScorer');

/**
 * Run consistency test on a sample of results
 * Re-judges same responses multiple times to measure score variance
 *
 * @param {Object} options
 * @param {number} options.sampleSize - Number of results to test (default: 10)
 * @param {number} options.repeats - Times to re-judge each result (default: 3)
 * @param {string} options.category - Optional category filter
 * @returns {Promise<Object>} Consistency metrics
 */
async function runConsistencyTest(options = {}) {
    const {
        sampleSize = 10,
        repeats = 3,
        category = null,
        judgeConfig = {}
    } = options;

    logger.info('Starting judge consistency test', { sampleSize, repeats, category });

    // Get random sample of successful results with quality scores
    const matchQuery = {
        success: true,
        quality_score: { $ne: null },
        scoring_method: 'llm_judge',
        response: { $ne: '', $exists: true }
    };

    if (category) {
        matchQuery.prompt_category = category;
    }

    const samples = await BenchmarkResult.aggregate([
        { $match: matchQuery },
        { $sample: { size: sampleSize } }
    ]);

    if (samples.length === 0) {
        return {
            success: false,
            error: 'No suitable samples found for consistency testing',
            samples_found: 0
        };
    }

    const results = [];
    let totalVariance = 0;
    let maxVariance = 0;

    for (const sample of samples) {
        const scores = [];
        const dimensionScores = {};

        // Re-judge multiple times
        for (let i = 0; i < repeats; i++) {
            try {
                const scoreResult = await scoreResponse({
                    response: sample.response,
                    prompt: {
                        prompt: sample.prompt,
                        expected_answer: sample.expected_answer,
                        scoring_type: sample.prompt_category || 'general',
                        name: sample.prompt_name
                    },
                    judgeConfig: {
                        ...JUDGE_CONFIG,
                        ...judgeConfig
                    }
                });

                if (scoreResult.quality_score !== null && scoreResult.quality_score !== undefined) {
                    scores.push(scoreResult.quality_score);

                    // Track dimension scores
                    if (scoreResult.breakdown) {
                        for (const [dim, val] of Object.entries(scoreResult.breakdown)) {
                            if (typeof val === 'number') {
                                if (!dimensionScores[dim]) dimensionScores[dim] = [];
                                dimensionScores[dim].push(val);
                            }
                        }
                    }
                }
            } catch (err) {
                logger.warn('Consistency test iteration failed', {
                    sample_id: sample._id,
                    iteration: i,
                    error: err.message
                });
            }
        }

        if (scores.length >= 2) {
            // Calculate variance
            const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
            const variance = scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length;
            const stdDev = Math.sqrt(variance);

            // Calculate dimension variances
            const dimensionVariances = {};
            for (const [dim, vals] of Object.entries(dimensionScores)) {
                if (vals.length >= 2) {
                    const dimMean = vals.reduce((a, b) => a + b, 0) / vals.length;
                    const dimVar = vals.reduce((sum, v) => sum + Math.pow(v - dimMean, 2), 0) / vals.length;
                    dimensionVariances[dim] = {
                        mean: Math.round(dimMean * 100) / 100,
                        stdDev: Math.round(Math.sqrt(dimVar) * 100) / 100
                    };
                }
            }

            totalVariance += stdDev;
            maxVariance = Math.max(maxVariance, stdDev);

            results.push({
                result_id: sample._id.toString(),
                prompt_name: sample.prompt_name,
                category: sample.prompt_category,
                original_score: sample.quality_score,
                scores,
                mean: Math.round(mean * 100) / 100,
                stdDev: Math.round(stdDev * 100) / 100,
                range: Math.round((Math.max(...scores) - Math.min(...scores)) * 100) / 100,
                dimension_variances: dimensionVariances
            });
        }
    }

    const avgStdDev = results.length > 0 ? totalVariance / results.length : 0;
    const consistencyScore = Math.max(0, 100 - (avgStdDev * 20)); // 0.5 stdDev = 90 score

    if (results.length === 0) {
        return {
            success: false,
            error: 'Consistency test produced no successful re-judged samples',
            summary: {
                samples_tested: 0,
                repeats_per_sample: repeats,
                avg_std_dev: null,
                max_std_dev: null,
                consistency_score: null,
                pass: false
            },
            details: [],
            thresholds: {
                target_std_dev: 0.5,
                excellent: 0.3,
                acceptable: 0.5,
                poor: 1.0
            }
        };
    }

    return {
        success: true,
        summary: {
            samples_tested: results.length,
            repeats_per_sample: repeats,
            avg_std_dev: Math.round(avgStdDev * 1000) / 1000,
            max_std_dev: Math.round(maxVariance * 1000) / 1000,
            consistency_score: Math.round(consistencyScore * 10) / 10,
            pass: avgStdDev < 0.5 // Target: σ < 0.5 points
        },
        details: results,
        thresholds: {
            target_std_dev: 0.5,
            excellent: 0.3,
            acceptable: 0.5,
            poor: 1.0
        }
    };
}

/**
 * Run ground truth evaluation
 * Compares judge scores against expert-assigned reference scores
 *
 * @param {Object} options
 * @param {string} options.category - Optional category filter
 * @param {number} options.limit - Max entries to evaluate
 * @returns {Promise<Object>} Accuracy metrics
 */
async function runGroundTruthEvaluation(options = {}) {
    const {
        category = null,
        limit = 50,
        judgeConfig = {}
    } = options;

    logger.info('Starting ground truth evaluation', { category, limit });

    // Get ground truth entries
    const queryOptions = { limit, random: true };
    if (category) {
        queryOptions.category = category;
    }

    const groundTruth = await JudgeGroundTruth.getForValidation(queryOptions);

    if (!groundTruth || groundTruth.length === 0) {
        return {
            success: false,
            error: 'No ground truth entries found. Seed the database first.',
            entries_found: 0
        };
    }

    const results = [];
    let totalDeviation = 0;
    let totalSquaredDeviation = 0;

    for (const entry of groundTruth) {
        try {
            const scoreResult = await scoreResponse({
                response: entry.response,
                prompt: {
                    prompt: entry.prompt,
                    expected_answer: entry.expected_answer,
                    scoring_type: entry.category,
                    name: entry.name
                },
                judgeConfig: {
                    ...JUDGE_CONFIG,
                    ...judgeConfig
                }
            });

            const judgeScore = scoreResult.quality_score;
            const expertScore = entry.expert_scores.overall;
            const deviation = Math.abs(judgeScore - expertScore);

            totalDeviation += deviation;
            totalSquaredDeviation += deviation * deviation;

            // Record validation in ground truth entry
            const gtDoc = await JudgeGroundTruth.findById(entry._id);
            if (gtDoc) {
                await gtDoc.recordValidation({
                    judge_model: judgeConfig.model || JUDGE_CONFIG.model,
                    judge_score: judgeScore,
                    dimension_scores: scoreResult.breakdown
                });
            }

            results.push({
                name: entry.name,
                category: entry.category,
                difficulty: entry.difficulty,
                expert_score: expertScore,
                judge_score: judgeScore,
                deviation: Math.round(deviation * 100) / 100,
                direction: judgeScore > expertScore ? 'over' : (judgeScore < expertScore ? 'under' : 'exact')
            });
        } catch (err) {
            logger.warn('Ground truth evaluation failed for entry', {
                name: entry.name,
                error: err.message
            });
        }
    }

    if (results.length === 0) {
        return {
            success: false,
            error: 'All evaluations failed',
            entries_attempted: groundTruth.length
        };
    }

    const mae = totalDeviation / results.length;
    const rmse = Math.sqrt(totalSquaredDeviation / results.length);

    // Calculate Pearson correlation
    const expertScores = results.map(r => r.expert_score);
    const judgeScores = results.map(r => r.judge_score);
    const correlation = calculatePearsonCorrelation(expertScores, judgeScores);

    // Score distribution analysis
    const overCount = results.filter(r => r.direction === 'over').length;
    const underCount = results.filter(r => r.direction === 'under').length;
    const exactCount = results.filter(r => r.direction === 'exact').length;

    return {
        success: true,
        summary: {
            entries_evaluated: results.length,
            mean_absolute_error: Math.round(mae * 1000) / 1000,
            rmse: Math.round(rmse * 1000) / 1000,
            pearson_correlation: Math.round(correlation * 1000) / 1000,
            bias_direction: {
                over_scoring: overCount,
                under_scoring: underCount,
                exact: exactCount,
                bias: overCount > underCount ? 'tends_high' : (underCount > overCount ? 'tends_low' : 'balanced')
            },
            accuracy_grade: mae < 0.5 ? 'A' : (mae < 1.0 ? 'B' : (mae < 1.5 ? 'C' : (mae < 2.0 ? 'D' : 'F')))
        },
        details: results,
        thresholds: {
            excellent_mae: 0.5,
            good_mae: 1.0,
            acceptable_mae: 1.5,
            poor_mae: 2.0
        }
    };
}

/**
 * Run bias detection tests
 * Checks for model favoritism, length bias, and format bias
 *
 * @param {Object} options
 * @returns {Promise<Object>} Bias analysis results
 */
async function runBiasDetection(options = {}) {
    const { sampleSize = 100 } = options;

    logger.info('Starting bias detection analysis', { sampleSize });

    // Get sample of results across different models
    const results = await BenchmarkResult.aggregate([
        {
            $match: {
                success: true,
                quality_score: { $ne: null },
                scoring_method: 'llm_judge'
            }
        },
        { $sample: { size: sampleSize } }
    ]);

    if (results.length < 20) {
        return {
            success: false,
            error: 'Insufficient data for bias analysis',
            samples_found: results.length
        };
    }

    // Length bias analysis
    const lengthBuckets = {
        short: { scores: [], threshold: 200 },      // < 200 chars
        medium: { scores: [], threshold: 1000 },    // 200-1000 chars
        long: { scores: [], threshold: 5000 },      // 1000-5000 chars
        very_long: { scores: [], threshold: Infinity } // > 5000 chars
    };

    for (const r of results) {
        const len = (r.response || '').length;
        if (len < 200) lengthBuckets.short.scores.push(r.quality_score);
        else if (len < 1000) lengthBuckets.medium.scores.push(r.quality_score);
        else if (len < 5000) lengthBuckets.long.scores.push(r.quality_score);
        else lengthBuckets.very_long.scores.push(r.quality_score);
    }

    const lengthBias = {};
    for (const [bucket, data] of Object.entries(lengthBuckets)) {
        if (data.scores.length > 0) {
            lengthBias[bucket] = {
                count: data.scores.length,
                avg_score: Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 100) / 100
            };
        }
    }

    // Model favoritism analysis (by model being tested)
    const modelScores = {};
    for (const r of results) {
        if (!modelScores[r.model]) {
            modelScores[r.model] = [];
        }
        modelScores[r.model].push(r.quality_score);
    }

    const modelBias = {};
    for (const [model, scores] of Object.entries(modelScores)) {
        if (scores.length >= 3) {
            modelBias[model] = {
                count: scores.length,
                avg_score: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
                std_dev: Math.round(calculateStdDev(scores) * 100) / 100
            };
        }
    }

    // Format bias analysis (code blocks, markdown, etc.)
    const formatAnalysis = {
        has_code_block: { scores: [], count: 0 },
        has_markdown: { scores: [], count: 0 },
        plain_text: { scores: [], count: 0 }
    };

    for (const r of results) {
        const response = r.response || '';
        if (response.includes('```')) {
            formatAnalysis.has_code_block.scores.push(r.quality_score);
            formatAnalysis.has_code_block.count++;
        } else if (response.includes('**') || response.includes('##') || response.includes('- ')) {
            formatAnalysis.has_markdown.scores.push(r.quality_score);
            formatAnalysis.has_markdown.count++;
        } else {
            formatAnalysis.plain_text.scores.push(r.quality_score);
            formatAnalysis.plain_text.count++;
        }
    }

    const formatBias = {};
    for (const [format, data] of Object.entries(formatAnalysis)) {
        if (data.scores.length > 0) {
            formatBias[format] = {
                count: data.count,
                avg_score: Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 100) / 100
            };
        }
    }

    // Category bias analysis
    const categoryScores = {};
    for (const r of results) {
        const cat = r.prompt_category || 'unknown';
        if (!categoryScores[cat]) categoryScores[cat] = [];
        categoryScores[cat].push(r.quality_score);
    }

    const categoryBias = {};
    for (const [cat, scores] of Object.entries(categoryScores)) {
        if (scores.length >= 3) {
            categoryBias[cat] = {
                count: scores.length,
                avg_score: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
            };
        }
    }

    // Detect significant biases
    const avgScores = Object.values(lengthBias).map(b => b.avg_score);
    const overallAvg = avgScores.reduce((a, b) => a + b, 0) / avgScores.length;
    const lengthBiasDetected = Math.max(...avgScores) - Math.min(...avgScores) > 1.0;

    return {
        success: true,
        summary: {
            samples_analyzed: results.length,
            length_bias_detected: lengthBiasDetected,
            length_bias_severity: lengthBiasDetected ? 'significant' : 'minimal',
            models_analyzed: Object.keys(modelBias).length
        },
        length_bias: lengthBias,
        model_bias: modelBias,
        format_bias: formatBias,
        category_bias: categoryBias,
        recommendations: generateBiasRecommendations(lengthBias, formatBias)
    };
}

/**
 * Run calibration analysis
 * Checks if scores are well-distributed and meaningful
 *
 * @param {Object} options
 * @returns {Promise<Object>} Calibration metrics
 */
async function runCalibrationAnalysis(options = {}) {
    const { days = 30 } = options;

    logger.info('Starting calibration analysis', { days });

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const results = await BenchmarkResult.find({
        success: true,
        quality_score: { $ne: null },
        scoring_method: 'llm_judge',
        timestamp: { $gte: cutoffDate }
    }).select('quality_score prompt_category prompt_level');

    if (results.length < 50) {
        return {
            success: false,
            error: 'Insufficient data for calibration analysis',
            samples_found: results.length
        };
    }

    const scores = results.map(r => r.quality_score);

    // Score distribution histogram (0-10 in 0.5 increments)
    const histogram = {};
    for (let i = 0; i <= 20; i++) {
        histogram[i / 2] = 0;
    }
    for (const score of scores) {
        const bucket = Math.round(score * 2) / 2;
        histogram[bucket] = (histogram[bucket] || 0) + 1;
    }

    // Calculate distribution metrics
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const stdDev = calculateStdDev(scores);
    const median = calculateMedian(scores);
    const skewness = calculateSkewness(scores, mean, stdDev);

    // Check for clustering (too many scores in narrow range)
    const clusteringScore = calculateClusteringScore(histogram, scores.length);

    // Discrimination analysis (can judge distinguish difficulty levels?)
    const levelScores = {};
    for (const r of results) {
        const level = r.prompt_level || 'unknown';
        if (!levelScores[level]) levelScores[level] = [];
        levelScores[level].push(r.quality_score);
    }

    const levelAvgs = {};
    for (const [level, lvlScores] of Object.entries(levelScores)) {
        if (lvlScores.length >= 5) {
            levelAvgs[level] = Math.round((lvlScores.reduce((a, b) => a + b, 0) / lvlScores.length) * 100) / 100;
        }
    }

    // Check if harder levels get lower scores (expected)
    const levels = Object.keys(levelAvgs).filter(l => !isNaN(parseInt(l))).map(l => parseInt(l)).sort((a, b) => a - b);
    let discriminationOk = true;
    for (let i = 1; i < levels.length; i++) {
        // Higher level should have same or lower avg score
        if (levelAvgs[levels[i]] > levelAvgs[levels[i - 1]] + 0.5) {
            discriminationOk = false;
            break;
        }
    }

    return {
        success: true,
        summary: {
            samples_analyzed: scores.length,
            mean: Math.round(mean * 100) / 100,
            median: Math.round(median * 100) / 100,
            std_dev: Math.round(stdDev * 100) / 100,
            skewness: Math.round(skewness * 100) / 100,
            clustering_score: clusteringScore,
            discrimination_ok: discriminationOk,
            calibration_grade: getCalibrationGrade(clusteringScore, stdDev, discriminationOk)
        },
        histogram,
        level_discrimination: levelAvgs,
        interpretation: {
            skewness: skewness > 0.5 ? 'right-skewed (tends high)' : (skewness < -0.5 ? 'left-skewed (tends low)' : 'approximately symmetric'),
            spread: stdDev > 2 ? 'good spread' : (stdDev > 1 ? 'moderate spread' : 'narrow spread (potential issue)'),
            clustering: clusteringScore > 70 ? 'well distributed' : (clusteringScore > 50 ? 'some clustering' : 'significant clustering (scores bunch together)')
        }
    };
}

/**
 * Run failure mode analysis
 * Analyzes when and why judge fails
 *
 * @param {Object} options
 * @returns {Promise<Object>} Failure analysis
 */
async function runFailureModeAnalysis(options = {}) {
    const { days = 30 } = options;

    logger.info('Starting failure mode analysis', { days });

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    // Get all judge results including failures
    const [successResults, failedResults] = await Promise.all([
        BenchmarkResult.countDocuments({
            scoring_method: 'llm_judge',
            timestamp: { $gte: cutoffDate }
        }),
        BenchmarkResult.find({
            scoring_method: 'llm_failed',
            timestamp: { $gte: cutoffDate }
        }).select('prompt_category prompt_level quality_explanation judge_model timestamp')
    ]);

    const totalAttempts = successResults + failedResults.length;
    const failureRate = totalAttempts > 0 ? (failedResults.length / totalAttempts) * 100 : 0;

    // Analyze failure reasons
    const failureReasons = {};
    const failuresByCategory = {};
    const failuresByLevel = {};

    for (const f of failedResults) {
        // Extract reason from explanation
        const reason = categorizeFailure(f.quality_explanation || '');
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;

        // By category
        const cat = f.prompt_category || 'unknown';
        failuresByCategory[cat] = (failuresByCategory[cat] || 0) + 1;

        // By level
        const level = f.prompt_level || 'unknown';
        failuresByLevel[level] = (failuresByLevel[level] || 0) + 1;
    }

    // Get empty response stats
    const emptyResponses = await BenchmarkResult.countDocuments({
        scoring_method: 'empty_response',
        timestamp: { $gte: cutoffDate }
    });

    // Get out-of-range score incidents (logged in quality_explanation)
    const outOfRangeResults = await BenchmarkResult.find({
        scoring_method: 'llm_judge',
        quality_explanation: { $regex: /out.of.range|clamped/i },
        timestamp: { $gte: cutoffDate }
    }).countDocuments();

    return {
        success: true,
        summary: {
            period_days: days,
            total_judge_attempts: totalAttempts,
            successful: successResults,
            failed: failedResults.length,
            failure_rate: Math.round(failureRate * 100) / 100,
            empty_responses: emptyResponses,
            out_of_range_scores: outOfRangeResults
        },
        failure_reasons: failureReasons,
        failures_by_category: failuresByCategory,
        failures_by_level: failuresByLevel,
        health_status: failureRate < 5 ? 'healthy' : (failureRate < 15 ? 'degraded' : 'unhealthy'),
        recommendations: generateFailureRecommendations(failureReasons, failureRate)
    };
}

/**
 * Run comprehensive judge health check
 * Combines all analyses into a single health report
 */
async function runHealthCheck(options = {}) {
    const startTime = Date.now();

    logger.info('Starting comprehensive judge health check');

    const [consistency, calibration, bias, failures] = await Promise.all([
        runConsistencyTest({ sampleSize: 5, repeats: 3, ...options }).catch(err => ({ success: false, error: err.message })),
        runCalibrationAnalysis(options).catch(err => ({ success: false, error: err.message })),
        runBiasDetection({ sampleSize: 50, ...options }).catch(err => ({ success: false, error: err.message })),
        runFailureModeAnalysis(options).catch(err => ({ success: false, error: err.message }))
    ]);

    // Calculate overall health score (0-100)
    let healthScore = 100;
    const issues = [];

    if (consistency.success && consistency.summary) {
        if ((consistency.summary.samples_tested || 0) < 1) {
            healthScore -= 20;
            issues.push('Consistency validation has zero successful samples');
        }
        if (consistency.summary.avg_std_dev > 0.5) {
            healthScore -= 20;
            issues.push('High score variance (inconsistent judging)');
        } else if (consistency.summary.avg_std_dev > 0.3) {
            healthScore -= 10;
            issues.push('Moderate score variance');
        }
    } else {
        healthScore -= 10;
        issues.push('Consistency test failed');
    }

    if (calibration.success && calibration.summary) {
        if (calibration.summary.clustering_score < 50) {
            healthScore -= 15;
            issues.push('Poor score distribution (clustering)');
        }
        if (!calibration.summary.discrimination_ok) {
            healthScore -= 15;
            issues.push('Poor difficulty discrimination');
        }
    } else {
        healthScore -= 10;
        issues.push('Calibration analysis failed');
    }

    if (bias.success && bias.summary) {
        if (bias.summary.length_bias_detected) {
            healthScore -= 10;
            issues.push('Length bias detected');
        }
    }

    if (failures.success && failures.summary) {
        if (failures.summary.failure_rate > 15) {
            healthScore -= 20;
            issues.push('High failure rate');
        } else if (failures.summary.failure_rate > 5) {
            healthScore -= 10;
            issues.push('Moderate failure rate');
        }
    } else {
        healthScore -= 10;
        issues.push('Failure analysis failed');
    }

    const status = healthScore >= 80 ? 'healthy' : (healthScore >= 60 ? 'degraded' : 'unhealthy');

    return {
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        overall: {
            health_score: Math.max(0, healthScore),
            status,
            issues
        },
        consistency: consistency.success ? consistency.summary : { error: consistency.error },
        calibration: calibration.success ? calibration.summary : { error: calibration.error },
        bias: bias.success ? bias.summary : { error: bias.error },
        failures: failures.success ? failures.summary : { error: failures.error }
    };
}

// ============ Helper Functions ============

function calculatePearsonCorrelation(x, y) {
    if (x.length !== y.length || x.length < 2) return 0;

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    return denominator === 0 ? 0 : numerator / denominator;
}

function calculateStdDev(arr) {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
}

function calculateMedian(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calculateSkewness(arr, mean, stdDev) {
    if (arr.length === 0 || stdDev === 0) return 0;
    const n = arr.length;
    const sum = arr.reduce((acc, val) => acc + Math.pow((val - mean) / stdDev, 3), 0);
    return sum / n;
}

function calculateClusteringScore(histogram, total) {
    // Higher score = better distribution
    // Check how many buckets have reasonable counts
    const buckets = Object.values(histogram).filter(v => v > 0);
    const expectedPerBucket = total / 21; // 21 buckets (0, 0.5, 1, ... 10)

    let score = 0;
    for (const count of buckets) {
        // Reward buckets that have counts, penalize huge concentrations
        const ratio = count / expectedPerBucket;
        if (ratio > 0 && ratio < 3) {
            score += 10;
        } else if (ratio >= 3) {
            score += 5; // Some credit for having data, but penalize clustering
        }
    }

    return Math.min(100, score);
}

function getCalibrationGrade(clusteringScore, stdDev, discriminationOk) {
    let grade = 'A';

    if (clusteringScore < 50) grade = 'C';
    else if (clusteringScore < 70) grade = 'B';

    if (stdDev < 1) {
        grade = grade === 'A' ? 'B' : (grade === 'B' ? 'C' : 'D');
    }

    if (!discriminationOk) {
        grade = grade === 'A' ? 'B' : (grade === 'B' ? 'C' : 'D');
    }

    return grade;
}

function categorizeFailure(explanation) {
    const exp = explanation.toLowerCase();
    if (exp.includes('timeout') || exp.includes('timed out')) return 'timeout';
    if (exp.includes('json') || exp.includes('parse')) return 'json_parse_error';
    if (exp.includes('connection') || exp.includes('econnreset')) return 'connection_error';
    if (exp.includes('http') || exp.includes('502') || exp.includes('503')) return 'http_error';
    if (exp.includes('array')) return 'invalid_format';
    if (exp.includes('missing') || exp.includes('numeric')) return 'missing_scores';
    return 'unknown';
}

function generateBiasRecommendations(lengthBias, formatBias) {
    const recommendations = [];

    // Check length bias
    const lengths = Object.entries(lengthBias);
    if (lengths.length >= 2) {
        const avgScores = lengths.map(([_, data]) => data.avg_score);
        const maxDiff = Math.max(...avgScores) - Math.min(...avgScores);
        if (maxDiff > 1.0) {
            recommendations.push('Consider adding length-normalization to judge prompt');
        }
    }

    // Check format bias
    const formats = Object.entries(formatBias);
    if (formats.length >= 2) {
        const avgScores = formats.map(([_, data]) => data.avg_score);
        const maxDiff = Math.max(...avgScores) - Math.min(...avgScores);
        if (maxDiff > 1.0) {
            recommendations.push('Consider adding format-agnostic evaluation criteria');
        }
    }

    if (recommendations.length === 0) {
        recommendations.push('No significant biases detected');
    }

    return recommendations;
}

function generateFailureRecommendations(failureReasons, failureRate) {
    const recommendations = [];

    if (failureReasons.timeout > 0) {
        recommendations.push('Increase judge timeout or reduce response length');
    }

    if (failureReasons.json_parse_error > 0) {
        recommendations.push('Judge model may need clearer JSON format instructions');
    }

    if (failureReasons.connection_error > 0) {
        recommendations.push('Check network stability to judge host');
    }

    if (failureRate > 10) {
        recommendations.push('Consider using a more reliable judge model');
    }

    if (recommendations.length === 0) {
        recommendations.push('Judge is operating within normal parameters');
    }

    return recommendations;
}

module.exports = {
    runConsistencyTest,
    runGroundTruthEvaluation,
    runBiasDetection,
    runCalibrationAnalysis,
    runFailureModeAnalysis,
    runHealthCheck
};
