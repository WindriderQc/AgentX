/**
 * Benchmark Initialization Module
 * Handles seeding, cleanup, and initial setup
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../../../config/logger');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');

/**
 * Seed prompts from JSON file if database is empty
 */
async function seedPrompts() {
    const count = await BenchmarkPrompt.countDocuments();

    if (count === 0) {
        const promptsPath = path.join(__dirname, '..', '..', '..', 'data', 'benchmark-prompts.json');
        const promptsData = await fs.readFile(promptsPath, 'utf-8');
        const prompts = JSON.parse(promptsData);

        const seededCount = await BenchmarkPrompt.seedFromArray(prompts);
        logger.info('Seeded benchmark prompts', { count: seededCount });

        return seededCount;
    }

    return 0;
}

/**
 * Cleanup stale batches on startup
 */
async function cleanupStaleBatches() {
    try {
        const count = await BenchmarkBatch.cleanupStale();
        if (count > 0) {
            logger.info('Cleaned up stale batches', { count });
        }
        return count;
    } catch (err) {
        logger.error('Failed to cleanup stale batches', { error: err.message });
        throw err;
    }
}

/**
 * Get all prompts grouped by level
 */
async function getPrompts() {
    await seedPrompts();
    const { prompts, byLevel } = await BenchmarkPrompt.getAllGroupedByLevel();

    return {
        prompts,
        by_level: byLevel,
        total: prompts.length
    };
}

/**
 * Get configuration presets for common test scenarios
 */
function getConfigPresets() {
    return {
        presets: [
            {
                id: 'quick-test',
                name: 'Quick Test',
                description: 'Fast validation test with simple prompts',
                config: {
                    levels: [1, 2],
                    quality_scoring: false,
                    judge_config: null
                },
                recommended_for: 'Initial model validation, quick checks',
                estimated_duration: '2-5 minutes'
            },
            {
                id: 'standard-benchmark',
                name: 'Standard Benchmark',
                description: 'Balanced test across all levels with quality scoring',
                config: {
                    levels: [1, 2, 3, 4, 5],
                    quality_scoring: true,
                    judge_config: {
                        concurrency: 2,
                        judge_same_host: false
                    }
                },
                recommended_for: 'Regular model evaluation',
                estimated_duration: '15-30 minutes'
            },
            {
                id: 'deep-quality',
                name: 'Deep Quality Analysis',
                description: 'Comprehensive quality scoring on complex prompts',
                config: {
                    levels: [3, 4, 5],
                    quality_scoring: true,
                    judge_config: {
                        concurrency: 1,
                        judge_same_host: false,
                        timeout: 60000
                    }
                },
                recommended_for: 'In-depth model analysis, publication-ready benchmarks',
                estimated_duration: '30-60 minutes'
            },
            {
                id: 'speed-test',
                name: 'Speed Test',
                description: 'Focus on latency and throughput measurement',
                config: {
                    levels: [1, 2],
                    quality_scoring: false,
                    judge_config: null
                },
                recommended_for: 'Performance optimization, latency testing',
                estimated_duration: '5-10 minutes'
            },
            {
                id: 'reasoning-test',
                name: 'Reasoning & Logic',
                description: 'Test logical reasoning and problem-solving',
                config: {
                    levels: [3, 4],
                    quality_scoring: true,
                    judge_config: {
                        concurrency: 2,
                        judge_same_host: false
                    }
                },
                recommended_for: 'Evaluating reasoning capabilities',
                estimated_duration: '20-40 minutes'
            }
        ]
    };
}

module.exports = {
    seedPrompts,
    cleanupStaleBatches,
    getPrompts,
    getConfigPresets
};
