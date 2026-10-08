/**
 * Janitor routes — thin delegation to janitorController.
 */
const router = require('express').Router();
const janitorController = require('../controllers/janitorController');

router.post('/analyze',       janitorController.analyze);
router.post('/suggest',       janitorController.suggest);
router.get('/policies',       janitorController.listPolicies);
router.post('/dedup-scan',    janitorController.dedupScan);
router.get('/dedup-report',   janitorController.dedupReport);
router.post('/ai',            janitorController.aiChat);

module.exports = router;
