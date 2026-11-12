'use strict';

const history = require('../../src/services/personalHistoryService');
const context = require('../../src/services/personalHistoryContextService');
const sourceReview = require('../../src/services/personalHistorySourceReview');
const preservation = require('../../src/services/personalHistoryPreservation');
const decisionState = require('../../src/services/personalHistoryDecisionState');

function registerSecretaryHistoryRoutes({ router, envelope, fail, sourceReviewDeps = { audience: 'owner' },
  preservationDeps = { audience: 'owner' }, decisionStateDeps = { audience: 'owner' } }) {
  const respond = async (res, action) => {
    try { return envelope(res, await action()); }
    catch (error) { return fail(res, error.statusCode || 500, error.message, error.code || 'PERSONAL_HISTORY_FAILED'); }
  };
  const sourceResponse = (res, action) => { res.set('Cache-Control', 'private, no-store'); return respond(res, action); };
  router.get('/history', (req, res) => respond(res, () => history.list(req.query)));
  router.get('/history/timeline', (_req, res) => respond(res, () => history.timeline()));
  router.get('/history/:id/decision-state', (req, res) => sourceResponse(res,
    () => decisionState.get(req.params.id, req.query, decisionStateDeps)));
  router.post('/history/:id/decision-state/check', (req, res) => sourceResponse(res,
    () => decisionState.check(req.params.id, req.body, decisionStateDeps)));
  // The existing private LAN human surface owns this domain. Caller headers,
  // profile names and model tools cannot supply its audience or a decision.
  router.post('/history/:id/source-review', (req, res) => sourceResponse(res, () => sourceReview.prepare(req.params.id, req.body, sourceReviewDeps)));
  router.get('/history/:id/source-review/:requestId', (req, res) => sourceResponse(res, () => sourceReview.get(req.params.id, req.params.requestId, sourceReviewDeps)));
  router.get('/history/:id/source-review/:requestId/page', (req, res) => sourceResponse(res, () => sourceReview.page(req.params.id, req.params.requestId,
    { source: Number(req.query.source), part: Number(req.query.part), offset: Number(req.query.offset) }, sourceReviewDeps)));
  router.post('/history/:id/source-review/:requestId/decision', (req, res) => sourceResponse(res, () => sourceReview.decide(req.params.id, req.params.requestId, req.body, sourceReviewDeps)));
  router.get('/history/:id/preservation', (req, res) => sourceResponse(res, () => preservation.list(req.params.id, preservationDeps)));
  router.post('/history/:id/preservation', (req, res) => sourceResponse(res, () => preservation.prepare(req.params.id, req.body, preservationDeps)));
  router.get('/history/:id/preservation/:requestId', (req, res) => sourceResponse(res, () => preservation.get(req.params.id, req.params.requestId, preservationDeps)));
  router.post('/history/import', (req, res) => respond(res, async () => {
    const entries = req.body?.entries;
    if (!Array.isArray(entries) || !entries.length || entries.length > 50) {
      throw Object.assign(new Error('Import 1-50 source assertions'), { statusCode: 400 });
    }
    // Validate the entire batch before the first write. Replayed imports use
    // deterministic keys; accepted decisions cannot be overwritten by import.
    entries.forEach(history.normalize);
    const results = [];
    for (const entry of entries) results.push(await history.record(entry));
    return { authority: 'agentx.core', results };
  }));
  router.post('/history/context/import', (req, res) => respond(res, () => context.importBatch(req.body)));
  router.get('/history/:id', (req, res) => respond(res, () => context.get(req.params.id, { includeSourceBodies: req.query.includeSourceBodies === 'true' })));
  router.get('/history/:id/sources/:sourceId', (req, res) => respond(res, () => context.source(req.params.id, req.params.sourceId)));
  router.post('/history/:id/context', (req, res) => respond(res, () => context.edit(req.params.id, req.body)));
  router.post('/history/:id/review', (req, res) => respond(res, () => history.review(req.params.id, req.body)));
  router.post('/history/:id/souvenir', (req, res) => respond(res, () => history.keepAsSouvenir(req.params.id, req.body || {})));
}

module.exports = { registerSecretaryHistoryRoutes };
