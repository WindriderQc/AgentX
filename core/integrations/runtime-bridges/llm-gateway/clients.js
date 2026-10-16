'use strict';

// Who may use the OpenAI-compatible gateway. Each client is attested by Core:
// its id becomes the inference caller and the consumer contract that analytics
// group by. Clients never ask for household (interactive) priority, so Nestor's
// conversations keep precedence over them at admission.
const crypto = require('crypto');
const { PATIENT_WAIT_MS } = require('./chat');

const CLIENT_ID = /^[a-z][a-z0-9-]{0,39}$/;
const ADMISSION_MODES = new Set(['patient', 'immediate']);

const HERMES_CLIENT = Object.freeze({
  id: 'hermes',
  label: 'Hermes',
  callerDetail: 'hermes-runtime-bridge',
  consumerContract: 'hermes-runtime-v1',
  admission: 'immediate',
  token: false
});

function invalid(message) {
  return Object.assign(new Error(`AGENTX_LLM_GATEWAY_CLIENTS: ${message}`), { code: 'LLM_GATEWAY_CLIENTS_INVALID' });
}

// AGENTX_LLM_GATEWAY_CLIENTS='{"codex":{"admission":"patient","token":true}}'
function parseGatewayClients(raw = process.env.AGENTX_LLM_GATEWAY_CLIENTS) {
  const clients = new Map([[HERMES_CLIENT.id, HERMES_CLIENT]]);
  const text = String(raw || '').trim();
  if (!text) return clients;
  let declared;
  try { declared = JSON.parse(text); } catch { throw invalid('must be a JSON object'); }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw invalid('must be a JSON object');
  for (const [id, entry] of Object.entries(declared)) {
    if (!CLIENT_ID.test(id)) throw invalid(`client id "${id}" must be lowercase letters, digits and dashes`);
    if (clients.has(id)) throw invalid(`client "${id}" is built in and cannot be redeclared`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid(`client "${id}" must be an object`);
    const unknown = Object.keys(entry).filter(key => !['admission', 'token'].includes(key));
    if (unknown.length) throw invalid(`client "${id}" has unsupported keys: ${unknown.join(', ')}`);
    const admission = entry.admission ?? 'patient';
    if (!ADMISSION_MODES.has(admission)) throw invalid(`client "${id}" admission must be patient or immediate`);
    const token = entry.token ?? false;
    if (typeof token !== 'boolean') throw invalid(`client "${id}" token must be true or false`);
    clients.set(id, Object.freeze({
      id,
      label: `Gateway client ${id}`,
      callerDetail: `llm-gateway/${id}`,
      consumerContract: `${id}-gateway-v1`,
      admission,
      token
    }));
  }
  return clients;
}

function admissionWaitMs(client) {
  return client.admission === 'patient' ? PATIENT_WAIT_MS : 0;
}

function bearer(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || '').trim());
  return match ? match[1].trim() : '';
}

// Secret bearer tokens per client: AGENTX_LLM_GATEWAY_TOKENS='{"codex":"…"}'.
function gatewayTokens(raw = process.env.AGENTX_LLM_GATEWAY_TOKENS) {
  const text = String(raw || '').trim();
  if (!text) return {};
  let tokens;
  try { tokens = JSON.parse(text); } catch { tokens = null; }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)
    || Object.values(tokens).some(value => typeof value !== 'string')) {
    throw Object.assign(new Error('AGENTX_LLM_GATEWAY_TOKENS must be a JSON object of client tokens'), { code: 'LLM_GATEWAY_CLIENTS_INVALID' });
  }
  return tokens;
}

// A client with a token is refused unless the request presents it. A declared
// token that is missing or unreadable fails closed instead of opening the door.
function authorizeClient(client, req, env = process.env) {
  if (!client.token) return null;
  let tokens;
  try { tokens = gatewayTokens(env.AGENTX_LLM_GATEWAY_TOKENS); } catch { tokens = {}; }
  const expected = Buffer.from(String(tokens[client.id] || ''));
  if (expected.length === 0) {
    return { status: 503, code: 'LLM_GATEWAY_TOKEN_UNCONFIGURED', message: `The gateway token for client ${client.id} is not configured.` };
  }
  const presented = Buffer.from(bearer(req));
  const valid = presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
  return valid ? null : { status: 401, code: 'LLM_GATEWAY_TOKEN_INVALID', message: 'A valid bearer token is required for this gateway client.' };
}

module.exports = { HERMES_CLIENT, admissionWaitMs, authorizeClient, gatewayTokens, parseGatewayClients };
