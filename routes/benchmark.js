/**
 * Benchmark Routes
 * Thin HTTP layer - validates requests and delegates to benchmarkService
 * Follows Service-Oriented Architecture pattern
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { attachWorkspace, optionalWorkspaceContext } = require('../src/middleware/workspace');
const benchmarkService = require('../src/services/benchmark');
const { JUDGE_CONFIG, ENHANCED_SCORING_CONFIGS } = require('../src/services/qualityScorer');
const { validateObjectId } = require('../src/helpers/objectIdValidator');
const BenchmarkBatch = require('../models/BenchmarkBatch');
const hardwareProfileService = require('../src/services/hardwareProfileService');
const judgeValidation = require('../src/services/judgeValidation');
const JudgeGroundTruth = require('../models/JudgeGroundTruth');

// Cleanup stale batches on startup
// Skip in tests to avoid timers/open handles and cross-test DB interference.
if (process.env.NODE_ENV !== 'test') {
    (async () => {
        try {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for DB connection
            await benchmarkService.cleanupStaleBatches();
        } catch (err) {
            logger.error('Failed to cleanup stale batches', { error: err.message });
        }
    })();
}

/**
 * GET /api/benchmark/config
 * Get benchmark configuration including judge settings
 */
router.get('/config', (req, res) => {
    res.json({
        status: 'success',
        data: {
            judge_config: {
                ...JUDGE_CONFIG,
                concurrency: 2,
                judge_same_host: false
            },
            execution_config: benchmarkService.getExecutionConfigDefaults(),
            scoring_configs: ENHANCED_SCORING_CONFIGS
        }
    });
});

/**
 * POST /api/benchmark/test
 * Run a single benchmark test - workspace-aware
 */
