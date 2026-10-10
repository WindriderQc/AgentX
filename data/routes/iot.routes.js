const router = require('express').Router();
const iotController = require('../controllers/iotController');

// Ingestion, rollup and backfill state
router.get('/status', iotController.status);

// Device registry
router.get('/devices', iotController.listDevices);
router.get('/devices/:id', iotController.getDevice);
router.patch('/devices/:id', iotController.patchDevice);

// Sampled history (stored buckets) and the last raw readings (memory only)
router.get('/devices/:id/history', iotController.history);
router.get('/devices/:id/live', iotController.live);

// One command to a device (QoS 0, never queued)
router.post('/devices/:id/commands', iotController.command);

module.exports = router;
