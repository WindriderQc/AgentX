/**
 * Benchmark Routes - Recommend
 * Returns ranked host/model pairs for a given prompt category
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const BenchmarkResult = require('../../models/BenchmarkResult');

/**
 * Build ranked recommendation list from aggregated results.
 * Exported for unit testing.
 *
 * @param {Array}  results          - Aggregated {model, host, avg_quality, count, judge_model}
 * @returns {Array} Sorted recommendation objects
 */
function buildRecommendations(results) {
    return results
        .map(r => {
            const count = r.count || 0;

            return {
                model: r.model,
                host: r.host,
                quality_score: Math.round((r.avg_quality || 0) * 10) / 10,
                result_count: count,
                confidence: 'low',
                confidence_basis: 'unqualified_observation',
                evidence_level: 'observation'
            };
        })
        .sort((a, b) => b.quality_score - a.quality_score);
}

/**
 * GET /api/benchmark/recommend
 * Query params:
 *   category     {string} required — prompt category to filter by
 *   host         {string} optional — regex filter on host field
 *   min_quality  {number} optional — minimum quality_score threshold
 */
router.get('/', async (req, res) => {
    try {
        const { category, host, min_quality } = req.query;

        if (!category) {
            return res.status(400).json({
                status: 'error',
                error: 'category query parameter is required'
            });
        }

        const match = {
            success: true,
            infra_error: { $ne: true },
            needs_review: { $ne: true },
            excluded_from_leaderboard: { $ne: true },
            prompt_category: category,
            quality_score: { $ne: null }
        };
        if (host) {
            const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            match.host = { $regex: escaped, $options: 'i' };
        }
        if (min_quality) match.quality_score.$gte = parseFloat(min_quality);

        const results = await BenchmarkResult.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { model: '$model', host: '$host' },
                    avg_quality: { $avg: '$quality_score' },
                    count: { $sum: 1 },
                    judge_model: { $first: '$judge_model' }
                }
            },
            {
                $project: {
                    _id: 0,
                    model: '$_id.model',
                    host: '$_id.host',
                    avg_quality: { $round: ['$avg_quality', 1] },
                    count: 1,
                    judge_model: 1
                }
            },
            { $sort: { avg_quality: -1 } },
            { $limit: 20 }
        ]);

        const recommendations = buildRecommendations(results);

        res.json({
            status: 'success',
            data: {
                category,
                recommendations
            }
        });
    } catch (err) {
        logger.error('Recommend query failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
module.exports.buildRecommendations = buildRecommendations;
