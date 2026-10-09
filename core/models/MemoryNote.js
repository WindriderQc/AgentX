'use strict';

const mongoose = require('mongoose');
const { MEMORY_SCOPES, SENSITIVITY_LEVELS } = require('../../shared/memoryClassification');

// Reuse the existing selected-note collection. Moving its ownership into Core
// does not copy data, relabel historical notes or create a second memory store.
const schema = new mongoose.Schema({
  packId: { type: String, required: true, index: true },
  scopeId: { type: String, required: true, index: true },
  scope: { type: String, enum: MEMORY_SCOPES },
  sensitivity: { type: String, enum: SENSITIVITY_LEVELS },
  topic: { type: String, default: 'general' },
  text: { type: String, required: true },
  type: { type: String, enum: ['fact', 'summary'], default: 'fact' },
  kind: { type: String, enum: ['fact', 'preference', 'decision'], default: 'fact' },
  source: { type: String, default: 'explicit-ui' },
  sourceTraceId: { type: String, unique: true, sparse: true },
  contentHash: { type: String, default: '', index: true },
  // Meaning index, derived from `text` (memoryNoteIndex.js). Never returned by
  // an ordinary read.
  embedding: { type: [Number], default: undefined, select: false },
  embeddingModel: { type: String, default: null },
  embeddedHash: { type: String, default: null },
  status: { type: String, enum: ['active', 'forgotten'], default: 'active', index: true },
  forgottenAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null }
}, { timestamps: true, collection: 'household_voice_memories' });

module.exports = mongoose.models.MemoryNote || mongoose.model('MemoryNote', schema);
