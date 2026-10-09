'use strict';

const { createHash } = require('node:crypto');
const ORIGINS = new Set(['owner_turn', 'ingested_content', 'scheduled', 'delegated', 'unknown']);
const reference = value => typeof value === 'string' && value.length
  ? createHash('sha256').update(value).digest('hex').slice(0, 24) : null;

// Trusted adapters supply these observations. This contract grants no action
// authority and makes no claim about which prompt text caused the tool call.
function agentActionProvenance({ origin, agentId, sessionKey, runId, toolCallId } = {}) {
  return Object.freeze({
    schema: 'agentx.action-provenance/v1',
    origin: ORIGINS.has(origin) ? origin : 'unknown',
    scope: 'session',
    agentId: typeof agentId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(agentId) ? agentId : null,
    sessionRef: reference(sessionKey),
    runRef: reference(runId),
    toolCallRef: reference(toolCallId),
    authority: 'none',
  });
}

const isBackgroundAction = provenance => ['ingested_content', 'scheduled'].includes(provenance?.origin);

module.exports = { agentActionProvenance, isBackgroundAction };
