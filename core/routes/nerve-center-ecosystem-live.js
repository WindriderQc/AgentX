'use strict';

const express = require('express');
const { createLiveState, loadConfig } = require('../src/services/ecosystemLiveState');

module.exports = function createRouter(options = {}) {
  const router = express.Router();
  const read = createLiveState({
    // Lazy use avoids a second collector and lets the existing Nerve Center
    // finish loading before this route reads its shared snapshot capability.
    buildSnapshot: options.buildSnapshot || (() => require('./nerve-center').buildEcosystemSnapshot()),
    config: options.config || loadConfig,
    composition: options.composition || (() => require('../src/services/ecosystemComposition').compositionView({
      reader: options.reader || require('../src/services/presentationReadService').presentationReader })),
    reader: options.reader || require('../src/services/presentationReadService').presentationReader,
    ...(options.now && { now: options.now })
  });
  router.get('/ecosystem/live', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (Object.keys(req.query).length) return res.status(400).json({ status: 'error', code: 'INVALID_ECOSYSTEM_LIVE_QUERY' });
    try { return res.json({ status: 'success', data: await read() }); }
    catch (error) {
      return res.status(503).json({ status: 'error', code: error.code || 'ECOSYSTEM_LIVE_UNAVAILABLE',
        message: 'Ecosystem live state is unavailable.' });
    }
  });
  return router;
};
