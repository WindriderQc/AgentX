'use strict';

const router = require('express').Router();
const period = require('../src/services/analyticsUsagePeriod');
const envelope = require('../src/helpers/responseEnvelope');
const { requestPrincipal } = require('../src/helpers/requestCaller');
const wrap = action => async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { envelope.success(res, await action(req)); }
  catch (error) { envelope.error(res, error.statusCode || 503,
    error.statusCode ? error.message : 'Daily-use reporting period unavailable'); }
};

router.get('/usage-period', wrap(() => period.readUsagePeriod()));
// Same private-LAN human access as Analytics. Repeating the same boundary is
// safe; a different boundary refuses rather than silently resetting reports.
router.put('/usage-period', wrap(req => period.startUsagePeriod(req.body?.since,
  String(req.get('x-service-caller') || requestPrincipal(req)).slice(0, 100))));

module.exports = router;
