'use strict';
// Same parent-action access contract as the existing plant management routes
// (#865). Import is absent from the child projection and child page.
function registerPlantImportRoutes({ router, importer, reply }) {
  router.get('/import-folder', (req, res) => reply(res, 200, () => importer.list({ offset: req.query.offset })));
  router.post('/import-folder', (req, res) => reply(res, 201, () => importer.importGroup(req.body || {})));
  router.get('/import-folder/thumbnail', async (req, res) => {
    try {
      const photo = await importer.thumbnail({ name: req.query.name, sha256: req.query.sha256 });
      res.set({ 'Content-Type': photo.mimeType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.send(photo.data);
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, code: error.code || 'PLANT_IMPORT_FAILED',
        message: error.status ? error.message : 'Miniature indisponible.' });
    }
  });
}
module.exports = { registerPlantImportRoutes };
