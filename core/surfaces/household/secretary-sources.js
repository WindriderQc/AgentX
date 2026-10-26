'use strict';

const { createOwnerSources } = require('../../src/services/ownerSourceService');

// The owner's non-mail sources under /api/secretary: statements in the owner's
// own words, Core records and household files cited by history entries. Owner
// surface only, like the rest of /api/secretary.
function registerSecretarySourceRoutes({ router, envelope, fail, sources = createOwnerSources() }) {
  const respond = async (res, action) => {
    try { res.set('Cache-Control', 'no-store'); return envelope(res, await action()); }
    catch (error) { return fail(res, error.statusCode || 500, error.message, error.code || 'OWNER_SOURCE_FAILED'); }
  };
  router.get('/statements', (_req, res) => respond(res, () => sources.statements()));
  router.post('/statements', (req, res) => respond(res, () => sources.keepStatements(req.body?.statements)));
  router.get('/sources/read', (req, res) => respond(res, () => sources.read({
    system: String(req.query.system || ''), locator: String(req.query.locator || ''), sha256: String(req.query.sha256 || '') })));
  const guarded = handler => async (req, res) => {
    try { return await handler(req, res); }
    catch { if (!res.headersSent) return fail(res, 404, 'File unavailable', 'OWNER_SOURCE_UNAVAILABLE'); return res.destroy(); }
  };
  router.get('/sources/file', guarded((req, res) => sources.sendFile(req, res)));
  router.get('/sources/folder-image', guarded((req, res) => sources.sendFolderImage(req, res)));
}

module.exports = { registerSecretarySourceRoutes };
