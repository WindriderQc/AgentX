/**
 * Janitor profile routes — thin delegation to janitorProfilesController.
 *
 * Mounted at /api/v1/janitor/profiles in server.js.
 */
const router = require('express').Router();
const ctrl = require('../controllers/janitorProfilesController');

// Profile CRUD
router.get('/',                                      ctrl.list);
router.post('/',                                     ctrl.create);

// Run history & detail (must precede /:id to avoid /:id matching "runs")
router.get('/runs/:run_id',                          ctrl.getRun);
router.post('/runs/:run_id/actions/:idx/approve',    ctrl.approve);
router.post('/runs/:run_id/actions/:idx/reject',     ctrl.reject);

// Shared-drive policy and read-only strategy reports. These must precede
// `/:id`, otherwise Express interprets "shared-drive" as a profile id.
router.get('/shared-drive/policy',                    ctrl.getSharedDrivePolicy);
router.put('/shared-drive/policy',                    ctrl.putSharedDrivePolicy);
router.post('/shared-drive/strategy',                 ctrl.generateSharedDriveStrategy);
router.get('/shared-drive/strategy/latest',           ctrl.getLatestSharedDriveStrategy);

router.get('/:id',                                   ctrl.get);
router.put('/:id',                                   ctrl.update);
router.delete('/:id',                                ctrl.remove);
router.post('/:id/run',                              ctrl.run);
router.get('/:id/runs',                              ctrl.listRuns);

module.exports = router;
