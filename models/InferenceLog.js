const mongoose = require('mongoose');

/**
 * InferenceLog — records every Ollama inference call across all hosts.
 * Written fire-and-forget from modelRouter.recordInference().
 * TTL: 30 days by default (configurable via INFERENCE_LOG_TTL_DAYS env).
 */
const InferenceLogSchema = new mongoose.Schema({
  // Routing
  host: { type: String, required: true },          // full URL e.g. http://192.168.2.99:11434
  hostKey: { type: String, default: null },         // 'primary' | 'secondary' | 'tertiary'
  model: { type: String, required: true },

  // Caller identity
  caller: {
    type: String,
    enum: ['chat', 'benchmark', 'roundtable', 'automation', 'embedding', 'classification', 'unknown'],
    default: 'unknown'
  },
  callerDetail: { type: String, default: null },    // agent ID, task ID, cron job name, etc.

  // Task context
  taskType: { type: String, default: null },        // from TASK_MODELS or custom
  routed: { type: Boolean, default: false },        // whether auto-routing was used
  fallbackUsed: { type: Boolean, default: false },
  fallbackReason: { type: String, default: null },

  // Performance
  tokensIn: { type: Number, default: 0 },
  tokensOut: { type: Number, default: 0 },
  durationMs: { type: Number, default: 0 },

  // Status
  status: {
    type: String,
    enum: ['success', 'error', 'timeout'],
    default: 'success'
  },
  error: { type: String, default: null },

  timestamp: { type: Date, default: Date.now, index: true }
}, {
  timestamps: false,
  collection: 'inferencelogs'
});

// TTL index — expires documents after N days (fallback to 30, minimum 1)
const ttlDaysRaw = process.env.INFERENCE_LOG_TTL_DAYS;
let ttlDays = parseInt(ttlDaysRaw, 10);
if (!Number.isFinite(ttlDays) || ttlDays < 1) {
  ttlDays = 30;
}
const TTL_SECONDS = ttlDays * 86400;
InferenceLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: TTL_SECONDS });

// Query indexes
InferenceLogSchema.index({ host: 1, timestamp: -1 });
InferenceLogSchema.index({ model: 1, timestamp: -1 });
InferenceLogSchema.index({ caller: 1, timestamp: -1 });
InferenceLogSchema.index({ status: 1, timestamp: -1 });

module.exports = mongoose.model('InferenceLog', InferenceLogSchema);
