'use strict';

const { buildAgentOpsProjection } = require('./projection');
const { buildServiceHealth } = require('./health');
const { getOpenClawRuntimeEvidence } = require('../openclaw/runtimeEvidence');
const { teamView } = require('./team');

// The roster is still served when the persona catalog cannot be read: the page
// then says the presentation is unavailable instead of losing the agents.
async function withTeam(projection, personaProvider, logger) {
  if (!personaProvider) return teamView(projection, [], { issue: 'No persona catalog is connected.' });
  try {
    return teamView(projection, await personaProvider());
  } catch (error) {
    logger?.warn?.('[agent-ops] persona catalog unavailable', { error: error.message });
    return teamView(projection, [], { issue: 'The persona catalog could not be read.' });
  }
}

function registerAgentOps({ express, logger, personaProvider, projectionProvider = () => buildAgentOpsProjection({ getOpenClawRuntimeEvidence }) }) {
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
      const data = await withTeam(await projectionProvider(), personaProvider, logger);
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
