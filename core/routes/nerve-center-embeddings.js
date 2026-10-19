'use strict';

// Nerve Center → Routing → Embeddings: the model RAG documents are embedded
// with. A change queues a full rebuild; search keeps the current collection
// until the rebuild completes and switches.
const express = require('express');
const { requestPrincipal } = require('../src/helpers/requestCaller');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');
const reindex = require('../src/services/embeddingReindex');
const router = express.Router();

const reply = (res, error) => res.status(error.statusCode || error.status || 503).json({
  status: 'error', code: error.code || 'EMBEDDINGS_UNAVAILABLE', message: error.message,
  ...(error.details && { details: error.details })
});

router.get('/embeddings', async (_req, res) => {
  try { res.json({ status: 'success', data: await reindex.status() }); }
  catch (error) { reply(res, error); }
});
router.post('/embeddings/change', async (req, res) => {
  const body = req.body || {};
  if (!requireTypedConfirmation(req, res, 'CHANGE EMBEDDING MODEL TO', body.model)) return;
  try { res.status(202).json({ status: 'success', data: await reindex.requestChange(body, requestPrincipal(req)) }); }
  catch (error) { reply(res, error); }
});
router.post('/embeddings/requests/:id/cancel', async (req, res) => {
  try { res.json({ status: 'success', data: await reindex.cancelChange(req.params.id, { expectedRevision: req.body?.expectedRevision }, requestPrincipal(req)) }); }
  catch (error) { reply(res, error); }
});

module.exports = router;
