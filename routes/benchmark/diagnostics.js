/**
 * Benchmark Routes - Diagnostics
 * Judge validation + ground truth management
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const judgeValidation = require('../../src/services/judgeValidation');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const { isValidObjectId } = require('../../src/helpers/objectIdValidator');

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
 * Get ground truth entries with high deviation
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
 * PATCH /api/benchmark/judge/ground-truth/:id
 * Update a ground truth entry (e.g. toggle active status)
 */
router.patch('/judge/ground-truth/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                status: 'error',
                error: 'Invalid ground truth ID'
            });
        }

        const allowedFields = ['active', 'expert_scores', 'expert_rationale', 'difficulty', 'tags'];
        const updates = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) updates[field] = req.body[field];
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                status: 'error',
                error: 'No valid fields to update'
            });
        }

        const entry = await JudgeGroundTruth.findByIdAndUpdate(id, { $set: updates }, { new: true });

        if (!entry) {
            return res.status(404).json({
                status: 'error',
                error: 'Ground truth entry not found'
            });
        }

        res.json({
            status: 'success',
            data: entry
        });
    } catch (err) {
        logger.error('Failed to update ground truth entry', { error: err.message });
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

        if (!isValidObjectId(id)) {
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
