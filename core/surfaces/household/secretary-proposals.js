'use strict';

const { createHistoryProposals } = require('../../src/services/historyProposalService');

// The owner's inbox of corrections Nestor proposed, under /api/secretary/proposals.
// Accepting or refusing is the owner's decision only: the Nestor contract can
// read moments and propose, never reach these routes.
function registerSecretaryProposalRoutes({ router, envelope, fail, proposals = createHistoryProposals() }) {
  const respond = async (res, action) => {
    try { res.set('Cache-Control', 'no-store'); return envelope(res, await action()); }
    catch (error) { return fail(res, error.statusCode || 500, error.message, error.code || 'HISTORY_PROPOSAL_FAILED'); }
  };
  router.get('/proposals', (req, res) => respond(res, () => proposals.list({ state: req.query.state, limit: req.query.limit })));
  router.post('/proposals/:id/accept', (req, res) => respond(res, () => proposals.accept(req.params.id, req.body || {})));
  router.post('/proposals/:id/refuse', (req, res) => respond(res, () => proposals.refuse(req.params.id, req.body || {})));
}

module.exports = { registerSecretaryProposalRoutes };
