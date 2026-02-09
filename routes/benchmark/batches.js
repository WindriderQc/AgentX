/**
 * Benchmark Routes - Batches
 * Batch status, listing, timeline, recover, judge control
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');
const { judgeBatch, stopJudging, getJudgingStatus } = require('../../src/services/benchmark/judging');
const { validateObjectId } = require('../../src/helpers/objectIdValidator');
const BenchmarkBatch = require('../../models/BenchmarkBatch');

/**
 * GET /api/benchmark/batch/:id
 * Get batch progress and results
 */
router.get('/batch/:id', async (req, res) => {
    try {
        const includeHeavyPayload = ['1', 'true', 'yes']
            .includes(String(req.query.include_heavy || '').toLowerCase());

        const data = await benchmarkService.getBatch(req.params.id, { includeHeavyPayload });

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
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const batch = await BenchmarkBatch.findById(req.params.id);

        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }

        if (!['running', 'judging'].includes(batch.status) && batch.judge_status !== 'running') {
            return res.status(400).json({
                status: 'error',
                error: `Batch is ${batch.status}, cannot recover`
            });
        }

        // Stop any active judging
        stopJudging(req.params.id);

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
 * POST /api/benchmark/batch/:id/rejudge-pending
 * Re-run judging on all pending results in a batch
 */
router.post('/batch/:id/rejudge-pending', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        logger.info('Rejudging pending results', { batchId: req.params.id });

        // Start judging in background, return immediately
        judgeBatch(req.params.id, {
            judgeConfig: req.body.judge_config || {},
            concurrency: req.body.concurrency || 2
        }).catch(err => {
            logger.error('Background rejudge failed', { batchId: req.params.id, error: err.message });
        });

        res.json({
            status: 'success',
            message: 'Judging started in background. Use GET /batch/:id/judge/status to track progress.'
        });
    } catch (err) {
        logger.error('Failed to start rejudge', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/judge
 * Trigger judging on a completed batch
 */
router.post('/batch/:id/judge', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const options = {
            judgeConfig: req.body.judge_config || {},
            concurrency: req.body.concurrency || 2,
            force: req.body.force || false
        };

        // Start judging in background
        judgeBatch(req.params.id, options).catch(err => {
            logger.error('Background judging failed', { batchId: req.params.id, error: err.message });
        });

        res.json({
            status: 'success',
            message: 'Judging started in background. Use GET /batch/:id/judge/status to track progress.'
        });
    } catch (err) {
        logger.error('Failed to start judging', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batch/:id/judge/status
 * Get judge progress for a batch
 */
router.get('/batch/:id/judge/status', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const status = await getJudgingStatus(req.params.id);

        res.json({
            status: 'success',
            data: status
        });
    } catch (err) {
        logger.error('Failed to get judging status', { error: err.message, batchId: req.params.id });
        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/judge/stop
 * Stop active judging for a batch
 */
router.post('/batch/:id/judge/stop', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const stopped = stopJudging(req.params.id);

        res.json({
            status: 'success',
            message: stopped ? 'Judging stop requested' : 'No active judging to stop',
            data: { was_active: stopped }
        });
    } catch (err) {
        logger.error('Failed to stop judging', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
