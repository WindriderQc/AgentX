// routes/benchmark/judgeQualification.js
// Read-only grader qualification records. Recording happens only through
// POST /judge/calibrate-accuracy; nothing here runs inference.
const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const { validateObjectId } = require('../../src/helpers/objectIdValidator');
const { getQualificationRecord, listQualifications } = require('../../src/services/benchmark/judgeQualification');

router.get('/judge/qualifications', async (req, res) => {
    try {
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
        res.json({ status: 'success', data: await listQualifications({ limit }) });
    } catch (err) {
        logger.error('Failed to list judge qualifications', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

router.get('/judge/qualifications/:id', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Qualification ID')) return;
        const record = await getQualificationRecord(req.params.id);
        if (!record) return res.status(404).json({ status: 'error', error: 'Qualification record not found' });
        res.json({ status: 'success', data: record });
    } catch (err) {
        logger.error('Failed to read judge qualification', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
