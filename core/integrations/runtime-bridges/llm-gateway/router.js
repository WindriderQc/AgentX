'use strict';

// /api/llm/v1: one OpenAI-compatible door. The bearer token names the client;
// each request is admitted, routed and recorded by Core under that client.
const { handleChat, listModels } = require('./chat');
const { admissionWaitMs, clientForRequest, parseGatewayClients } = require('./clients');
const { chatRequest, responsesRender } = require('./responses');

function openAiError(res, status, message, code) {
  return res.status(status).json({ error: { message, type: 'invalid_request_error', ...(code && { code }) } });
}

function registerLlmGateway({ express, runtimeServices, logger, clients = parseGatewayClients() }) {
  const router = express.Router();
  const withClient = handler => (req, res) => {
    const client = clientForRequest(clients, req);
    if (!client) {
      res.set('WWW-Authenticate', 'Bearer');
      return openAiError(res, 401, 'A valid AgentX gateway token is required.', 'LLM_GATEWAY_TOKEN_INVALID');
    }
    return handler(req, res, client);
  };

  router.get('/v1/models', withClient((_req, res, client) => listModels(res, { runtimeServices, logger, client })));

  router.post('/v1/chat/completions', withClient((req, res, client) => handleChat(req, res, {
    runtimeServices, logger, client, body: req.body || {}, waitMs: admissionWaitMs(client)
  })));

  router.post('/v1/responses', withClient((req, res, client) => {
    let translated;
    try { translated = chatRequest(req.body); }
    catch (error) { return openAiError(res, error.statusCode || 400, error.message, error.code); }
    return handleChat(req, res, {
      runtimeServices, logger, client, body: translated.chat,
      render: responsesRender(translated.names), waitMs: admissionWaitMs(client)
    });
  }));

  router.all('/v1/*', withClient((req, res) => openAiError(res, 404,
    `unsupported AgentX gateway operation: ${req.method} ${req.path}`)));
  return router;
}

module.exports = { registerLlmGateway };
