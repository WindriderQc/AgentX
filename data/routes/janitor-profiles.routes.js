/**
 * Janitor profile routes — thin delegation to janitorProfilesController.
 *
 * Mounted at /api/v1/janitor/profiles in server.js.
 */
const router = require('express').Router();
const ctrl = require('../controllers/janitorProfilesController');
const review = require('../controllers/janitorReviewDecisionsController');

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
router.get('/shared-drive/strategy/latest/groups',    review.groupsPage);

// Stored duplicate-review decisions: the owner's intent per duplicate group.
// Storing one approves, previews and executes nothing; the approve route above
// is the only way to an action and does not read them.
router.get('/shared-drive/review-decisions',          review.list);
router.post('/shared-drive/review-decisions/batch',   review.batch);
router.put('/shared-drive/review-decisions/:sha256',  review.put);
router.delete('/shared-drive/review-decisions/:sha256', review.remove);

router.get('/:id',                                   ctrl.get);
router.put('/:id',                                   ctrl.update);
router.delete('/:id',                                ctrl.remove);
router.post('/:id/run',                              ctrl.run);
router.get('/:id/runs',                              ctrl.listRuns);

module.exports = router;
