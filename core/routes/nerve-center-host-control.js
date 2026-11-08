'use strict';

const router = require('express').Router();
const { changeHostControl } = require('../src/services/hostControlService');

router.post('/inference-hosts/:hostId/control', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const control = await changeHostControl(req.params.hostId, req.body || {});
    return res.json({ status: 'success', data: { control } });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ status: 'error',
      code: error.code || 'HOST_CONTROL_FAILED', message: error.message });
  }
});

module.exports = router;
