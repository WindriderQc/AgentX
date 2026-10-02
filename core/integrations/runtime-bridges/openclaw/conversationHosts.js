'use strict';

// Operator-declared conversation models served by one inference host, e.g.
// OPENCLAW_CONVERSATION_HOSTS="gemma4:12b-it-qat=http://ollama-b:11434".
// The target carries no num_ctx: Core applies that host's pinned context and
// keep-alive, so a conversation never reloads or displaces the pinned model.
function parseConversationHosts(value) {
  const targets = new Map();
  for (const entry of String(value || '').split(',').map(item => item.trim()).filter(Boolean)) {
    const separator = entry.lastIndexOf('=');
    const model = entry.slice(0, separator).trim();
    const hostUrl = entry.slice(separator + 1).trim().replace(/\/+$/, '');
    if (separator <= 0 || !model || !/^https?:\/\/[^\s/@?#]+$/.test(hostUrl)) {
      throw new Error(`OPENCLAW_CONVERSATION_HOSTS entry "${entry}" must be model=http(s)://host:port`);
    }
    targets.set(model, Object.freeze({ model, hostUrl, exclusiveHost: false }));
  }
  return targets;
}

function createConversationHostResolver(value) {
  const targets = parseConversationHosts(value);
  return model => targets.get(model) || null;
}

module.exports = { createConversationHostResolver, parseConversationHosts };
