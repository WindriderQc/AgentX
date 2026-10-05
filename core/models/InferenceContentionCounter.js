const mongoose = require('mongoose');

/**
 * Hourly contention counters that survive a Core restart (#363).
 *
 * The in-process ladder and host-gate statistics reset at every start, and a
 * call refused before dispatch writes no inferencelogs row. Each event below
 * increments one bucket (hour, event, taskType, code) atomically, so several
 * Core processes may count into the same bucket. Codes and task types only.
 *
 * TTL: the inference log retention (INFERENCE_LOG_TTL_DAYS, default 30).
 */
const CONTENTION_EVENTS = Object.freeze([
  'ladder_served', // a fallback ladder rung served a task; code = degradation reason
  'ladder_exhausted', // the primary was unavailable and no rung could serve; code = reason
  'route_refused', // /api/inference/generate refused at selection or admission; code = refusal code
]);

const InferenceContentionCounterSchema = new mongoose.Schema({
  hour: { type: Date, required: true },
  event: { type: String, required: true, enum: CONTENTION_EVENTS },
  taskType: { type: String, default: null },
  code: { type: String, default: null },
  count: { type: Number, default: 0, min: 0 },
  lastAt: { type: Date, default: null },
}, {
  timestamps: false,
  versionKey: false,
  collection: 'inferencecontentioncounters'
});

const TTL_SECONDS = parseInt(process.env.INFERENCE_LOG_TTL_DAYS || '30', 10) * 86400;
InferenceContentionCounterSchema.index({ hour: 1 }, { expireAfterSeconds: TTL_SECONDS });
InferenceContentionCounterSchema.index({ hour: 1, event: 1, taskType: 1, code: 1 }, { unique: true });

const InferenceContentionCounter = mongoose.model('InferenceContentionCounter', InferenceContentionCounterSchema);
InferenceContentionCounter.CONTENTION_EVENTS = CONTENTION_EVENTS;

module.exports = InferenceContentionCounter;