router.post('/test', optionalWorkspaceContext, async (req, res) => {
    const { model, host, prompt } = req.body;

    // Validation
    if (!model || !host || !prompt) {
        return res.status(400).json({
            status: 'error',
            error: 'model, host, and prompt are required'
        });
    }

    try {
        // Week 4: Pass workspace context to service
        const result = await benchmarkService.runTest({
            model,
            host,
            prompt,
            workspaceId: req.workspace ? req.workspace._id : null
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Benchmark test failed', { model, host, error: err.message });

        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

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
 * Query params:
 *   - dateFrom: ISO date string
 *   - dateTo: ISO date string
 *   - models: comma-separated model names
 *   - categories: comma-separated category names
 *   - levelMin: minimum prompt level (1-10)
 *   - levelMax: maximum prompt level (1-10)
 *   - qualityMin: minimum quality score (0-100)
 *   - qualityMax: maximum quality score (0-100)
 *   - host: host filter
 *   - backend: backend filter (CUDA, Metal, CPU, etc.)
 *   - quantization: quantization filter
 *   - success: success filter (true/false)
 *   - batchId: batch ID filter
 *   - scoringMethod: scoring method filter
 *   - sort: sort field
 *   - sortDir: sort direction (asc/desc)
 *   - limit: max results (default 1000)
 *   - offset: pagination offset
 */
router.get('/results/advanced', async (req, res) => {
    try {
        const BenchmarkResult = require('../models/BenchmarkResult');

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
        const limit = parseInt(req.query.limit, 10) || 1000;
        const offset = parseInt(req.query.offset, 10) || 0;
        const sortField = req.query.sort || 'timestamp';
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
                hasMore: (offset + results.length) < total
            }
        });
    } catch (err) {
        logger.error('Failed to fetch advanced results', { error: err.message, query: req.query });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/results/:id
 * Get full details for a single test result (for Test Inspector)
 * Returns all fields including warmup data and raw judge response
 */
router.get('/results/:id', async (req, res) => {
    try {
        const BenchmarkResult = require('../models/BenchmarkResult');

        // Validate ObjectId
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
        const BenchmarkResult = require('../models/BenchmarkResult');
        const BenchmarkPrompt = require('../models/BenchmarkPrompt');
        const { scoreResponse, calculateCompositeScore, JUDGE_CONFIG } = require('../src/services/qualityScorer');

        // Validate ObjectId
        if (!validateObjectId(req.params.id, res, 'Result ID')) return;

        const result = await BenchmarkResult.findById(req.params.id);

        if (!result) {
            return res.status(404).json({ status: 'error', error: 'Result not found' });
        }

        if (!result.success) {
            return res.status(400).json({ status: 'error', error: 'Cannot judge failed test executions' });
        }

        if (!result.response) {
            return res.status(400).json({ status: 'error', error: 'No response to judge' });
        }

        // Get judge config from request or use defaults
        // IMPORTANT: Do NOT fall back to result.host (execution host) - use JUDGE_CONFIG.host instead
        const judgeConfig = {
            model: req.body.judge_model || result.judge_model || JUDGE_CONFIG.model,
            host: req.body.judge_host || result.judge_host || JUDGE_CONFIG.host
        };

        // Build prompt object for scoring
        const promptData = {
            prompt: result.prompt,
            name: result.prompt_name,
            level: result.prompt_level,
            category: result.prompt_category,
            expected_answer: result.expected_answer
        };

        logger.info('Re-judging result', { resultId: req.params.id, judgeConfig });

        const scores = await scoreResponse({
            response: result.response,
            prompt: promptData,
            judgeConfig
        });

        // Calculate composite score
        const composite = calculateCompositeScore({
            latency: result.latency,
            tokens_per_sec: result.tokens_per_sec,
            quality_score: scores.quality_score
        }, result.prompt_category || 'interactive');

        // Update result
        await BenchmarkResult.updateOne(
            { _id: req.params.id },
            {
                $set: {
                    quality_score: scores.quality_score,
                    quality_breakdown: scores.breakdown,
                    quality_explanation: scores.explanation,
                    judge_prompt: scores.judge_prompt,
                    judge_model: scores.judge_model,
                    judge_raw_response: scores.judge_raw_response,
                    scoring_method: scores.scoring_method,
                    scoring_type: scores.scoring_type || 'reasoning',
                    scoring_time_ms: scores.scoring_time_ms,
                    quick_pattern: scores.quick_pattern,
                    composite_score: composite.composite_score,
                    composite_profile_used: composite.composite_profile_used,
                    normalized_scores: composite.normalized
                }
            }
        );

        res.json({
            status: 'success',
            data: {
                quality_score: scores.quality_score,
                scoring_method: scores.scoring_method,
                composite_score: composite.composite_score
            }
        });
    } catch (err) {
        logger.error('Failed to rejudge result', { error: err.message, id: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/rejudge-pending
 * Re-run judging on all pending results in a batch
 */
router.post('/batch/:id/rejudge-pending', async (req, res) => {
    try {
        const BenchmarkResult = require('../models/BenchmarkResult');

        // Validate ObjectId
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        // Find all pending results in this batch
        const pendingResults = await BenchmarkResult.find({
            batch_id: req.params.id,
            success: true,
            scoring_method: 'pending'
        }).select('_id').lean();

        if (pendingResults.length === 0) {
            return res.json({
                status: 'success',
                message: 'No pending results to rejudge',
                data: { rejudged: 0 }
            });
        }

        logger.info('Rejudging pending results', { batchId: req.params.id, count: pendingResults.length });

        // Return immediately with count, let client poll or call individual rejudge
        res.json({
            status: 'success',
            message: `Found ${pendingResults.length} pending results. Use /results/:id/rejudge for each.`,
            data: {
                pending_count: pendingResults.length,
                result_ids: pendingResults.map(r => r._id.toString())
            }
        });
    } catch (err) {
        logger.error('Failed to find pending results', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/summary
 * Get summary statistics and leaderboard
 */
router.get('/summary', async (req, res) => {
    try {
        const summary = await benchmarkService.getSummary();

        res.json({
            status: 'success',
            message: summary.total_tests === 0 ? 'No successful tests yet' : undefined,
            data: summary
        });
    } catch (err) {
        logger.error('Failed to generate summary', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/dashboard
 * Get dashboard data with charts and stats including quality metrics
 *
 * Query params:
 *   - sort: Sort criteria (latency, quality, composite, etc.)
 *   - modelCategory: Filter by model category (ops, coding, reasoning, etc.)
 *   - promptCategory: Filter by prompt category (coding, reasoning, factual, etc.)
 *   - tag: Filter by batch tag
 */
router.get('/dashboard', async (req, res) => {
    try {
        const { sort, modelCategory, promptCategory, tag } = req.query;
        const sortBy = sort || 'latency';

        const dashboard = await benchmarkService.getDashboard({
            sortBy,
            modelCategory,
            promptCategory,
            tag
        });

        res.json({
            status: 'success',
            data: dashboard
        });
    } catch (err) {
        logger.error('Failed to load dashboard', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/compare
 * Compare multiple models
 */
router.get('/compare', async (req, res) => {
    const { models } = req.query;

    // Validation
    if (!models) {
        return res.status(400).json({
            status: 'error',
            error: 'models query parameter required (comma-separated)'
        });
    }

    const modelList = models.split(',').map(m => m.trim());

    try {
        const { comparison } = await benchmarkService.compareModels(modelList);

        res.json({
            status: 'success',
            data: { comparison }
        });
    } catch (err) {
        logger.error('Failed to compare models', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
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

/**
 * GET /api/benchmark/prompts
 * Get all prompts grouped by level
 */
router.get('/prompts', async (req, res) => {
    try {
        const data = await benchmarkService.getPrompts();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch prompts', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch
 * Start a batch benchmark test with optional quality scoring - workspace-aware
 */
router.post('/batch', optionalWorkspaceContext, async (req, res) => {
    const { host, models, levels, run_name, quality_scoring, judge_config, execution_config, execution_mode } = req.body;

    // Validation
    if (!host || !models || !Array.isArray(models) || !levels || !Array.isArray(levels)) {
        return res.status(400).json({
            status: 'error',
            error: 'host, models (array), and levels (array) are required'
        });
    }

    try {
        // ENFORCE SINGLE BATCH: Check for existing active batches
        const activeBatches = await BenchmarkBatch.getActive();

        if (activeBatches.length > 0) {
            const active = activeBatches[0];
            const inactiveSeconds = active.last_activity_at
                ? Math.floor((Date.now() - new Date(active.last_activity_at).getTime()) / 1000)
                : 0;

            return res.status(409).json({
                status: 'error',
                error: 'Another batch is already running',
                active_batch: {
                    id: active._id,
                    run_name: active.run_name,
                    status: active.status,
                    progress: active.progress,
                    inactive_seconds: inactiveSeconds,
                    is_stuck: inactiveSeconds > 300,
                    started_at: active.started_at
                },
                message: inactiveSeconds > 300
                    ? 'The active batch appears stuck. Use the "Recover" button to stop it before starting a new batch.'
                    : `Batch "${active.run_name}" is currently running (${active.progress}% complete). Please wait for it to finish or stop it first.`
            });
        }

        // Week 4: Pass workspace context to service
        const data = await benchmarkService.startBatch({
            host,
            models,
            levels,
            run_name,
            quality_scoring,
            judge_config,
            execution_config,
            execution_mode: execution_mode || 'latency', // Default to latency mode
            workspaceId: req.workspace ? req.workspace._id : null
        });

        res.json({
            status: 'success',
            data: {
                ...data,
                message: `Batch test started${data.quality_scoring ? ' with quality scoring' : ''}`
            }
        });
    } catch (err) {
        logger.error('Failed to start batch test', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/stop
 * Stop a running batch
 */
router.post('/batch/:id/stop', async (req, res) => {
    try {
        const { batch, alreadyStopped } = await benchmarkService.stopBatch(req.params.id);

        res.json({
            status: 'success',
            message: alreadyStopped ? `Batch already ${batch.status}` : 'Batch stopped',
            data: {
                batch_id: batch._id,
                status: batch.status,
                already_stopped: alreadyStopped
            }
        });
    } catch (err) {
        logger.error('Failed to stop batch', { error: err.message });

        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batch/:id
 * Get batch progress and results
 */
router.get('/batch/:id', async (req, res) => {
    try {
        const data = await benchmarkService.getBatch(req.params.id);

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch batch', { error: err.message });

        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batches
 * Get all batch runs
 */
router.get('/batches', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 20;

        const data = await benchmarkService.getBatches({ limit });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batches/active
 * Get all currently running batches across all clients
 */
router.get('/batches/active', async (req, res) => {
    try {
        const batches = await BenchmarkBatch.getActive();

        // Add activity status and stuck detection
        const now = Date.now();
        const enriched = batches.map(batch => {
            const lastActivity = batch.last_activity_at ? new Date(batch.last_activity_at).getTime() : batch.started_at ? new Date(batch.started_at).getTime() : now;
            const inactiveSeconds = Math.floor((now - lastActivity) / 1000);
            const isStuck = inactiveSeconds > 300; // 5 minutes

            return {
                ...batch.toJSON(),
                inactive_seconds: inactiveSeconds,
                is_stuck: isStuck,
                activity_status: isStuck ? 'stuck' : (inactiveSeconds > 60 ? 'slow' : 'active')
            };
        });

        res.json({
            status: 'success',
            data: enriched
        });
    } catch (err) {
        logger.error('Failed to fetch active batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batches/stuck
 * Get stuck batches (no activity for >5 minutes)
 */
router.get('/batches/stuck', async (req, res) => {
    try {
        const thresholdSeconds = parseInt(req.query.threshold, 10) || 300;
        const stuck = await BenchmarkBatch.findStuck(thresholdSeconds);

        res.json({
            status: 'success',
            data: stuck,
            threshold_seconds: thresholdSeconds
        });
    } catch (err) {
        logger.error('Failed to fetch stuck batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batch/:id/timeline
 * Get detailed execution timeline for a batch
 */
router.get('/batch/:id/timeline', async (req, res) => {
    try {
        // Validate ObjectId to prevent NoSQL injection
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const batch = await BenchmarkBatch.findById(req.params.id);

        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }

        // Get timeline events with calculated metrics
        const timeline = batch.timeline || [];
        const enriched = timeline.map((event, index) => {
            const timeSinceStart = batch.started_at
                ? event.timestamp - batch.started_at
                : 0;

            return {
                ...event.toObject(),
                time_since_start_ms: timeSinceStart,
                index
            };
        });

        // Calculate summary statistics
        const testEvents = timeline.filter(e => e.event === 'test_complete');
        const judgeEvents = timeline.filter(e => e.event === 'judge_complete');
        const errorEvents = timeline.filter(e => e.event === 'error');

        const avgTestDuration = testEvents.length > 0
            ? testEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / testEvents.length
            : null;

        const avgJudgeDuration = judgeEvents.length > 0
            ? judgeEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / judgeEvents.length
            : null;

        res.json({
            status: 'success',
            data: {
                batch_id: batch._id,
                timeline: enriched,
                summary: {
                    total_events: timeline.length,
                    tests_completed: testEvents.length,
                    tests_failed: errorEvents.length,
                    judges_completed: judgeEvents.length,
                    avg_test_duration_ms: avgTestDuration ? Math.round(avgTestDuration) : null,
                    avg_judge_duration_ms: avgJudgeDuration ? Math.round(avgJudgeDuration) : null,
                    started_at: batch.started_at,
                    last_event_at: timeline.length > 0 ? timeline[timeline.length - 1].timestamp : null
                }
            }
        });
    } catch (err) {
        logger.error('Failed to fetch batch timeline', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/recover
 * Recover a stuck batch by marking it as interrupted
 */
router.post('/batch/:id/recover', async (req, res) => {
    try {
        // Validate ObjectId to prevent NoSQL injection
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const batch = await BenchmarkBatch.findById(req.params.id);

        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }

        if (!['running', 'judging'].includes(batch.status)) {
            return res.status(400).json({
                status: 'error',
                error: `Batch is ${batch.status}, cannot recover`
            });
        }

        await batch.markAsStopped();

        res.json({
            status: 'success',
            message: 'Batch marked as stopped',
            data: batch
        });
    } catch (err) {
        logger.error('Failed to recover batch', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/quality-breakdown
 * Get quality scores broken down by category and level
 */
router.get('/quality-breakdown', async (req, res) => {
    try {
        const { model, host } = req.query;

        const data = await benchmarkService.getQualityBreakdown(model, host);

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch quality breakdown', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/trends
 * Get time-series performance trends
 */
router.get('/trends', async (req, res) => {
    try {
        const { model, days, groupBy } = req.query;

        const data = await benchmarkService.getModelTrends({
            model,
            days: parseInt(days, 10) || 7,
            groupBy: groupBy || 'day'
        });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch trends', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge-leaderboard
 * Get judge performance statistics
 */
router.get('/judge-leaderboard', async (req, res) => {
    try {
        const leaderboard = await benchmarkService.getJudgeLeaderboard();
        const activity = await benchmarkService.getJudgeActivity(5);

        res.json({
            status: 'success',
            data: {
                leaderboard,
                activity
            }
        });
    } catch (err) {
        logger.error('Failed to fetch judge leaderboard', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/generalist-leaderboard
 * Get generalist quality scores for all models
 * Single source of truth - replaces client-side calculation
 */
router.get('/generalist-leaderboard', async (req, res) => {
    try {
        const data = await benchmarkService.getGeneralistLeaderboard();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch generalist leaderboard', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge-breakdown
 * Break down judge performance by prompt level or model-under-test.
 *
 * Query params:
 *  - judge_model: required
 *  - judge_host: optional
 *  - groupBy: 'level' | 'model' (default: level)
 *  - limit: max groups (only applies to groupBy=model)
 */
router.get('/judge-breakdown', async (req, res) => {
    try {
        const { judge_model, judge_host, groupBy, limit } = req.query;

        if (!judge_model) {
            return res.status(400).json({
                status: 'error',
                error: 'judge_model query parameter is required'
            });
        }

        const data = await benchmarkService.getJudgeBreakdown({
            judge_model: String(judge_model),
            judge_host: (judge_host !== undefined ? String(judge_host) : null),
            groupBy: groupBy ? String(groupBy) : 'level',
            limit: limit !== undefined ? Number(limit) : undefined
        });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch judge breakdown', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/truncation-stats
 * Get truncation statistics for diagnostics
 * Query params:
 *  - batch_id: optional batch ID to filter
 *  - limit: max results to analyze (default 1000)
 */
router.get('/truncation-stats', async (req, res) => {
    try {
        const { batch_id, limit } = req.query;

        const data = await benchmarkService.getTruncationStats({
            batch_id: batch_id || null,
            limit: limit ? parseInt(limit, 10) : 1000
        });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch truncation stats', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/compare-batches
 * Compare multiple batches side-by-side
 */
router.post('/compare-batches', async (req, res) => {
    try {
        const { batch_ids } = req.body;

        if (!batch_ids || !Array.isArray(batch_ids)) {
            return res.status(400).json({
                status: 'error',
                error: 'batch_ids array is required'
            });
        }

        const data = await benchmarkService.compareBatches(batch_ids);

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to compare batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/stats-by-tag
 * Get statistics grouped by tags
 */
router.get('/stats-by-tag', async (req, res) => {
    try {
        const data = await benchmarkService.getBatchStatsByTag();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch stats by tag', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/active-stats
 * Get real-time statistics for active batches
 */
router.get('/active-stats', async (req, res) => {
    try {
        const data = await benchmarkService.getActiveStats();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch active stats', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/presets
 * Get configuration presets for common test scenarios
 */
router.get('/presets', (req, res) => {
    try {
        const data = benchmarkService.getConfigPresets();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch presets', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ========== Phase 3 Week 10: Hardware Profiling Endpoints ==========

/**
 * GET /api/benchmark/hardware/compare/:model
 * Compare hardware performance across different hosts for a model
 * Example: GET /api/benchmark/hardware/compare/llama3.1:70b-instruct-q4_K_M
 */
router.get('/hardware/compare/:model', async (req, res) => {
    try {
        const { model } = req.params;

        if (!model) {
            return res.status(400).json({
                status: 'error',
                error: 'Model name is required'
            });
        }

        const data = await hardwareProfileService.compareHosts(model);

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to compare hosts', { model: req.params.model, error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/hardware/optimal-quantization/:model
 * Find optimal quantization for a model (highest efficiency)
 * Query params: backend (optional) - filter by backend (CUDA, Metal, CPU, etc.)
 * Example: GET /api/benchmark/hardware/optimal-quantization/llama3.1:70b?backend=CUDA
 */
router.get('/hardware/optimal-quantization/:model', async (req, res) => {
    try {
        const { model } = req.params;
        const { backend } = req.query;

        if (!model) {
            return res.status(400).json({
                status: 'error',
                error: 'Model name is required'
            });
        }

        const data = await hardwareProfileService.getOptimalQuantization(model, backend || null);

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to get optimal quantization', {
            model: req.params.model,
            backend: req.query.backend,
            error: err.message
        });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/hardware/backend-stats
 * Get aggregate statistics across all backends (CUDA, Metal, CPU, etc.)
 */
router.get('/hardware/backend-stats', async (req, res) => {
    try {
        const data = await hardwareProfileService.getBackendStats();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to get backend stats', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/hardware/profiles
 * Get all hardware profiles (paginated)
 * Query params:
 *   - host: filter by host
 *   - model: filter by model
 *   - backend: filter by backend
 *   - limit: max results (default 50)
 */
router.get('/hardware/profiles', async (req, res) => {
    try {
        const HardwareProfile = require('../models/HardwareProfile');
        const { host, model, backend, limit } = req.query;

        const query = {};
        if (host) query.host = host;
        if (model) query.model = model;
        if (backend) query.backend = backend;

        const profiles = await HardwareProfile.find(query)
            .sort({ timestamp: -1 })
            .limit(parseInt(limit, 10) || 50);

        const total = await HardwareProfile.countDocuments(query);

        res.json({
            status: 'success',
            data: {
                profiles,
                total,
                filters: { host, model, backend, limit }
            }
        });
    } catch (err) {
        logger.error('Failed to fetch hardware profiles', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ============ Judge Validation Endpoints ============

/**
 * GET /api/benchmark/judge/health
 * Run comprehensive judge health check
 */
router.get('/judge/health', async (req, res) => {
    try {
        const { days } = req.query;
        const options = {};
        if (days) options.days = parseInt(days, 10);

        const health = await judgeValidation.runHealthCheck(options);

        res.json({
            status: 'success',
            data: health
        });
    } catch (err) {
        logger.error('Failed to run judge health check', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/judge/validate/consistency
 * Run consistency test on judge
 */
router.post('/judge/validate/consistency', async (req, res) => {
    try {
        const { sampleSize, repeats, category } = req.body;

        const result = await judgeValidation.runConsistencyTest({
            sampleSize: sampleSize || 10,
            repeats: repeats || 3,
            category: category || null
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to run consistency test', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/judge/validate/ground-truth
 * Run ground truth evaluation
 */
router.post('/judge/validate/ground-truth', async (req, res) => {
    try {
        const { category, limit } = req.body;

        const result = await judgeValidation.runGroundTruthEvaluation({
            category: category || null,
            limit: limit || 50
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to run ground truth evaluation', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/validate/bias
 * Run bias detection analysis
 */
router.get('/judge/validate/bias', async (req, res) => {
    try {
        const { sampleSize } = req.query;

        const result = await judgeValidation.runBiasDetection({
            sampleSize: sampleSize ? parseInt(sampleSize, 10) : 100
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to run bias detection', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/validate/calibration
 * Run calibration analysis
 */
router.get('/judge/validate/calibration', async (req, res) => {
    try {
        const { days } = req.query;

        const result = await judgeValidation.runCalibrationAnalysis({
            days: days ? parseInt(days, 10) : 30
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to run calibration analysis', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/validate/failures
 * Run failure mode analysis
 */
router.get('/judge/validate/failures', async (req, res) => {
    try {
        const { days } = req.query;

        const result = await judgeValidation.runFailureModeAnalysis({
            days: days ? parseInt(days, 10) : 30
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to run failure mode analysis', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ============ Ground Truth Management Endpoints ============

/**
 * GET /api/benchmark/judge/ground-truth
 * Get all ground truth entries
 */
router.get('/judge/ground-truth', async (req, res) => {
    try {
        const { category, active, limit } = req.query;

        const query = {};
        if (category) query.category = category;
        if (active !== undefined) query.active = active === 'true';

        const entries = await JudgeGroundTruth.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit, 10) || 100);

        const total = await JudgeGroundTruth.countDocuments(query);

        res.json({
            status: 'success',
            data: {
                entries,
                total,
                filters: { category, active, limit }
            }
        });
    } catch (err) {
        logger.error('Failed to fetch ground truth entries', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/judge/ground-truth
 * Create a new ground truth entry
 */
router.post('/judge/ground-truth', async (req, res) => {
    try {
        const {
            name,
            prompt,
            response,
            category,
            expected_answer,
            expert_scores,
            expert_rationale,
            difficulty,
            tags
        } = req.body;

        // Validate required fields
        if (!name || !prompt || !response || !category || !expert_scores || !expert_rationale) {
            return res.status(400).json({
                status: 'error',
                error: 'Missing required fields: name, prompt, response, category, expert_scores, expert_rationale'
            });
        }

        if (expert_scores.overall === undefined || expert_scores.overall === null) {
            return res.status(400).json({
                status: 'error',
                error: 'expert_scores.overall is required'
            });
        }

        const entry = new JudgeGroundTruth({
            name,
            prompt,
            response,
            category,
            expected_answer: expected_answer || null,
            expert_scores: {
                overall: expert_scores.overall,
                dimensions: expert_scores.dimensions || {}
            },
            expert_rationale,
            difficulty: difficulty || 5,
            tags: tags || [],
            active: true
        });

        await entry.save();

        res.status(201).json({
            status: 'success',
            data: entry
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({
                status: 'error',
                error: 'Ground truth entry with this name already exists'
            });
        }
        logger.error('Failed to create ground truth entry', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/ground-truth/summary
 * Get accuracy summary across all ground truth entries
 */
router.get('/judge/ground-truth/summary', async (req, res) => {
    try {
        const summary = await JudgeGroundTruth.getAccuracySummary();

        res.json({
            status: 'success',
            data: summary
        });
    } catch (err) {
        logger.error('Failed to fetch ground truth summary', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/ground-truth/problematic
 * Get ground truth entries with high deviation (judge struggles with these)
 */
router.get('/judge/ground-truth/problematic', async (req, res) => {
    try {
        const { threshold, limit } = req.query;

        const entries = await JudgeGroundTruth.getHighDeviation(
            threshold ? parseFloat(threshold) : 2.0,
            limit ? parseInt(limit, 10) : 20
        );

        res.json({
            status: 'success',
            data: {
                entries,
                threshold: threshold || 2.0
            }
        });
    } catch (err) {
        logger.error('Failed to fetch problematic ground truth', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * DELETE /api/benchmark/judge/ground-truth/:id
 * Delete a ground truth entry
 */
router.delete('/judge/ground-truth/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!validateObjectId(id)) {
            return res.status(400).json({
                status: 'error',
                error: 'Invalid ground truth ID'
            });
        }

        const entry = await JudgeGroundTruth.findByIdAndDelete(id);

        if (!entry) {
            return res.status(404).json({
                status: 'error',
                error: 'Ground truth entry not found'
            });
        }

        res.json({
            status: 'success',
            message: 'Ground truth entry deleted'
        });
    } catch (err) {
        logger.error('Failed to delete ground truth entry', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
