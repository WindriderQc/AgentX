'use strict';

// A configured native agent may choose a cloud provider after accepting the
// request. Protect the whole household turn, including its unclassified text,
// retained native session, local source results and attachments.
function protectedSourcesLocalOnly(env = process.env) {
  return env.HOUSEHOLD_PROTECTED_SOURCES_LOCAL_ONLY === 'true';
}

function requireProtectedBackend(backend, env) {
  if (!protectedSourcesLocalOnly(env) || backend === 'agentx') return;
  throw Object.assign(new Error('Cette conversation contient des sources privées. Pour continuer localement, ouvrez une nouvelle conversation avec AgentX / Ollama.'), {
    code: 'HOUSEHOLD_PROTECTED_SOURCES_LOCAL_ONLY', statusCode: 409
  });
}

// This marker is set only by the guarded browser turn handler after it verifies
// a human text/voice turn. JSON clients and background workers cannot set it.
const householdUserText = Symbol('householdUserText');

function nativeInputOnly(backend, env = process.env) {
  return env.HOUSEHOLD_NATIVE_EXPLICIT_INPUT_ONLY === 'true' && ['hermes', 'openclaw'].includes(backend);
}

function sourceTransferError() {
  return Object.assign(new Error('Ce moteur reçoit uniquement le texte saisi ou dicté. Ouvrez une conversation AgentX / Ollama pour utiliser une pièce jointe ou une source privée.'), {
    code: 'HOUSEHOLD_NATIVE_SOURCE_TRANSFER_BLOCKED', statusCode: 409
  });
}

function nativeUserText(request) {
  const text = request[householdUserText];
  if (typeof text !== 'string' || !text.trim() || text !== request.text ||
      request.attachments?.length || request.applicationEvent || request.channel && !['text', 'voice'].includes(request.channel)) throw sourceTransferError();
  return text;
}

function directHermesBody(text) {
  return { input: [{ role: 'user', content: text }], instructions: '' };
}

module.exports = { protectedSourcesLocalOnly, requireProtectedBackend, nativeInputOnly, sourceTransferError, householdUserText, nativeUserText, directHermesBody };
