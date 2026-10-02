const router = require('express').Router();
const hardwareController = require('../controllers/hardwareController');

// ─── Read surfaces ────────────────────────────────────────
router.get('/collectors', hardwareController.listCollectors);
router.get('/latest', hardwareController.latest);
router.get('/history', hardwareController.history);

// ─── Native GPU collector surfaces ────────────────────────
router.post('/collector/heartbeat', hardwareController.heartbeat);
router.post('/samples', hardwareController.ingestSamples);

module.exports = router;
