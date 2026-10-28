'use strict';

/**
 * Household photos through Immich. Same private-LAN access as other Core
 * product routes; callers name themselves with `x-service-caller`. Core keeps
 * the only Immich key, so no caller needs one.
 *
 * GET  /api/photos/status
 * GET  /api/photos/search/smart?q=&person=&city=&state=&country=&tag=&year=&from=&to=&limit=
 * GET  /api/photos/search?person=&city=&state=&country=&tag=&year=&from=&to=&text=&ocr=&fileName=&favorite=&order=&cursor=&limit=
 * GET  /api/photos/count?(same filters as /search)
 * GET  /api/photos/people?counts=&includeUnnamed=
 * GET  /api/photos/people/:id/assets?year=&from=&to=&cursor=&limit=
 * GET  /api/photos/places
 * GET  /api/photos/tags
 * GET  /api/photos/assets/:id
 * GET  /api/photos/assets/:id/thumbnail?size=thumbnail|preview
 * PUT  /api/photos/assets/:id/description   { description }   (off unless IMMICH_DESCRIPTION_WRITE_ENABLED=true)
 *
 * Reads take `audience=family` for children's and family surfaces: timeline
 * photos only, and no generated text the owner has not reviewed.
 */

const express = require('express');
const { createPhotoService } = require('../src/services/photos/photoService');
const { createPhotoFrameService } = require('../src/services/photos/photoFrameService');
const { requestPrincipal } = require('../src/helpers/requestCaller');

const actor = (req) => String(req.get('x-service-caller') || requestPrincipal(req)).slice(0, 100);

function sendError(res, error) {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  if (status >= 500 && !error.code) console.error('[photos]', error);
  return res.status(status).json({
    ok: false,
    code: error.code || 'PHOTOS_ERROR',
    error: {
      code: error.code || 'PHOTOS_ERROR',
      message: error.code ? error.message : 'Photo request failed',
      ...(error.code && error.details ? { details: error.details } : {}),
    },
  });
}

function createPhotoRoutes({ service = createPhotoService(), frame = createPhotoFrameService(), log = console } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const handle = (fn) => async (req, res) => {
    try { return res.json({ ok: true, data: await fn(req) }); } catch (error) { return sendError(res, error); }
  };

  router.get('/status', handle(() => service.status()));
  router.get('/frame/status', handle(() => frame.status()));
  router.get('/frame/next', handle((req) => frame.next(req.query.exclude)));
  router.get('/frame/:id/image', async (req, res) => {
    try {
      const image = await frame.image(req.params.id);
      res.set({ 'Content-Type': image.contentType, 'Content-Length': String(image.bytes.length),
        'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
      return res.end(image.bytes);
    } catch (error) { return sendError(res, error); }
  });
  router.get('/search/smart', handle((req) => service.smartSearch(req.query)));
  router.get('/search', handle((req) => service.metadataSearch(req.query)));
  router.get('/count', handle((req) => service.count(req.query)));
  router.get('/people', handle((req) => service.people(req.query)));
  router.get('/people/:id/assets', handle((req) => service.personAssets(req.params.id, req.query)));
  router.get('/places', handle(() => service.places()));
  router.get('/tags', handle((req) => service.tags(req.query)));
  router.get('/assets/:id', handle((req) => service.asset(req.params.id, req.query)));

  router.get('/assets/:id/thumbnail', async (req, res) => {
    try {
      const image = await service.thumbnail(req.params.id, req.query.size, req.query);
      res.set({
        'Content-Type': image.contentType,
        'Content-Length': String(image.bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      });
      return res.end(image.bytes);
    } catch (error) { return sendError(res, error); }
  });

  router.put('/assets/:id/description', handle(async (req) => {
    const result = await service.setDescription(req.params.id, req.body?.description);
    log.info?.(`[photos] description set on ${result.id} by ${actor(req)}`);
    return result;
  }));

  return router;
}

function mount(app, jsonParser) {
  app.use('/api/photos', jsonParser, createPhotoRoutes());
}

module.exports = { createPhotoRoutes, mount };
