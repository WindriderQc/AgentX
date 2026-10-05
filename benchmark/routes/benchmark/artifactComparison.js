/**
 * Benchmark Routes - paired artifact comparison
 * POST /comparison/paired: compare two (batch, model, host) arms prompt by prompt.
 */

const router = require('express').Router();
const mongoose = require('mongoose');
const logger = require('../../config/logger');
const { BENCHMARK_CATEGORY_KEYS } = require('../../config/categories');
const { compareArtifacts } = require('../../src/services/benchmark/artifactComparison');

function parseArm(value, label) {
    const arm = value && typeof value === 'object' ? value : {};
    const batchId = String(arm.batch_id || '');
    const model = typeof arm.model === 'string' ? arm.model.trim() : '';
    const host = typeof arm.host === 'string' ? arm.host.trim() : '';
    if (!mongoose.Types.ObjectId.isValid(batchId)) return { error: `${label}.batch_id must be a batch id` };
    if (!model || model.length > 200) return { error: `${label}.model is required (at most 200 characters)` };
    if (host.length > 300) return { error: `${label}.host must be at most 300 characters` };
    return { arm: { batch_id: batchId, model, ...(host && { host }) } };
}

/**
 * Body: { a: { batch_id, model, host? }, b: { batch_id, model, host? },
 *         categories?: string[], bootstrap?: { iterations?, seed? } }
 * The delta is B − A in points (0–100).
 */
router.post('/comparison/paired', async (req, res) => {
    const body = req.body || {};
    const a = parseArm(body.a, 'a');
    const b = parseArm(body.b, 'b');
    const invalid = a.error || b.error;
    if (invalid) return res.status(400).json({ status: 'error', error: invalid });
    const categories = body.categories === undefined ? [] : body.categories;
    if (!Array.isArray(categories) || categories.some((category) => !BENCHMARK_CATEGORY_KEYS.includes(category))) {
        return res.status(400).json({ status: 'error', error: `categories must be a list of: ${BENCHMARK_CATEGORY_KEYS.join(', ')}` });
    }
    try {
        const data = await compareArtifacts(a.arm, b.arm, { categories, bootstrap: body.bootstrap });
        return res.json({ status: 'success', data });
    } catch (error) {
        if (!error.statusCode) logger.error('Paired artifact comparison failed', { error: error.message });
        return res.status(error.statusCode || 500).json({ status: 'error', code: error.code, error: error.message });
    }
});

module.exports = router;
