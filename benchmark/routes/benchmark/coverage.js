/**
 * Benchmark Routes - Coverage
 *
 * GET /api/benchmark/coverage — for each host and model in scope (pinned or
 * routed there): profile state and catalog prompts with a scored answer.
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const { buildCoverage } = require('../../src/services/measurementCoverage/coverageState');

router.get('/coverage', async (_req, res) => {
    try {
        res.json({ status: 'success', data: await buildCoverage() });
    } catch (err) {
        logger.error('Coverage matrix failed', { error: err.message });
        res.status(502).json({ status: 'error', code: 'COVERAGE_UNAVAILABLE', message: err.message });
    }
});

module.exports = router;
