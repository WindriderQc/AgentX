const mongoose = require('mongoose');

/**
 * The tool names each MCP bus last advertised in a tools/list answer
 * (general, memory, owner), so the usage report lists tools nobody calls.
 * One document per bus, rewritten only when the list changes.
 */
const AgentToolCatalogSchema = new mongoose.Schema({
  _id: { type: String, enum: ['general', 'memory', 'owner'] },
  names: { type: [String], default: [] },
  observedAt: { type: Date, default: null },
}, {
  timestamps: false,
  versionKey: false,
  collection: 'agenttoolcatalog',
});

module.exports = mongoose.model('AgentToolCatalog', AgentToolCatalogSchema);
