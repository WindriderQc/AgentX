'use strict';
const express = require('express');
const { requestPrincipal } = require('../src/helpers/requestCaller');
const { getPrincipalModel, selectPrincipalModel, saveChoice, listPrincipalHostModels } = require('../src/services/principalModelService');
const router = express.Router();

function fail(res, error) {
  res.status(error.statusCode || 500).json({ status: 'error', code: error.code, message: error.message,
    ...(error.rollback && { rollback: error.rollback }) });
}

router.get('/principal-model', async (_req, res) => {
  try { res.json({ status: 'success', data: await getPrincipalModel() }); }
  catch (error) { fail(res, error); }
});
router.put('/principal-model', async (req, res) => {
  try {
    const data = await selectPrincipalModel({ selected: req.body?.selected, expectedModel: req.body?.expectedModel,
      principal: requestPrincipal(req), requestId: req.body?.requestId });
    res.json({ status: 'success', data });
  } catch (error) { fail(res, error); }
});
// The models the operator can name for Standard or Abliterated.
router.get('/principal-model/installed', async (_req, res) => {
  try { res.json({ status: 'success', data: await listPrincipalHostModels() }); }
  catch (error) { fail(res, error); }
});
router.put('/principal-model/choices', async (req, res) => {
  try {
    const data = await saveChoice({ option: req.body?.option, model: req.body?.model,
      expectedRevision: req.body?.expectedRevision, expectedModel: req.body?.expectedModel,
      principal: requestPrincipal(req), requestId: req.body?.requestId });
    res.json({ status: 'success', data });
  } catch (error) { fail(res, error); }
});
module.exports = router;
