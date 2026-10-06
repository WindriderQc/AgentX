/**
 * Benchmark Routes - Coverage
 *
 * GET /api/benchmark/coverage           — matrix (host and model in scope:
 *                                          profile state, catalog prompts
 *                                          scored) and the job's state
 * GET /api/benchmark/coverage/settings  — the job's settings
 * PUT /api/benchmark/coverage/settings  — switch, quiet hours, bite size
 * POST/DELETE /api/benchmark/coverage/requests — ask for a pair to be measured
 *                                          first; it still waits for quiet hours
 * GET /api/benchmark/coverage/results   — recent scores of one pair
 * POST /api/benchmark/coverage/carry-over — carry stored grades over to the
 *                                          current scorer version (dryRun reports)
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const { buildCoverage } = require('../../src/services/measurementCoverage/coverageState');
const settingsStore = require('../../src/services/measurementCoverage/coverageSettings');
const { getCoverageJob } = require('../../src/services/measurementCoverage/coverageJob');
const requests = require('../../src/services/measurementCoverage/coverageRequests');
const { carryOverStoredGrades } = require('../../src/services/measurementCoverage/gradeCarryOverPass');

function fail(res, err) {
    res.status(err.statusCode || 500).json({ status: 'error', code: err.code || 'COVERAGE_FAILED', message: err.message });
}

router.get('/coverage', async (_req, res) => {
    try {
        const [coverage, settings, state] = await Promise.all([
            buildCoverage(), settingsStore.getSettings(), settingsStore.getState()
        ]);
        const cells = coverage.cells.map(cell => ({ ...cell, request: state.requests[requests.cellKey(cell)] || null }));
        res.json({ status: 'success', data: { ...coverage, cells, job: { settings, last: state.last, ...getCoverageJob().status() } } });
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

router.post('/coverage/requests', (req, res) => requests.requestMeasurement(req.body || {})
    .then(data => res.status(201).json({ status: 'success', data })).catch(err => fail(res, err)));

router.delete('/coverage/requests', (req, res) => requests.cancelRequest(req.body || {})
    .then(data => res.json({ status: 'success', data })).catch(err => fail(res, err)));

// Carry stored grades over to the current scorer version; { dryRun: true } only reports.
router.post('/coverage/carry-over', (req, res) => carryOverStoredGrades({ dryRun: req.body?.dryRun === true })
    .then(data => res.json({ status: 'success', data })).catch(err => fail(res, err)));

router.get('/coverage/results', (req, res) => requests.recentResults(req.query || {})
    .then(data => res.json({ status: 'success', data })).catch(err => fail(res, err)));

module.exports = router;
