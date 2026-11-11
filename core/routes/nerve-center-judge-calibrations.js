'use strict';

const router = require('express').Router();
const { requestPrincipal } = require('../src/helpers/requestCaller');
const { operate } = require('../src/services/judgeCalibrationControl');

function handle(input) {
  return async (req, res) => {
    try {
      const data = await operate(input(req), requestPrincipal(req));
      return res.status(data.accepted ? 202 : 200).json({ status: 'success', data });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ status: 'error',
        code: error.code || 'CALIBRATION_CONTROL_UNAVAILABLE',
        message: error.code ? error.message : 'Calibration control is unavailable.' });
    }
  };
}

router.get('/judge-calibrations', handle(() => ({ action: 'list' })));
router.get('/judge-calibrations/:admissionId', handle(req => ({ action: 'show', id: req.params.admissionId })));
router.post('/judge-calibrations/:admissionId/cancel', handle(req => {
  if (Object.keys(req.body || {}).some(key => !['workloadId', 'requestId', 'reason'].includes(key)))
    throw Object.assign(new Error('Only workloadId, requestId and reason are accepted.'), {
      statusCode: 400, code: 'INVALID_ARGUMENTS'
    });
  return { ...req.body, action: 'cancel', id: req.params.admissionId };
}));

module.exports = router;
