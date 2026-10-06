/**
 * Benchmark Routes - Coverage
 *
 * GET /api/benchmark/coverage           — matrix (host and model in scope:
 *                                          profile state, catalog prompts
 *                                          scored) and the job's state
 * GET /api/benchmark/coverage/settings  — the job's settings
 * PUT /api/benchmark/coverage/settings  — switch, quiet hours, bite size
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const { buildCoverage } = require('../../src/services/measurementCoverage/coverageState');
const settingsStore = require('../../src/services/measurementCoverage/coverageSettings');
const { getCoverageJob } = require('../../src/services/measurementCoverage/coverageJob');

router.get('/coverage', async (_req, res) => {
    try {
        const [coverage, settings, state] = await Promise.all([
            buildCoverage(), settingsStore.getSettings(), settingsStore.getState()
        ]);
        res.json({ status: 'success', data: { ...coverage, job: { settings, last: state.last, ...getCoverageJob().status() } } });
    } catch (err) {
        logger.error('Coverage matrix failed', { error: err.message });
        res.status(502).json({ status: 'error', code: 'COVERAGE_UNAVAILABLE', message: err.message });
    }
});

router.get('/coverage/settings', async (_req, res) => {
    try {
        res.json({ status: 'success', data: await settingsStore.getSettings() });
    } catch (err) {
        res.status(500).json({ status: 'error', code: 'COVERAGE_SETTINGS_FAILED', message: err.message });
    }
});

router.put('/coverage/settings', async (req, res) => {
    try {
        const settings = await settingsStore.saveSettings(req.body || {});
        logger.info('Coverage settings saved', settings);
        res.json({ status: 'success', data: settings });
    } catch (err) {
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code || 'COVERAGE_SETTINGS_FAILED', message: err.message });
    }
});

module.exports = router;
