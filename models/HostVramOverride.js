/**
 * HostVramOverride Model
 * Persists UI-set VRAM overrides per Ollama host.
 * Used as highest-priority fallback when SSH-based VRAM detection fails.
 */

const mongoose = require('mongoose');

const HostVramOverrideSchema = new mongoose.Schema({
  hostIp: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  vramMiB: {
    type: Number,
    required: true,
    min: 0
  },
  updatedBy: {
    type: String,
    default: 'ui'
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('HostVramOverride', HostVramOverrideSchema);
