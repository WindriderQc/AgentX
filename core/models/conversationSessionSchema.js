'use strict';

const { Schema } = require('mongoose');

// Embedded in the canonical Conversation collection; no independent store.
module.exports = new Schema({
    sessionId: { type: String, required: true },
    packId: { type: String, required: true },
    modeId: { type: String, required: true },
    scopeId: { type: String, required: true },
    label: { type: String, default: '' },
    persona: { type: Object, default: null },
    inference: { type: Object, default: null },
    voice: { type: Object, default: null },
    visual: { type: Object, default: null },
    agentId: { type: String, default: 'main' },
    backend: { type: String, enum: ['openclaw', 'agentx'], default: null },
    agentSessionKey: { type: String, default: null },
    // Native session keys of the team members addressed directly in this conversation (#41).
    agentSessionKeys: { type: Object, default: undefined },
    // The last direct exchange with a member, given once to the conversation's agent.
    teamExchange: { type: Object, default: undefined },
    llmx: { type: Object, default: null },
    // Historical Household proposal evidence. Retained on import/export only;
    // the current runtime does not execute or resume this retired action field.
    toolAction: { type: Object, default: undefined },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    // Content-free identity retained to reject replay/import after forgetting.
    deletedAt: { type: Date, default: undefined },
    deleteCleanupPending: { type: Boolean, default: undefined },
    turnCount: { type: Number, default: 0 },
    lastTurnAt: { type: Date, default: null }
  }, { _id: false, timestamps: true, minimize: false });
