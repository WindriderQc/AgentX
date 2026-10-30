'use strict';
const express = require('express');
const service = require('../src/services/transcriptionService');
const { srt } = require('../src/services/transcriptionContract');
function createRouter(api = service) {
  const router = express.Router();
  const handle = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json({ ok: true, data: await fn(req) }); }
    catch (error) { res.status(error.statusCode || 503).json({ ok: false, error: {
      message: error.statusCode ? error.message : 'Le service est momentanément indisponible. Votre demande peut avoir été conservée ; actualisez la liste.',
      code: error.code || 'TRANSCRIPTION_UNAVAILABLE'
    } }); }
  };
  router.get('/', handle(req => api.list({ search: req.query.q, offset: req.query.offset || 0 })));
  router.post('/', express.json({ limit: '4kb' }), handle(req => api.create(req.body)));
  router.get('/status', handle(() => require('../src/services/transcriptionStatusService').status()));
  router.get('/:id', handle(req => api.get(req.params.id, true)));
  router.post('/:id/cancel', handle(req => api.cancel(req.params.id)));
  router.post('/:id/retry', express.json({ limit: '1kb' }), handle(req => api.retry(req.params.id, req.body)));
  router.get('/:id/export/:format', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!['txt', 'srt'].includes(req.params.format)) return res.sendStatus(404);
      const row = await api.get(req.params.id, true);
      if (row.state !== 'completed') return res.status(409).send('La transcription n’est pas terminée.');
      const format = req.params.format;
      res.type(format === 'srt' ? 'application/x-subrip' : 'text/plain').attachment('transcription-' + row._id + '.' + format)
        .send(format === 'srt' ? srt(row.result?.segments) : row.result?.text || '');
    } catch { res.status(503).send('Export indisponible.'); }
  });
  return router;
}
function mount(app, api = service) {
  app.use('/api/transcriptions', createRouter(api));
  app.get('/transcriptions', (_req, res) => res.render('layouts/main', {
    pageView: '../pages/transcriptions', pageLanguage: 'fr', title: 'AgentX · Transcriptions', service: 'core',
    activePage: 'transcriptions', bodyClass: 'transcriptions-surface',
    headCss: '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/css/transcriptions.css">',
    footerJs: '<script src="/js/transcription-time.js" defer></script><script src="/js/transcription-flow.js" defer></script><script src="/js/transcriptions.js" defer></script>'
  }));
}
module.exports = { mount, createRouter };
