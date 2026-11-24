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

module.exports = { protectedSourcesLocalOnly, requireProtectedBackend };
