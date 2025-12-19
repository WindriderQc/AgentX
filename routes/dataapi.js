const express = require('express');
const router = express.Router();
const { optionalAuth } = require('../src/middleware/auth');
const { dataapi, DataApiError } = require('../src/services/dataapiClient');

router.get('/info', optionalAuth, (req, res) => {
    const baseUrl = process.env.DATAAPI_BASE_URL || null;
    res.json({ status: 'success', data: { baseUrl } });
});

router.get('/files/search', optionalAuth, async (req, res) => {
    try {
        const { q, limit, skip } = req.query;
        const result = await dataapi.files.search({
            q: q || '',
            limit: limit !== undefined ? Number(limit) : undefined,
            skip: skip !== undefined ? Number(skip) : undefined
        });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/files/duplicates', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.files.duplicates();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/files/stats', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.files.stats();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/files/tree', optionalAuth, async (req, res) => {
    try {
        const { root } = req.query;
        const result = await dataapi.files.tree({ root: root || '/' });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/files/cleanup-recommendations', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.files.cleanupRecommendations();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/files/exports', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.files.exportsList();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/files/export-optimized', optionalAuth, async (req, res) => {
    try {
        const { type } = req.query;
        const result = await dataapi.files.exportOptimized({ type: type || 'summary' });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/storage/scan', optionalAuth, async (req, res) => {
    try {
        const { roots, extensions, batch_size } = req.body || {};
        const result = await dataapi.storage.scanStart({ roots, extensions, batch_size });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/storage/scans', optionalAuth, async (req, res) => {
    try {
        const { limit, skip } = req.query;
        const result = await dataapi.storage.scansList({
            limit: limit !== undefined ? Number(limit) : undefined,
            skip: skip !== undefined ? Number(skip) : undefined
        });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/storage/status/:scan_id', optionalAuth, async (req, res) => {
    try {
        const { scan_id } = req.params;
        const result = await dataapi.storage.scanStatus({ scan_id });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/storage/stop/:scan_id', optionalAuth, async (req, res) => {
    try {
        const { scan_id } = req.params;
        const result = await dataapi.storage.scanStop({ scan_id });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/live/iss', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.live.iss();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/live/quakes', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.live.quakes();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
