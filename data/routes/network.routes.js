const router = require('express').Router();
const networkController = require('../controllers/networkController');

// ─── UI / read surfaces ───────────────────────────────────
router.get('/capability', networkController.getCapability);
router.get('/devices', networkController.getAllDevices);
router.get('/agents', networkController.getScanAgents);
router.post('/scan', networkController.scanNetwork);           // enqueue (agent) or in-container fallback
router.get('/scan-requests/:id', networkController.getScanRequestStatus);  // UI job-status polling

// ─── LAN collector surfaces ───────────────────────────────
router.get('/scan-requests', networkController.getScanRequests);   // agent poll + heartbeat
router.post('/scan-results', networkController.ingestScanResults); // agent posts results

// ─── Device metadata + deep scan ──────────────────────────
router.patch('/devices/:id', networkController.updateDevice);
router.post('/devices/:id/enrich', networkController.enrichDevice);

module.exports = router;
