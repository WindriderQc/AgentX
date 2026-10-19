'use strict';

// Household plant cards (#866). The surface translates HTTP only; Core owns the
// card, its photos, its revision and the publish rules. Reads default to the
// child projection (published cards, no sources); `view=manage` is the parent
// page's view. Like the rest of /api/family, a pinned family device keeps the
// parent actions (owner decision, #865).

function registerPlantRoutes({ app, express, plants, standardJsonParser }) {
  const router = express.Router();
  const reply = async (res, status, operation) => {
    try { return res.status(status).json({ ok: true, status: 'success', data: await operation() }); }
    catch (error) {
      return res.status(error.status || 500).json({ ok: false, status: 'error', code: error.code || 'PLANT_FAILED',
        message: error.status ? error.message : 'Plant unavailable.', ...(error.details ? { details: error.details } : {}) });
    }
  };
  router.use(standardJsonParser);
  router.get('/', (req, res) => reply(res, 200, () => plants.list({ view: req.query.view, includeRetired: req.query.includeRetired })));
  router.post('/', (req, res) => reply(res, 201, () => plants.create(req.body || {})));
  router.get('/:id', (req, res) => reply(res, 200, () => plants.get({ id: req.params.id, view: req.query.view })));
  const actions = [['update', 'update', 200], ['photos', 'addPhoto', 201], ['publish', 'publish', 200], ['retire', 'retire', 200]];
  for (const [path, operation, status] of actions) {
    router.post(`/:id/${path}`, (req, res) => reply(res, status, () => plants[operation]({ ...(req.body || {}), id: req.params.id })));
  }
  router.post('/:id/photos/:photoId/remove', (req, res) => reply(res, 200,
    () => plants.removePhoto({ ...(req.body || {}), id: req.params.id, photoId: req.params.photoId })));
  router.get('/:id/photos/:photoId', async (req, res) => {
    try {
      const photo = await plants.photo({ id: req.params.id, photoId: req.params.photoId, view: req.query.view });
      res.set({ 'Content-Type': photo.mimeType, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff',
        ETag: `"${photo.sha256}"` });
      return res.send(photo.data);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, status: 'error', code: error.code || 'PLANT_FAILED',
        message: error.status ? error.message : 'Photo unavailable.' });
    }
  });
  app.use('/api/family/plants', router);
  return router;
}

module.exports = { registerPlantRoutes };
