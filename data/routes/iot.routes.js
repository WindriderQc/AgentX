const router = require('express').Router();
const iotController = require('../controllers/iotController');

// Ingestion, rollup and backfill state
router.get('/status', iotController.status);
router.get('/profiles', iotController.profiles);
router.put('/profiles/:name', iotController.saveProfile);

// Device registry
router.get('/devices', iotController.listDevices);
router.get('/devices/:id', iotController.getDevice);
router.patch('/devices/:id', iotController.patchDevice);

// Sampled history (stored buckets) and the last raw readings (memory only)
router.get('/devices/:id/history', iotController.history);
router.get('/devices/:id/live', iotController.live);

// One command to a device (QoS 0, never queued)
router.post('/devices/:id/commands', iotController.command);
router.get('/devices/:id/controls', iotController.controls);
router.put('/devices/:id/profile', iotController.assignProfile);
router.post('/devices/:id/profile/apply', iotController.applyProfile);
router.put('/devices/:id/timers/:io', iotController.saveTimer);
router.post('/devices/:id/timers/:io/apply', iotController.applyTimer);
router.post('/devices/:id/operations/:requestId/resolve', iotController.resolve);

module.exports = router;
