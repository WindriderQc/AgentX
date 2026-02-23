/**
 * Roundtable Model
 * Multi-agent roundtable discussion with panel agents, rebuttals, and synthesis
 */

const mongoose = require('mongoose');

const AgentTurnSchema = new mongoose.Schema({
  agentId: { type: String, required: true },
  role: { type: String, required: true },
  round: { type: Number, required: true },
  model: { type: String, required: true },
  target: { type: String, default: null },
  hostName: { type: String, default: null },
  response: { type: String, default: '' },
  thinking: { type: String, default: null },
  error: { type: String, default: null },
  stats: {
    tokensPerSecond: { type: Number, default: null },
    latencyMs: { type: Number, default: null },
    promptTokens: { type: Number, default: null },
    completionTokens: { type: Number, default: null }
  },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null }
}, { _id: false });

const PanelAgentConfigSchema = new mongoose.Schema({
  agentId: { type: String, required: true },
  role: { type: String, required: true },
  model: { type: String, required: true },
  systemPrompt: { type: String, required: true },
  resolvedTarget: { type: String, default: null },
  resolvedHostName: { type: String, default: null }
}, { _id: false });

const SynthesizerConfigSchema = new mongoose.Schema({
  model: { type: String, required: true },
  systemPrompt: { type: String, required: true },
  resolvedTarget: { type: String, default: null },
  resolvedHostName: { type: String, default: null }
}, { _id: false });

const RoundtableSchema = new mongoose.Schema({
  question: {
    type: String,
    required: true,
    maxlength: 5000
  },
  status: {
    type: String,
    enum: ['pending', 'running', 'completed', 'failed', 'timeout'],
    default: 'pending',
    index: true
  },
  rounds: {
    type: Number,
    default: 2,
    min: 1,
    max: 3
  },
  panelConfig: [PanelAgentConfigSchema],
  synthesizerConfig: SynthesizerConfigSchema,
  turns: [AgentTurnSchema],
  synthesis: {
    model: { type: String, default: null },
    target: { type: String, default: null },
    hostName: { type: String, default: null },
    response: { type: String, default: '' },
    thinking: { type: String, default: null },
    error: { type: String, default: null },
    stats: {
      tokensPerSecond: { type: Number, default: null },
      latencyMs: { type: Number, default: null },
      promptTokens: { type: Number, default: null },
      completionTokens: { type: Number, default: null }
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null }
  },
  totalDurationMs: { type: Number, default: null },
  error: { type: String, default: null },

  // Context
  workspaceId: { type: String, default: null },
  userId: { type: String, default: null },
  source: { type: String, default: 'api' },
  tags: { type: [String], default: [] },

  completedAt: { type: Date, default: null }
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

// Indexes
RoundtableSchema.index({ createdAt: -1 });
RoundtableSchema.index({ workspaceId: 1, createdAt: -1 });

// Virtuals
RoundtableSchema.virtual('turnsCount').get(function () {
  return this.turns ? this.turns.length : 0;
});

RoundtableSchema.set('toJSON', { virtuals: true });
RoundtableSchema.set('toObject', { virtuals: true });

// Statics
RoundtableSchema.statics.getRecent = function (limit = 20) {
  return this.find().sort({ createdAt: -1 }).limit(limit);
};

RoundtableSchema.statics.getActive = function () {
  return this.find({ status: { $in: ['pending', 'running'] } }).sort({ createdAt: -1 });
};

module.exports = mongoose.model('Roundtable', RoundtableSchema);
