'use strict';

const { Schema } = require('mongoose');

// Embedded in the canonical Conversation collection; no independent store.
module.exports = new Schema({
    traceId: { type: String, required: true },
    sessionId: { type: String, required: true },
    packId: { type: String, required: true },
    modeId: String,
    scopeId: { type: String },
    channel: { type: String, enum: ['text', 'voice'], default: 'text' },
    textRetention: { type: String, enum: ['full', 'preview-only'], default: 'full' },
    clientTurnId: String,
    origin: { type: String, default: 'human' },
    outcome: { type: String, default: 'not_recorded' },
    applicationEvent: { type: Object, default: null },
    // LLMx keeps the bounded proposal and its browser receipt on the same turn.
    sceneProposal: { type: Object, default: null },
    sceneReceipt: { type: Object, default: null },
    sceneProposedReplyText: { type: String, default: '' },
    // Blocks shown on screen, never spoken (#167). Secrets are stored redacted.
    display: { type: [Object], default: undefined },
    interrupted: { type: Boolean, default: false },
    interruptionState: { type: String, enum: ['', 'confirmed', 'failed'], default: '' },
    // A spoken turn's browser timeline: ms from the end of the person's speech.
    voiceTimings: { type: Object, default: undefined },
    // Where the turn's server time went (prepared, executed, native run steps), in ms.
    serverTimings: { type: Object, default: undefined },
    inputPreview: String,
    replyPreview: String,
    inputSha256: String,
    replySha256: String,
    safetyFlags: { type: [String], default: [] },
    parentAttention: { type: Boolean, default: false },
    // Which catalog clip the surface was told to play, so the parent journal
    // shows what the child actually heard, not only what was said.
    soundId: { type: String, default: '' },
    model: String,
    hostKey: String,
    routingSource: String,
    routeTier: { type: String, enum: ['deterministic', 'router', 'primary', 'backup', 'agent'], default: 'deterministic' },
    fallbackUsed: { type: Boolean, default: false },
    fallbackReason: { type: String, default: '' },
    knowledgeStatus: String,
    knowledgeSourceCount: { type: Number, default: 0 },
    knowledgeCorpusFingerprint: String,
    personalContinuity: { type: Object, default: null },
    toolEvidence: { type: Object, default: null },
    // The team member who answered when the turn addressed one directly (#41).
    speakerAgentId: { type: String, default: '' },
    speaker: { type: new Schema({
      agentId: String, personaId: { type: String, default: null },
      personaVersion: { type: Number, default: null }, name: String
    }, { _id: false }), default: undefined },
    performedBy: { type: [new Schema({
      agentId: String, runId: { type: String, default: null }
    }, { _id: false })], default: undefined },
    // Requested synthesis, not proof of playback or of a client fallback.
    voice: { type: new Schema({ provider: String, voice: String }, { _id: false }), default: undefined },
    durationMs: Number,
    source: { type: String, default: 'household-persona' },
    sourceTurnId: { type: String, default: '' },
    sequence: { type: Number, default: 0 },
    persona: { type: String, default: '' },
    memoryState: {
      type: String,
      enum: ['not_applicable', 'captured', 'processing', 'processed', 'failed'],
      default: 'not_applicable',
      index: true
    },
    memoryAttempts: { type: Number, default: 0 },
    memoryNextAttemptAt: { type: Date, default: null },
    memoryExplicit: { type: Boolean, default: false },
    sourceCompletedAt: { type: Date, default: null },
    memoryClaimedAt: { type: Date, default: null },
    memoryProcessedAt: { type: Date, default: null },
    memoryError: { type: String, default: '' },
    memoryIds: { type: [String], default: [] }
  }, { _id: false, timestamps: true, minimize: false });
