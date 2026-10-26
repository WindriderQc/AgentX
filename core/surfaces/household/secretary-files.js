'use strict';

const { createOwnerFiles } = require('../../src/services/ownerFileService');

// Household files the owner's history points to (photos, photo folders,
// Datalake documents), under /api/secretary/files. Owner surface only.
function registerSecretaryFileRoutes({ router, envelope, fail, files = createOwnerFiles() }) {
  router.get('/files/read', async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); return envelope(res, await files.read(req.query.locator, req.query.sha256, req.query.nativePath)); }
    catch (error) { return fail(res, error.statusCode || 500, error.message, error.code || 'OWNER_FILE_FAILED'); }
  });
  const guarded = handler => async (req, res) => {
    try { return await handler(req, res); }
    catch { if (!res.headersSent) return fail(res, 404, 'File unavailable', 'OWNER_FILE_UNAVAILABLE'); return res.destroy(); }
  };
  router.get('/files/content', guarded((req, res) => files.sendContent(req, res)));
  router.get('/files/folder-image', guarded((req, res) => files.sendFolderImage(req, res)));
}

module.exports = { registerSecretaryFileRoutes };
