'use strict';
const express = require('express');
const service = require('../src/services/images/imageService');
const presentation = require('../src/services/images/workshopPresentation');
const recipeExport = require('../src/services/images/recipeExport');
const composition = require('../src/services/images/protectedComposition');

function createRouter(images = service, workshop = presentation, exports = recipeExport, compositions = composition) {
  const router = express.Router();
  const wrap = handler => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { await handler(req, res); }
    catch (error) {
      res.status(error.statusCode || 503).json({ ok: false, code: 'LOCAL_IMAGE_ERROR',
        message: error.statusCode ? error.message : 'Le service image est indisponible. Consulte son état avant une nouvelle demande.' });
    }
  };
  router.get('/status', wrap(async (_req, res) => res.json({ ok: true, ...images.status() })));
  router.get('/workshop', wrap(async (_req, res) => res.json({ ok: true, ...await workshop.overview() })));
  router.get('/operations', wrap(async (_req, res) => res.json({ ok: true, operations: await images.list() })));
  router.post('/operations', wrap(async (req, res) => res.status(202).json({ ok: true, operation: await images.accept(req.body) })));
  router.get('/operations/:id', wrap(async (req, res) => res.json({ ok: true, operation: await images.get(req.params.id) })));
  router.get('/operations/:id/draft', wrap(async (req, res) => res.json({ ok: true, draft: await images.draft(req.params.id) })));
  router.get('/operations/:id/details', wrap(async (req, res) => res.json({ ok: true, details: await workshop.details(req.params.id) })));
  router.post('/operations/:id/protected-composition', wrap(async (req, res) => res.json({ ok: true, ...await compositions.build(req.params.id, req.body) })));
  router.get('/operations/:id/export', wrap(async (req, res) => {
    const manifest = await exports.manifest(req.params.id);
    res.set('Content-Type', 'application/json; charset=utf-8').set('X-Content-Type-Options', 'nosniff')
      .set('Content-Disposition', 'attachment; filename="image-recipe.json"')
      .send(JSON.stringify(manifest, null, 2) + '\n');
  }));
  router.get('/operations/:id/export/parts/:name', wrap(async (req, res) => {
    const part = await exports.part(req.params.id, req.params.name);
    res.set('Content-Type', part.mimeType === 'application/json' ? 'application/json; charset=utf-8' : part.mimeType).set('X-Content-Type-Options', 'nosniff')
      .set('Content-Disposition', `attachment; filename="${part.filename}"`).send(part.bytes);
  }));
  router.post('/operations/:id/cancel', wrap(async (req, res) => res.json({ ok: true, operation: await images.cancel(req.params.id) })));
  router.post('/operations/:id/archive', wrap(async (req, res) => res.json({ ok: true, operation: await images.retryArchive(req.params.id) })));
  router.post('/operations/:id/recover', wrap(async (req, res) => res.json({ ok: true, operation: await images.recover(req.params.id) })));
  router.get('/operations/:id/image', wrap(async (req, res) => {
    const artifact = await images.image(req.params.id);
    res.set('Content-Type', artifact.mimeType).set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `inline; filename="image-${req.params.id}.png"`).send(artifact.bytes);
  }));
  return router;
}
function mount(app) {
  app.use('/api/images/expert', require('./image-expert').createRouter());
  app.use('/api/images', createRouter());
  app.get('/images', (_req, res) => res.render('layouts/main', {
    pageView: '../pages/images', title: 'AgentX · Images', service: 'core', activePage: 'images', showNav: true,
    headCss: '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/css/local-images.css"><link rel="stylesheet" href="/css/local-images-guide.css"><link rel="stylesheet" href="/css/image-expert.css"><link rel="stylesheet" href="/css/image-text-editor.css"><link rel="stylesheet" href="/css/image-brief-constraints.css"><link rel="stylesheet" href="/css/image-compare.css"><link rel="stylesheet" href="/css/image-protected-composition.css"><link rel="stylesheet" href="/css/image-layout-guide.css">',
    footerJs: '<script src="/js/image-starters.js" defer></script><script src="/js/image-brief-constraints.js" defer></script><script src="/js/image-brief-constraints-ui.js" defer></script><script src="/js/image-expert.js" defer></script><script src="/js/image-text-project.js" defer></script><script src="/js/image-text-editor.js" defer></script><script src="/js/image-compare.js" defer></script><script src="/js/image-protected-composition.js" defer></script><script src="/js/image-layout-guide.js" defer></script><script src="/js/local-images.js" defer></script>'
  }));
  app.get('/images/guide', (_req, res) => res.render('layouts/main', {
    pageView: '../pages/images-guide', title: 'AgentX · Images · Comment ça marche', service: 'core', activePage: 'images', showNav: true,
    headCss: '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/css/local-images.css"><link rel="stylesheet" href="/css/local-images-guide.css">',
    footerJs: '<script src="/js/local-images-guide.js" defer></script>'
  }));
}
module.exports = { mount, createRouter };
