const router = require('express').Router();
const storageController = require('../controllers/storageController');
const storageAgentController = require('../controllers/storageAgentController');
const fileBrowserController = require('../controllers/fileBrowserController');
const storageTrendsController = require('../controllers/storageTrendsController');
const vaultInventoryController = require('../controllers/vaultInventoryController');

// --- Storage Scanner ---
router.get('/scans', storageController.listScans);
router.post('/scan', storageController.scan);
router.get('/status/:scan_id', storageController.getStatus);
router.post('/stop/:scan_id', storageController.stopScan);
router.get('/directory-count', storageController.getDirectoryCount);
router.get('/summary', storageController.getSummary);
router.get('/trends', storageTrendsController.getTrends);
router.get('/agents', storageAgentController.listAgents);
router.post('/agent-scans', storageAgentController.enqueueAgentScan);
router.post('/agent/heartbeat', storageAgentController.heartbeatAgent);
router.get('/agent/requests', storageAgentController.pollAgentScan);

// Batch operations (native storage collector)
router.post('/scan/:scan_id/batch', storageController.insertBatch);
router.patch('/scan/:scan_id', storageController.updateScan);
router.get('/scan/:scan_id', storageController.getStatus);

// --- File Browser ---
router.get('/files/browse', fileBrowserController.browseFiles);
router.patch('/files/:id', fileBrowserController.updateFile);
router.get('/files/stats', fileBrowserController.getStats);
router.get('/files/tree', fileBrowserController.getDirectoryTree);
router.get('/files/duplicates', fileBrowserController.findDuplicates);
router.get('/files/cleanup-recommendations', fileBrowserController.getCleanupRecommendations);
router.get('/files/vault-inventory', vaultInventoryController.getVaultInventory);

module.exports = router;
