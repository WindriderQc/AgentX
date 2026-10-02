'use strict';

const { buildAgentOpsProjection } = require('./projection');
const { buildServiceHealth } = require('./health');
const { getOpenClawRuntimeEvidence } = require('../openclaw/runtimeEvidence');

function registerAgentOps({ express, logger, projectionProvider = () => buildAgentOpsProjection({ getOpenClawRuntimeEvidence }) }) {
  const router = express.Router();
  router.get('/service-health', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      return res.json({ status: 'success', data: await buildServiceHealth() });
    } catch (error) {
      logger?.error?.('[agent-ops] service health failed', { error: error.message });
      return res.status(500).json({ status: 'error', message: 'Service health projection failed.' });
    }
  });
  router.get('/', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const data = await projectionProvider();
      return res.json({ status: 'success', data });
    } catch (error) {
      logger?.error?.('[agent-ops] projection failed', { error: error.message });
      return res.status(error.statusCode || 500).json({
        status: 'error',
        code: error.code || 'AGENT_OPS_PROJECTION_FAILED',
        message: error.statusCode === 503
          ? 'Agent Ops requires a valid AgentX ecosystem snapshot.'
          : 'Agent Ops projection failed.'
      });
    }
  });
  return router;
}

module.exports = { registerAgentOps };
