/**
 * Benchmark Routes - Hardware
 * Hardware profiling endpoints
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const hardwareProfileService = require('../../src/services/hardwareProfileService');

/**
 * GET /api/benchmark/hardware/compare/:model
 * Compare hardware performance across different hosts for a model
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
 * Get aggregate statistics across all backends
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
 */
router.get('/hardware/profiles', async (req, res) => {
    try {
        const HardwareProfile = require('../../models/HardwareProfile');
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

module.exports = router;
