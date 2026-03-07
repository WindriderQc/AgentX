/**
 * Regression Detector
 * ===================
 *
 * Compares benchmark results across batches to detect:
 * - Score regressions (model quality dropped > threshold)
 * - Score improvements (model quality improved significantly)
 * - New models added / models removed
 * - Category-level changes
 *
 * Generates a human-readable changelog for each comparison.
 *
 * Used by: CI integration, analytics API, scheduled reports
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');

const REGRESSION_THRESHOLD = 5;   // Points drop to flag as regression (0-100 scale)
const IMPROVEMENT_THRESHOLD = 5;  // Points gain to flag as improvement

/**
 * Get per-model quality stats for a batch.
 * @param {string} batchId
 * @returns {Map} model -> { avg_quality, categories: { cat: avg }, count }
 */
async function getBatchModelStats(batchId) {
    const [modelStats, categoryStats] = await Promise.all([
        BenchmarkResult.aggregate([
            { $match: { batch_id: batchId, success: true, quality_score: { $ne: null } } },
            {
                $group: {
                    _id: { model: '$model', host: '$host' },
                    avg_quality: { $avg: '$quality_score' },
                    count: { $sum: 1 }
                }
            }
        ]),
        BenchmarkResult.aggregate([
            { $match: { batch_id: batchId, success: true, quality_score: { $ne: null } } },
            {
                $group: {
                    _id: { model: '$model', host: '$host', category: '$prompt_category' },
                    avg_quality: { $avg: '$quality_score' }
                }
            }
        ])
    ]);

    const map = new Map();
    for (const s of modelStats) {
        const key = `${s._id.model}@@${s._id.host || ''}`;
        map.set(key, {
            model: s._id.model,
            host: s._id.host || null,
            avg_quality: Math.round(s.avg_quality * 100) / 100,
            count: s.count,
            categories: {}
        });
    }

    for (const s of categoryStats) {
        const key = `${s._id.model}@@${s._id.host || ''}`;
        const entry = map.get(key);
        if (entry && s._id.category) {
            entry.categories[s._id.category] = Math.round(s.avg_quality * 100) / 100;
        }
    }

    return map;
}

/**
 * Compare two batches and generate a regression/improvement report.
 * @param {string} currentBatchId - The newer batch
 * @param {string} previousBatchId - The older batch to compare against
 * @returns {Object} Comparison report
 */
async function compareBatchRegression(currentBatchId, previousBatchId) {
    const [currentStats, previousStats, currentBatch, previousBatch] = await Promise.all([
        getBatchModelStats(currentBatchId),
        getBatchModelStats(previousBatchId),
        BenchmarkBatch.findById(currentBatchId).select('run_name created_at completed_at').lean(),
        BenchmarkBatch.findById(previousBatchId).select('run_name created_at completed_at').lean()
    ]);

    const regressions = [];
    const improvements = [];
    const stable = [];
    const newModels = [];
    const removedModels = [];
    const categoryChanges = [];

    // Check each model in current batch against previous
    for (const [key, current] of currentStats) {
        const previous = previousStats.get(key);

        if (!previous) {
            newModels.push({ model: current.model, host: current.host, avg_quality: current.avg_quality });
            continue;
        }

        const qualityDelta = (current.avg_quality - previous.avg_quality) * 10; // to 0-100 scale

        if (qualityDelta <= -REGRESSION_THRESHOLD) {
            regressions.push({
                model: current.model,
                host: current.host,
                previous: Math.round(previous.avg_quality * 10 * 10) / 10,
                current: Math.round(current.avg_quality * 10 * 10) / 10,
                delta: Math.round(qualityDelta * 10) / 10
            });
        } else if (qualityDelta >= IMPROVEMENT_THRESHOLD) {
            improvements.push({
                model: current.model,
                host: current.host,
                previous: Math.round(previous.avg_quality * 10 * 10) / 10,
                current: Math.round(current.avg_quality * 10 * 10) / 10,
                delta: Math.round(qualityDelta * 10) / 10
            });
        } else {
            stable.push({
                model: current.model,
                host: current.host,
                score: Math.round(current.avg_quality * 10 * 10) / 10
            });
        }

        // Category-level changes
        for (const [cat, currentScore] of Object.entries(current.categories)) {
            const prevScore = previous.categories[cat];
            if (prevScore === undefined) continue;
            const catDelta = (currentScore - prevScore) * 10;
            if (Math.abs(catDelta) >= REGRESSION_THRESHOLD) {
                categoryChanges.push({
                    model: current.model,
                    host: current.host,
                    category: cat,
                    previous: Math.round(prevScore * 10 * 10) / 10,
                    current: Math.round(currentScore * 10 * 10) / 10,
                    delta: Math.round(catDelta * 10) / 10,
                    type: catDelta < 0 ? 'regression' : 'improvement'
                });
            }
        }
    }

    // Check for removed models
    for (const [key, previous] of previousStats) {
        if (!currentStats.has(key)) {
            removedModels.push({ model: previous.model, host: previous.host, avg_quality: previous.avg_quality });
        }
    }

    // Sort by severity
    regressions.sort((a, b) => a.delta - b.delta);
    improvements.sort((a, b) => b.delta - a.delta);

    return {
        currentBatch: {
            id: currentBatchId,
            name: currentBatch?.run_name,
            date: currentBatch?.completed_at || currentBatch?.created_at
        },
        previousBatch: {
            id: previousBatchId,
            name: previousBatch?.run_name,
            date: previousBatch?.completed_at || previousBatch?.created_at
        },
        summary: {
            regressions: regressions.length,
            improvements: improvements.length,
            stable: stable.length,
            newModels: newModels.length,
            removedModels: removedModels.length,
            categoryChanges: categoryChanges.length
        },
        regressions,
        improvements,
        stable,
        newModels,
        removedModels,
        categoryChanges
    };
}

