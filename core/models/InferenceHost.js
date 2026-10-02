'use strict';

const mongoose = require('mongoose');

// One Ollama endpoint the operator registered. A machine may run several
// endpoints (a GPU instance and a CPU instance); each is its own host.
const InferenceHostSchema = new mongoose.Schema({
  hostId: { type: String, required: true, unique: true, trim: true, match: /^[a-z0-9][a-z0-9-]{0,31}$/ },
  name: { type: String, default: '', trim: true, maxlength: 64 },
  url: { type: String, required: true, unique: true, trim: true },
  residency: { type: String, enum: ['gpu', 'cpu'], default: 'gpu' },
  // Requests Core lets this endpoint serve at once per model; null keeps the
  // global gate limit. A CPU instance usually serves one agent at a time.
  maxInflight: { type: Number, default: null, min: 1, max: 16 },
  vramMb: { type: Number, default: 0, min: 0 },
  priority: { type: Number, default: 0, min: 0 }
}, {
  collection: 'inference_hosts',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

module.exports = mongoose.models.InferenceHost || mongoose.model('InferenceHost', InferenceHostSchema);
