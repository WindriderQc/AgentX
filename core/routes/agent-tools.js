'use strict';

/**
 * GET /api/agent-tools/usage?days=30
 *   Every tool the MCP buses advertise, least used first: calls, errors, last
 *   call, days used and callers. Feeds the owner's tool removal standard.
 */

const express = require('express');
const { readToolUsage } = require('../src/services/agentToolUsage');

function createAgentToolsRouter(options = {}) {
  const router = express.Router();
  router.get('/usage', async (req, res, next) => {
    try {
      const days = Math.min(400, Math.max(1, parseInt(req.query.days, 10) || 30));
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, data: await (options.read || readToolUsage)({ days }) });
    } catch (error) { return next(error); }
  });
  return router;
}

function mount(app) {
  app.use('/api/agent-tools', createAgentToolsRouter());
}

module.exports = { createAgentToolsRouter, mount };
