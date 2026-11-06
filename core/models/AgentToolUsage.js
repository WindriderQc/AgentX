const mongoose = require('mongoose');

/**
 * Daily agent tool calls per bus, tool and caller, so unused tools can be
 * found and removed on evidence. One row per (day, bus, tool, caller); the
 * route increments it after the call. Names only, never arguments or results.
 *
 * TTL: AGENT_TOOL_USAGE_TTL_DAYS (default 400, rows are tiny).
 */
const AGENT_TOOL_BUSES = Object.freeze(['general', 'memory', 'owner']);

const AgentToolUsageSchema = new mongoose.Schema({
  day: { type: Date, required: true },
  bus: { type: String, required: true, enum: AGENT_TOOL_BUSES },
  tool: { type: String, required: true },
  caller: { type: String, required: true },
  calls: { type: Number, default: 0, min: 0 },
  failures: { type: Number, default: 0, min: 0 },
  lastAt: { type: Date, default: null },
}, {
  timestamps: false,
  versionKey: false,
  collection: 'agenttoolusage',
});

const TTL_SECONDS = parseInt(process.env.AGENT_TOOL_USAGE_TTL_DAYS || '400', 10) * 86400;
AgentToolUsageSchema.index({ day: 1 }, { expireAfterSeconds: TTL_SECONDS });
AgentToolUsageSchema.index({ day: 1, bus: 1, tool: 1, caller: 1 }, { unique: true });

const AgentToolUsage = mongoose.model('AgentToolUsage', AgentToolUsageSchema);
AgentToolUsage.AGENT_TOOL_BUSES = AGENT_TOOL_BUSES;

module.exports = AgentToolUsage;