/**
 * Auto-detect the two most recent completed batches and compare them.
 * @returns {Object|null} Comparison report or null if < 2 batches exist
 */
async function detectLatestRegression() {
    const batches = await BenchmarkBatch.find({ status: 'completed' })
        .sort({ completed_at: -1 })
        .limit(2)
        .select('_id')
        .lean();

    if (batches.length < 2) {
        return null;
    }

    return compareBatchRegression(
        batches[0]._id.toString(),
        batches[1]._id.toString()
    );
}

/**
 * Generate a human-readable changelog from a regression report.
 * @param {Object} report - From compareBatchRegression()
 * @returns {string} Markdown changelog
 */
function generateChangelog(report) {
    const lines = [];
    lines.push(`## Benchmark Changelog`);
    lines.push(`**${report.currentBatch.name || report.currentBatch.id}** vs **${report.previousBatch.name || report.previousBatch.id}**\n`);

    if (report.regressions.length > 0) {
        lines.push(`### Regressions`);
        for (const r of report.regressions) {
            lines.push(`- **${r.model}**: ${r.previous} -> ${r.current} (${r.delta > 0 ? '+' : ''}${r.delta})`);
        }
        lines.push('');
    }

    if (report.improvements.length > 0) {
        lines.push(`### Improvements`);
        for (const r of report.improvements) {
            lines.push(`- **${r.model}**: ${r.previous} -> ${r.current} (+${r.delta})`);
        }
        lines.push('');
    }

    if (report.newModels.length > 0) {
        lines.push(`### New Models`);
        for (const m of report.newModels) {
            lines.push(`- **${m.model}**: ${(m.avg_quality * 10).toFixed(1)}`);
        }
        lines.push('');
    }

    if (report.removedModels.length > 0) {
        lines.push(`### Removed Models`);
        for (const m of report.removedModels) {
            lines.push(`- ${m.model}`);
        }
        lines.push('');
    }

    if (report.categoryChanges.length > 0) {
        lines.push(`### Category Changes`);
        for (const c of report.categoryChanges) {
            const icon = c.type === 'regression' ? 'DOWN' : 'UP';
            lines.push(`- ${c.model} / ${c.category}: ${c.previous} -> ${c.current} (${icon} ${c.delta > 0 ? '+' : ''}${c.delta})`);
        }
        lines.push('');
    }

    if (report.summary.regressions === 0 && report.summary.improvements === 0) {
        lines.push(`No significant changes detected. All models stable.\n`);
    }

    return lines.join('\n');
}

module.exports = {
    REGRESSION_THRESHOLD,
    IMPROVEMENT_THRESHOLD,
    compareBatchRegression,
    detectLatestRegression,
    generateChangelog
};
