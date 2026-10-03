'use strict';
const express = require('express');
const service = require('../src/services/images/imageService');

function createRouter(images = service) {
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
  router.get('/operations', wrap(async (_req, res) => res.json({ ok: true, operations: await images.list() })));
  router.post('/operations', wrap(async (req, res) => res.status(202).json({ ok: true, operation: await images.accept(req.body) })));
  router.get('/operations/:id', wrap(async (req, res) => res.json({ ok: true, operation: await images.get(req.params.id) })));
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
  app.use('/api/images', createRouter());
  app.get('/images', (_req, res) => res.render('layouts/main', {
    pageView: '../pages/images', title: 'AgentX · Images', service: 'core', activePage: 'images', showNav: true,
    headCss: '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/css/local-images.css">',
    footerJs: '<script src="/js/local-images.js" defer></script>'
  }));
}
module.exports = { mount, createRouter };
