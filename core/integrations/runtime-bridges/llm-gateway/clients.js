'use strict';

// Who may use the OpenAI-compatible gateway. A client is known by its bearer
// token alone: Core attests its id as the inference caller and the consumer
// contract that analytics group by. Clients never ask for household
// (interactive) priority, so Nestor's conversations keep precedence.
const crypto = require('crypto');
const { PATIENT_WAIT_MS } = require('./chat');

const CLIENT_ID = /^[a-z][a-z0-9-]{0,39}$/;
const ADMISSION_MODES = new Set(['patient', 'immediate']);
const MIN_TOKEN_LENGTH = 16;

// Hermes keeps its own address (/api/hermes-openai) and is not a token client.
const HERMES_CLIENT = Object.freeze({
  id: 'hermes',
  label: 'Hermes',
  callerDetail: 'hermes-runtime-bridge',
  consumerContract: 'hermes-runtime-v1',
  admission: 'immediate'
});

function invalid(message) {
  return Object.assign(new Error(`AGENTX_LLM_GATEWAY_CLIENTS: ${message}`), { code: 'LLM_GATEWAY_CLIENTS_INVALID' });
}

// Secret. AGENTX_LLM_GATEWAY_CLIENTS='{"codex-windows":{"token":"…","admission":"patient"},"script":"…"}'
// A string entry is the token with the default patient admission.
function parseGatewayClients(raw = process.env.AGENTX_LLM_GATEWAY_CLIENTS) {
  const text = String(raw || '').trim();
  if (!text) return [];
  let declared;
  try { declared = JSON.parse(text); } catch { throw invalid('must be a JSON object'); }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw invalid('must be a JSON object');
  const tokens = new Set();
  return Object.entries(declared).map(([id, value]) => {
    if (!CLIENT_ID.test(id)) throw invalid(`client id "${id}" must be lowercase letters, digits and dashes`);
    if (id === HERMES_CLIENT.id) throw invalid('hermes is built in and keeps /api/hermes-openai');
    const entry = typeof value === 'string' ? { token: value } : value;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid(`client "${id}" must be a token or an object`);
    const unknown = Object.keys(entry).filter(key => !['admission', 'token'].includes(key));
    if (unknown.length) throw invalid(`client "${id}" has unsupported keys: ${unknown.join(', ')}`);
    const admission = entry.admission ?? 'patient';
    if (!ADMISSION_MODES.has(admission)) throw invalid(`client "${id}" admission must be patient or immediate`);
    const token = typeof entry.token === 'string' ? entry.token.trim() : '';
    if (token.length < MIN_TOKEN_LENGTH) throw invalid(`client "${id}" needs a token of at least ${MIN_TOKEN_LENGTH} characters`);
    if (tokens.has(token)) throw invalid(`client "${id}" reuses another client's token`);
    tokens.add(token);
    return Object.freeze({
      id,
      label: `Gateway client ${id}`,
      callerDetail: `llm-gateway/${id}`,
      consumerContract: `${id}-gateway-v1`,
      admission,
      token: Buffer.from(token)
    });
  });
}

function admissionWaitMs(client) {
  return client.admission === 'patient' ? PATIENT_WAIT_MS : 0;
}

function bearer(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || '').trim());
  return Buffer.from(match ? match[1].trim() : '');
}

// The client whose token the request presents, or null. Every token is
// compared so the answer time does not depend on which one matches.
function clientForRequest(clients, req) {
  const presented = bearer(req);
  let found = null;
  for (const client of clients) {
    const same = presented.length === client.token.length && crypto.timingSafeEqual(presented, client.token);
    if (same) found = client;
  }
  return found;
}

module.exports = { HERMES_CLIENT, admissionWaitMs, clientForRequest, parseGatewayClients };
