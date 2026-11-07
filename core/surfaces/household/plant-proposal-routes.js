'use strict';

// Children's plant proposals (#876), for Ma jungle on the family tablet. The
// surface translates HTTP only; Core owns the rules. A child can send, read and
// acknowledge their own proposal, never open, publish or decline one: those are
// the parent's routes under /api/family/plants/:id.

function registerPlantProposalRoutes({ app, express, proposals, standardJsonParser }) {
  const router = express.Router();
  const fail = (res, error, fallback) => res.status(error.status || 500).json({ ok: false, status: 'error',
    code: error.code || 'PLANT_PROPOSAL_FAILED', message: error.status ? error.message : fallback });
  const reply = async (res, status, operation) => {
    try { return res.status(status).json({ ok: true, status: 'success', data: await operation() }); }
    catch (error) { return fail(res, error, 'Proposal unavailable.'); }
  };
  router.use(standardJsonParser);
  router.get('/', (req, res) => reply(res, 200, () => proposals.status({ profileId: req.query.profileId })));
  router.post('/', (req, res) => reply(res, 201, () => proposals.propose(req.body || {})));
  router.post('/:id/seen', (req, res) => reply(res, 200, () => proposals.seen({ id: req.params.id, profileId: req.body?.profileId })));
  router.get('/:id/photo', async (req, res) => {
    try {
      const photo = await proposals.photo({ id: req.params.id, profileId: req.query.profileId });
      res.set({ 'Content-Type': photo.mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.send(photo.data);
    } catch (error) { return fail(res, error, 'Photo unavailable.'); }
  });
  app.use('/api/family/plant-proposals', router);
  return router;
}

module.exports = { registerPlantProposalRoutes };
