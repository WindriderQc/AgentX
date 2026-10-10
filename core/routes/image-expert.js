'use strict';
const express = require('express');
const { createService } = require('../src/services/images/expertService');
function createRouter(service = createService()) {
  const router = express.Router();
  router.use(express.json({ limit: '512kb' }));
  const wrap = handler => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { await handler(req, res); }
    catch (error) { res.status(error.statusCode || 503).json({ ok: false,
      message: error.statusCode ? error.message : 'Le spécialiste imageX est indisponible.' }); }
  };
  router.get('/status', wrap(async (_req, res) => res.json({ ok: true, ...await service.status() })));
  router.get('/resources/:id', wrap(async (req, res) => res.json({ ok: true, resource: await service.resource(req.params.id) })));
  router.get('/sessions', wrap(async (_req, res) => res.json({ ok: true, sessions: await service.sessions() })));
  router.post('/sessions', wrap(async (_req, res) => res.status(201).json({ ok: true, session: await service.createSession() })));
  router.get('/sessions/:id/turns', wrap(async (req, res) => res.json({ ok: true, turns: await service.turns(req.params.id) })));
  router.post('/sessions/:id/turns', wrap(async (req, res) => res.status(202).json({ ok: true, turn: await service.accept(req.params.id, req.body) })));
  router.post('/sessions/:id/turns/:turnId/cancel', wrap(async (req, res) => res.json({ ok: true, ...await service.cancel(req.params.id, req.params.turnId) })));
  return router;
}
module.exports = { createRouter };
