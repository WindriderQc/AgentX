/**
 * Benchmark Routes - Results
 * Result CRUD, advanced query, rejudge, human review
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');
const { judgeResult } = require('../../src/services/benchmark/judging');
const { validateObjectId } = require('../../src/helpers/objectIdValidator');

const ADVANCED_RESULTS_MAX_LIMIT = 5000;
const ADVANCED_RESULTS_DEFAULT_LIMIT = 1000;
const ADVANCED_RESULTS_SORT_FIELDS = new Set([
    'timestamp',
    'latency',
    'tokens_per_sec',
    'quality_score',
    'composite_score',
    'prompt_level',
    'model',
    'host',
    'scoring_time_ms'
]);

/**
 * GET /api/benchmark/results
 * Get all test results (paginated)
 */
router.get('/results', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 20;

        const { results, total } = await benchmarkService.getResults({ limit });

        res.json({
            status: 'success',
            data: { total, results }
        });
    } catch (err) {
        logger.error('Failed to fetch results', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/results/advanced
 * Advanced filtering and querying for Results Explorer
 */
router.get('/results/advanced', async (req, res) => {
    try {
        const BenchmarkResult = require('../../models/BenchmarkResult');

        // Build query object
        const query = {};

        // Date range
        if (req.query.dateFrom || req.query.dateTo) {
            query.timestamp = {};
            if (req.query.dateFrom) {
                query.timestamp.$gte = new Date(req.query.dateFrom);
            }
            if (req.query.dateTo) {
                const dateTo = new Date(req.query.dateTo);
                dateTo.setHours(23, 59, 59, 999);
                query.timestamp.$lte = dateTo;
            }
        }

        // Model filter
        if (req.query.models) {
            const models = req.query.models.split(',').map(m => m.trim());
            query.model = { $in: models };
        }

        // Category filter
        if (req.query.categories) {
            const categories = req.query.categories.split(',').map(c => c.trim());
            query.prompt_category = { $in: categories };
        }

        // Level range
        if (req.query.levelMin || req.query.levelMax) {
            query.prompt_level = {};
            if (req.query.levelMin) {
                query.prompt_level.$gte = parseInt(req.query.levelMin, 10);
            }
            if (req.query.levelMax) {
                query.prompt_level.$lte = parseInt(req.query.levelMax, 10);
            }
        }

        // Quality range
        if (req.query.qualityMin || req.query.qualityMax) {
            query.quality_score = { $ne: null };
            if (req.query.qualityMin) {
                query.quality_score.$gte = parseFloat(req.query.qualityMin);
            }
            if (req.query.qualityMax) {
                query.quality_score.$lte = parseFloat(req.query.qualityMax);
            }
        }

        // Host filter
        if (req.query.host) {
            query.host = req.query.host;
        }

        // Backend filter
        if (req.query.backend) {
            query['hardware_snapshot.backend'] = req.query.backend;
        }

        // Quantization filter
        if (req.query.quantization) {
            query['hardware_snapshot.quantization'] = req.query.quantization;
        }

        // Success filter
        if (req.query.success !== undefined && req.query.success !== '') {
            query.success = req.query.success === 'true';
        }

        // Batch ID filter
        if (req.query.batchId) {
            query.batch_id = req.query.batchId;
        }

        // Scoring method filter
        if (req.query.scoringMethod) {
            query.scoring_method = req.query.scoringMethod;
        }

        // Pagination and sorting
        const parsedLimit = parseInt(req.query.limit, 10);
        const limit = Number.isFinite(parsedLimit)
            ? Math.max(1, Math.min(parsedLimit, ADVANCED_RESULTS_MAX_LIMIT))
            : ADVANCED_RESULTS_DEFAULT_LIMIT;
        const parsedOffset = parseInt(req.query.offset, 10);
        const offset = Number.isFinite(parsedOffset)
            ? Math.max(0, parsedOffset)
            : 0;
        const requestedSortField = String(req.query.sort || 'timestamp');
        const sortField = ADVANCED_RESULTS_SORT_FIELDS.has(requestedSortField)
            ? requestedSortField
            : 'timestamp';
        const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

        // Execute query
        const [results, total] = await Promise.all([
            BenchmarkResult.find(query)
                .sort({ [sortField]: sortDir })
                .skip(offset)
                .limit(limit)
                .lean(),
            BenchmarkResult.countDocuments(query)
        ]);

        res.json({
            status: 'success',
            data: {
                results,
                total,
                limit,
                offset,
                sort: sortField,
                sortDir: sortDir === 1 ? 'asc' : 'desc',
                hasMore: (offset + results.length) < total
            }
        });
    } catch (err) {
        logger.error('Failed to fetch advanced results', { error: err.message, query: req.query });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/results/needs-review
 * Get results flagged for manual review due to low judge confidence
 */
router.get('/results/needs-review', async (req, res) => {
    try {
        const BenchmarkResult = require('../../models/BenchmarkResult');
        const { limit = 50, batch_id, model, min_confidence, max_confidence } = req.query;

        const filter = { needs_review: true };

        if (batch_id) filter.batch_id = batch_id;
        if (model) filter.model = model;
        if (min_confidence !== undefined) {
            filter.judge_confidence = { ...filter.judge_confidence, $gte: parseFloat(min_confidence) };
        }
        if (max_confidence !== undefined) {
            filter.judge_confidence = { ...filter.judge_confidence, $lte: parseFloat(max_confidence) };
        }

        const results = await BenchmarkResult.find(filter)
            .sort({ judge_confidence: 1, timestamp: -1 })
            .limit(parseInt(limit))
            .select({
                model: 1,
                prompt_name: 1,
                prompt_level: 1,
                prompt_category: 1,
                quality_score: 1,
                judge_confidence: 1,
                review_reason: 1,
                human_score: 1,
                human_reviewed_at: 1,
                batch_id: 1,
                timestamp: 1
            })
            .lean();

        // Get aggregate stats
        const stats = await BenchmarkResult.aggregate([
            { $match: { needs_review: true } },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    reviewed: { $sum: { $cond: [{ $ne: ['$human_score', null] }, 1, 0] } },
                    avg_confidence: { $avg: '$judge_confidence' }
                }
            }
        ]);

        res.json({
            status: 'success',
            data: {
                results,
                stats: stats[0] || { total: 0, reviewed: 0, avg_confidence: null },
                limit: parseInt(limit)
            }
        });
    } catch (err) {
        logger.error('Failed to fetch results needing review', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/results/:id/human-review
 * Submit a human review score for a result
 */
router.post('/results/:id/human-review', async (req, res) => {
    try {
        const BenchmarkResult = require('../../models/BenchmarkResult');
        const { human_score, reviewer, notes } = req.body;

        if (!validateObjectId(req.params.id, res, 'Result ID')) return;

        if (human_score === undefined || human_score < 0 || human_score > 10) {
            return res.status(400).json({
                status: 'error',
                error: 'human_score must be between 0 and 10'
            });
        }

        const updateFields = {
            human_score: parseFloat(human_score),
            human_reviewed_at: new Date(),
            human_reviewer: reviewer || 'anonymous'
        };
        if (notes) updateFields.human_notes = String(notes).slice(0, 2000);

        const result = await BenchmarkResult.findByIdAndUpdate(
            req.params.id,
            { $set: updateFields },
            { new: true }
        );

        if (!result) {
            return res.status(404).json({
                status: 'error',
                error: 'Result not found'
            });
        }

        res.json({
            status: 'success',
            data: {
                id: result._id,
                human_score: result.human_score,
                human_notes: result.human_notes,
                human_reviewed_at: result.human_reviewed_at,
                quality_score: result.quality_score,
                judge_confidence: result.judge_confidence
            }
        });
    } catch (err) {
        logger.error('Failed to submit human review', { error: err.message, id: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/results/:id
 * Get full details for a single test result (for Test Inspector)
 */
router.get('/results/:id', async (req, res) => {
    try {
        const BenchmarkResult = require('../../models/BenchmarkResult');

        if (!validateObjectId(req.params.id, res, 'Result ID')) return;

        const result = await BenchmarkResult.findById(req.params.id).lean();

        if (!result) {
            return res.status(404).json({
                status: 'error',
                error: 'Result not found'
            });
        }

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to fetch result details', { error: err.message, id: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/results/:id/rejudge
 * Re-run judging on a single result that has pending/failed scoring
 */
router.post('/results/:id/rejudge', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Result ID')) return;

        const judgeConfig = {};
        if (req.body.judge_model) judgeConfig.model = req.body.judge_model;
        if (req.body.judge_host) judgeConfig.host = req.body.judge_host;

        logger.info('Re-judging result', { resultId: req.params.id, judgeConfig });

        const result = await judgeResult(req.params.id, judgeConfig);

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to rejudge result', { error: err.message, id: req.params.id });
        const statusCode = err.message.includes('not found') ? 404
            : err.message.includes('Cannot judge') || err.message.includes('No response') ? 400
            : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * DELETE /api/benchmark/results
 * Clear all results (for testing)
 */
router.delete('/results', async (req, res) => {
    try {
        const count = await benchmarkService.clearResults();

        res.json({
            status: 'success',
            message: `Cleared ${count} results`
        });
    } catch (err) {
        logger.error('Failed to clear results', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * DELETE /api/benchmark/results/failed
 * Clear failed results only
 */
router.delete('/results/failed', async (req, res) => {
    try {
        const count = await benchmarkService.clearFailedResults();

        res.json({
            status: 'success',
            message: `Cleared ${count} failed results`
        });
    } catch (err) {
        logger.error('Failed to clear failed results', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
