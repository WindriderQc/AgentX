'use strict';

// Île tab API (docs/ISLAND.md). Reads, the queue CLI's run reports, and
// "Lancer", which records a heavy-work request and starts nothing.
const express = require('express');
const islands = require('../src/services/island/islandRunService');
const { readLiveWorld } = require('../src/services/island/islandLiveWorld');

const router = express.Router();

function send(res, promise, status = 200) {
  return promise
    .then(data => res.status(status).json({ status: 'success', data }))
    .catch(err => res.status(err.statusCode || 502).json({ status: 'error',
      error: err.statusCode ? err.message : 'The island service could not answer; nothing was started' }));
}

router.get('/runs', (_req, res) => send(res, islands.listRuns()));
router.get('/worlds/:id/live', (req, res) => send(res.set('Cache-Control', 'no-store'), readLiveWorld(req.params.id)));
router.get('/runs/:id', (req, res) => send(res, islands.getRun(req.params.id)));
router.get('/runs/:id/memory', (req, res) => send(res, islands.getMemory(req.params.id)));
router.post('/runs/:id/report', (req, res) => send(res, islands.recordReport(req.params.id, req.body || {})));
router.post('/runs/:id/replay', (req, res) => send(res, islands.openReplay(req.params.id)));
router.post('/launch', (req, res) => send(res, islands.launch(req.body || {}), 201));

module.exports = router;
