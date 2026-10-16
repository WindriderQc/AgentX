'use strict';

// /api/llm/<client>/v1: one OpenAI-compatible door for every declared client.
// Each request is admitted, routed and recorded by Core under the client's id.
const { handleChat, listModels } = require('./chat');
const { admissionWaitMs, authorizeClient, parseGatewayClients } = require('./clients');
const { chatRequest, responsesRender } = require('./responses');

function openAiError(res, status, message, code) {
  return res.status(status).json({ error: { message, type: 'invalid_request_error', ...(code && { code }) } });
}

function registerLlmGateway({ express, runtimeServices, logger, clients = parseGatewayClients() }) {
  const router = express.Router();
  const withClient = handler => (req, res) => {
    const client = clients.get(String(req.params?.client || ''));
    if (!client) return openAiError(res, 404, 'unknown AgentX gateway client', 'LLM_GATEWAY_CLIENT_UNKNOWN');
    const refusal = authorizeClient(client, req);
    if (refusal) return openAiError(res, refusal.status, refusal.message, refusal.code);
    return handler(req, res, client);
  };

  router.get('/:client/v1/models', withClient((_req, res, client) => listModels(res, { runtimeServices, logger, client })));

  router.post('/:client/v1/chat/completions', withClient((req, res, client) => handleChat(req, res, {
    runtimeServices, logger, client, body: req.body || {}, waitMs: admissionWaitMs(client)
  })));

  router.post('/:client/v1/responses', withClient((req, res, client) => {
    let translated;
    try { translated = chatRequest(req.body); }
    catch (error) { return openAiError(res, error.statusCode || 400, error.message, error.code); }
    return handleChat(req, res, {
      runtimeServices, logger, client, body: translated.chat,
      render: responsesRender(translated.names), waitMs: admissionWaitMs(client)
    });
  }));

  router.all('/:client/v1/*', withClient((req, res) => openAiError(res, 404,
    `unsupported AgentX gateway operation: ${req.method} ${req.path}`)));
  return router;
}

module.exports = { registerLlmGateway };
