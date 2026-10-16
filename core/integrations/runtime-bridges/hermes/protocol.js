'use strict';

// Hermes's historical OpenAI door. It is the gateway's built-in `hermes`
// client (see ../llm-gateway) plus the patient alias and the vision route.
const { registerHermesVision } = require('./vision');
const {
  OllamaToOpenAiSse,
  PATIENT_WAIT_MS,
  approvedModels,
  handleChat,
  listModels,
  openAiCompletion,
  openAiToolCalls,
  requireApprovedModel,
  whenAdmitted
} = require('../llm-gateway/chat');
const { HERMES_CLIENT } = require('../llm-gateway/clients');

const HERMES_CONSUMER_CONTRACT = HERMES_CLIENT.consumerContract;

function registerHermesProtocol({ express, runtimeServices, logger }) {
  const router = express.Router();
  registerHermesVision(router, { runtimeServices, logger });

  router.post('/patient/v1/chat/completions', (req, _res, next) => {
    req.admissionWaitMs = PATIENT_WAIT_MS;
    req.url = '/v1/chat/completions';
    next();
  });

  router.get('/v1/models', (_req, res) => listModels(res, { runtimeServices, logger, client: HERMES_CLIENT }));

  router.post('/v1/chat/completions', (req, res) => handleChat(req, res, {
    runtimeServices, logger, client: HERMES_CLIENT, body: req.body || {}, waitMs: req.admissionWaitMs
  }));

  router.all('/v1/*', (req, res) => res.status(404).json({
    error: {
      message: `unsupported AgentX Hermes operation: ${req.method} ${req.path}`,
      type: 'invalid_request_error'
    }
  }));
  return router;
}

module.exports = {
  HERMES_CONSUMER_CONTRACT,
  OllamaToOpenAiSse,
  approvedModels,
  openAiCompletion,
  openAiToolCalls,
  registerHermesProtocol,
  whenAdmitted,
  requireApprovedModel
};
