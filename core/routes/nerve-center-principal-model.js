'use strict';
const express = require('express');
const { requestPrincipal } = require('../src/helpers/requestCaller');
const { getPrincipalModel, selectPrincipalModel } = require('../src/services/principalModelService');
const router = express.Router();

router.get('/principal-model', async (_req, res) => {
  try { res.json({ status: 'success', data: await getPrincipalModel() }); }
  catch (error) { res.status(error.statusCode || 500).json({ status: 'error', code: error.code, message: error.message }); }
});
router.put('/principal-model', async (req, res) => {
  try {
    const data = await selectPrincipalModel({ selected: req.body?.selected, expectedModel: req.body?.expectedModel,
      principal: requestPrincipal(req), requestId: req.body?.requestId });
    res.json({ status: 'success', data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ status: 'error', code: error.code, message: error.message,
      ...(error.rollback && { rollback: error.rollback }) });
  }
});
module.exports = router;
