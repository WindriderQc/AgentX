/**
 * Benchmark Service
 * Business logic for LLM performance testing and quality scoring
 * Implements Service-Oriented Architecture pattern
 *
 * This is the main facade that preserves the singleton API while
 * delegating to modular sub-components.
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');

// Import sub-modules
const { DEFAULT_EXECUTION_CONFIG, normalizeExecutionConfig, applyLengthHint } = require('./config');
const { seedPrompts, cleanupStaleBatches, getPrompts, getConfigPresets } = require('./init');
const { runTest, startBatch, executeBatch, stopBatch, getActiveBatchId, getActiveHeartbeatInterval, clearActiveBatch } = require('./execution');
const { getResults, getSummary, getDashboard, compareModels, getQualityBreakdown, getModelTrends, compareBatches } = require('./results');
const { getBatches, getBatch, getBatchStatsByTag, clearResults, clearFailedResults, getActiveStats } = require('./batches');
const { getJudgeLeaderboard, getJudgeBreakdown, getJudgeActivity, getTruncationStats } = require('./judges');
const { calculateAllGeneralistScores, getActiveCategoryWeights } = require('./generalistScore');
const { judgeResult, judgeBatch, stopJudging, getJudgingStatus, stopAllJudging } = require('./judging');

// Graceful shutdown handler - mark batch as interrupted when PM2 restarts
process.on('SIGTERM', async () => {
    const SHUTDOWN_DEADLINE_MS = 5000;  // 5 second hard deadline
    const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;

    const activeBatchId = getActiveBatchId();
    const activeHeartbeatInterval = getActiveHeartbeatInterval();

    const shutdown = async () => {
        // Stop all active judging jobs
        stopAllJudging();

        if (activeBatchId) {
            logger.warn('SIGTERM received - marking active batch as interrupted', { batchId: activeBatchId });
            try {
                if (activeHeartbeatInterval) {
                    clearInterval(activeHeartbeatInterval);
                }
                await BenchmarkBatch.updateOne(
                    { _id: activeBatchId, status: 'running' },
                    {
                        $set: {
                            status: 'interrupted',
                            completed_at: new Date()
                        },
                        $push: {
                            timeline: {
                                $each: [{
                                    timestamp: new Date(),
                                    event: 'sigterm_interrupted',
                                    success: false,
                                    error: 'Process received SIGTERM signal'
                                }],
                                $slice: -2500
                            }
                        }
                    }
                );
                logger.info('Batch marked as interrupted', { batchId: activeBatchId });
            } catch (err) {
                logger.error('Failed to mark batch as interrupted on SIGTERM', {
                    batchId: activeBatchId,
                    error: err.message
                });
            }
        }
    };

    // Race between shutdown logic and hard deadline
    const sleepUntilDeadline = () => new Promise(resolve => {
        const remaining = deadline - Date.now();
        if (remaining > 0) setTimeout(resolve, remaining);
        else resolve();
    });

    try {
        await Promise.race([shutdown(), sleepUntilDeadline()]);
    } finally {
        process.exit(0);
    }
});

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
    executeBatch = executeBatch;
    stopBatch = stopBatch;

    // Results and Dashboard
    getResults = getResults;
    getSummary = getSummary;
    getDashboard = getDashboard;
    compareModels = compareModels;
    getQualityBreakdown = getQualityBreakdown;
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

    // Generalist Leaderboard
    async getGeneralistLeaderboard() {
        const categoryWeights = await getActiveCategoryWeights();
        const generalistScores = await calculateAllGeneralistScores(
            { success: true },
            { categoryWeights }
        );

        // Convert Map to sorted array
        const leaderboard = [];
        for (const [key, data] of generalistScores) {
            const [model, host] = key.split('@@');
            leaderboard.push({
                model,
                host: host || null,
                generalistScore: data.generalistScore,
                weightedSum: data.weightedSum,
                coveragePenalty: data.coveragePenalty,
                consistencyBonus: data.consistencyBonus,
                avgWithinCategoryStdDev: data.avgWithinCategoryStdDev,
                coverage: data.coverage,
                testedCategories: data.testedCategories,
                categoryAverages: data.categoryAverages
            });
        }

        // Sort by generalist score descending
        leaderboard.sort((a, b) => b.generalistScore - a.generalistScore);

        return {
            leaderboard,
            categoryWeights
        };
    }
}

// Export singleton instance (preserves original API)
module.exports = new BenchmarkService();
