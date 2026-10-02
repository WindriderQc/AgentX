'use strict';

const express = require('express');
const router = express.Router();
const proposals = require('../../src/services/profiler/contextProposalService');

const HOST_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

function hostIdFrom(value, res) {
  if (HOST_ID.test(String(value || ''))) return String(value);
  res.status(400).json({ status: 'error', error: 'hostId is required and must be a valid Host ID' });
  return null;
}

function sendError(res, error) {
  res.status(error.statusCode || 500).json({
    status: 'error',
    code: error.code || 'CONTEXT_PROPOSAL_FAILED',
    error: error.message,
    ...(error.outcome ? { outcome: error.outcome } : {}),
    ...(error.proposal ? { proposal: error.proposal } : {})
  });
}

// Proposals for every model pinned on a host (profiler cards).
router.get('/', async (req, res) => {
  try {
    const hostId = hostIdFrom(req.query.hostId, res);
    if (!hostId) return;
    res.json({ status: 'success', data: await proposals.listProposals({ hostId }) });
  } catch (error) { sendError(res, error); }
});

router.get('/:model', async (req, res) => {
  try {
    const hostId = hostIdFrom(req.query.hostId, res);
    if (!hostId) return;
    res.json({ status: 'success', data: await proposals.getProposal({ modelName: req.params.model, hostId }) });
  } catch (error) { sendError(res, error); }
});

// The operator's Apply / Keep current answer to the exact proposal shown.
router.post('/:model/decision', async (req, res) => {
  try {
    const hostId = hostIdFrom(req.body?.hostId, res);
    if (!hostId) return;
    const { proposalId, contextSize, decision } = req.body || {};
    if (typeof proposalId !== 'string' || !Number.isSafeInteger(contextSize)) {
      return res.status(400).json({ status: 'error', error: 'proposalId and integer contextSize are required' });
    }
    const data = await proposals.decide({ modelName: req.params.model, hostId, proposalId, contextSize, decision });
    res.json({ status: 'success', data });
  } catch (error) { sendError(res, error); }
});

module.exports = router;
