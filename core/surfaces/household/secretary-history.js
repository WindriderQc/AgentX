'use strict';

const history = require('../../src/services/personalHistoryService');
const context = require('../../src/services/personalHistoryContextService');

function registerSecretaryHistoryRoutes({ router, envelope, fail }) {
  const respond = async (res, action) => {
    try { return envelope(res, await action()); }
    catch (error) { return fail(res, error.statusCode || 500, error.message, error.code || 'PERSONAL_HISTORY_FAILED'); }
  };
  router.get('/history', (req, res) => respond(res, () => history.list(req.query)));
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
