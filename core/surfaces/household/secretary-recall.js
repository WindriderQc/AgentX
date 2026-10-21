'use strict';

const recall = require('../../src/services/ownerRecallService');

// The owner's private recall corpus under /api/secretary/recall: the archive
// importer indexes mail and read attachments, Core syncs souvenirs and people,
// and the owner can search it or forget one document.
function registerSecretaryRecallRoutes({ router, envelope, fail }) {
  const respond = async (res, action) => {
    try { res.set('Cache-Control', 'no-store'); return envelope(res, await action()); }
    catch (error) { return fail(res, error.statusCode || 500, error.message, error.code || 'OWNER_RECALL_FAILED'); }
  };
  router.get('/recall/status', (_req, res) => respond(res, () => recall.status()));
  router.get('/recall/search', (req, res) => respond(res, () => recall.search(req.query.query, { limit: req.query.limit })));
  router.post('/recall/documents', (req, res) => respond(res, () => recall.index(req.body?.documents)));
  router.post('/recall/sync', (req, res) => respond(res, () => recall.sync({ limit: req.body?.limit })));
  router.delete('/recall/documents/:documentId', (req, res) => respond(res, () => recall.forget(req.params.documentId)));
}

module.exports = { registerSecretaryRecallRoutes };
