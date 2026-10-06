const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  role: { type: String, required: true }, // 'user', 'assistant', 'system'
  // A cancelled/failed surface attempt can retain evidence without reply text.
  content: { type: String, required: function() { return !this.turn; } },
  turnId: { type: String, default: undefined },
  attachments: { type: [require('./attachmentReferenceSchema')], default: undefined },
  turn: { type: require('./conversationAuditSchema'), default: undefined },
  timestamp: { type: Date, default: Date.now },
  feedback: {
    rating: { type: Number, enum: [1, -1, 0], default: 0 }, // 1: thumbs up, -1: thumbs down
    comment: String
  },
  // V4: Detailed Stats for Analytics & UI
  stats: {
    usage: {
      promptTokens: { type: Number },
      completionTokens: { type: Number },
      totalTokens: { type: Number }
    },
    performance: {
      totalDuration: { type: Number }, // nanoseconds
      loadDuration: { type: Number },  // nanoseconds
      evalDuration: { type: Number },  // nanoseconds
      tokensPerSecond: { type: Number }
    },
    parameters: mongoose.Schema.Types.Mixed, // Snapshot of options used (temp, top_k, etc)
    meta: mongoose.Schema.Types.Mixed      // Additional metadata (model name, etc)
  },
  metadata: mongoose.Schema.Types.Mixed,
  // V5: Cost Tracking
  cost: {
    promptTokenCost: { type: Number, default: 0 },
    completionTokenCost: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    pricingSource: {
      provider: String,
      modelName: String,
      promptCostPer1M: Number,
      completionCostPer1M: Number,
      source: { type: String, enum: ['environment', 'database', 'default', 'unconfigured', 'openclaw'] }
    },
    calculatedAt: Date
  },

  // V6: RAG Citation Tracking (2026-01-07)
  ragSources: [{
    chunkId: { type: String }, // Changed from ObjectId to String to support Qdrant/UUIDs
    score: { type: Number },  // Relevance score (0-1)
    excerpt: { type: String }, // First 200 chars of chunk for preview
    metadata: {
      filename: String,
      source: String,
      tags: [String],
      timestamp: Date,
      pageNumber: Number,
      section: String
    },
    // Contextual Compression Fields
    wasCompressed: { type: Boolean, default: false },
    compressionRatio: { type: Number, default: 0 }
  }]
}, { minimize: false });

const ConversationSchema = new mongoose.Schema({
  userId: { type: String, default: 'default' },
  surface: { type: String, default: undefined },
  surfaceSession: { type: require('./conversationSessionSchema'), default: undefined },
  sessionRecap: { type: require('./conversationRecapSchema'), default: undefined },

  model: String,
  systemPrompt: String,
  messages: [MessageSchema],
  title: { type: String, default: 'New Conversation' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },

  // V3: RAG support
  // ragRequested: user/client requested RAG (toggle on) even if retrieval returned no sources.
  ragRequested: { type: Boolean, default: false },
  ragUsed: { type: Boolean, default: false },

  // V8: Token Usage & Cost Tracking (2026-01-08)
  usage: {
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    estimatedCost: { type: Number, default: 0 }  // USD
  },

  // NEW: Track last usage update
  lastUsageUpdate: { type: Date, default: Date.now },
  ragSources: [{
    text: String,        // Truncated chunk preview (first 200 chars)
    score: Number,       // Similarity score
    source: String,      // Document source
    title: String,       // Document title
    documentId: String   // Reference to document
  }],

  // V4: Prompt versioning for analytics & improvement loops
  promptConfigId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromptConfig' },
  promptName: { type: String },     // Snapshot: e.g. "default_chat"
  promptVersion: { type: Number },  // Snapshot: e.g. 5

  // Core-owned conversation lifecycle. Legacy documents without this object
  // are treated as active by the lifecycle service.
  lifecycle: {
    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active'
    },
    archivedAt: { type: Date, default: null }
  },

  // Product-owned conversation origin. External callers use the bounded API.
  source: {
    type: String,
    enum: ['agentx', 'external'],
    default: 'agentx',
    index: true
  },
  clientRef: { type: String, default: undefined, maxlength: 160 },
  // Playground turn that created this conversation. With the unique index
  // below, concurrent copies of a first turn cannot create two conversations.
  clientTurnId: { type: String, default: undefined, maxlength: 160 },

  // V5: Total conversation cost (sum of all message costs)
  totalCost: {
    sum: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    breakdown: {
      promptTokens: { type: Number, default: 0 },
      completionTokens: { type: Number, default: 0 },
      embeddingTokens: { type: Number, default: 0 }
    },
    lastUpdated: Date
  },

  // V7: Search & Tagging (2026-01-08)
  tags: [{ type: String, index: true }],

  // Phase 3 Week 11: Conversation Quality Judging
  quality_assessment: {
    overall_score: { type: Number, min: 0, max: 100 },
    dimensions: {
      accuracy: { type: Number, min: 0, max: 10 },       // Factual correctness
      relevance: { type: Number, min: 0, max: 10 },      // On-topic responses
      coherence: { type: Number, min: 0, max: 10 },      // Logical flow across turns
      helpfulness: { type: Number, min: 0, max: 10 },    // Achieved user's goal?
      engagement: { type: Number, min: 0, max: 10 },     // Natural conversation?
      context_retention: { type: Number, min: 0, max: 10 }, // Remembered previous turns?
      instruction_following: { type: Number, min: 0, max: 10 }, // Followed user requests?
      response_quality: { type: Number, min: 0, max: 10 }, // Individual response quality
      efficiency: { type: Number, min: 0, max: 10 },     // Concise vs. verbose?
      safety: { type: Number, min: 0, max: 10 }          // Appropriate content?
    },
    judge_model: String,
    judged_at: Date,
    explanation: String,  // Brief summary from judge
    human_rating: { type: Number, min: -1, max: 1, default: 0 }, // User's thumbs up/down
    disagreement: Number, // |judge - human|
    conversation_length: Number, // # of turns
    avg_latency_ms: Number
  }
}, { minimize: false });

// Indexes for V4 analytics queries
ConversationSchema.index({ createdAt: 1 });
ConversationSchema.index({ userId: 1, clientRef: 1 }, {
  name: 'surface_source_unique', unique: true,
  partialFilterExpression: { surface: { $type: 'string' }, clientRef: { $type: 'string' } }
});
ConversationSchema.index({ userId: 1, clientTurnId: 1 }, {
  name: 'playground_first_turn_unique', unique: true,
  partialFilterExpression: { clientTurnId: { $type: 'string' } }
});
ConversationSchema.index({ surface: 1, 'surfaceSession.sessionId': 1 }, {
  unique: true, partialFilterExpression: { 'surfaceSession.sessionId': { $type: 'string' } }
});
// Both members of a surface turn already carry turnId. Indexing the optional
// assistant-only receipt also indexed each user message as null, making separate
// conversations collide. PsyX/plain chat do not use surfaceSession pairs.
ConversationSchema.index({ surface: 1, 'messages.turnId': 1 }, {
  name: 'surface_turn_identity_unique', unique: true,
  partialFilterExpression: { 'surfaceSession.sessionId': { $type: 'string' }, 'messages.turnId': { $type: 'string' } }
});
ConversationSchema.index({ surface: 1, 'surfaceSession.packId': 1, 'surfaceSession.scopeId': 1,
  'surfaceSession.lastTurnAt': -1 });
ConversationSchema.index({ surface: 1, 'messages.turn.source': 1, 'messages.turn.memoryState': 1 });
ConversationSchema.index({ model: 1, createdAt: 1 });
ConversationSchema.index({ promptConfigId: 1 });

// Primary history paging index (routes/history.js -> find({ userId }).sort({ updatedAt: -1 }))
ConversationSchema.index({ userId: 1, updatedAt: -1 });
ConversationSchema.index({ userId: 1, promptName: 1, 'lifecycle.status': 1, updatedAt: -1 });

ConversationSchema.index({ promptName: 1, promptVersion: 1 });
ConversationSchema.index({ ragRequested: 1 });
ConversationSchema.index({ ragUsed: 1 });
ConversationSchema.index({ 'messages.feedback.rating': 1 });

// V5: Indexes for cost tracking analytics
ConversationSchema.index({ 'totalCost.sum': 1 });
ConversationSchema.index({ model: 1, 'totalCost.sum': 1 });

// V7: Search indexes (2026-01-08)
// Text index for full-text search across title and message content
ConversationSchema.index({
  title: 'text',
  'messages.content': 'text'
}, {
  weights: {
    title: 10,              // Title matches are more relevant
    'messages.content': 5   // Message content is important
  },
  name: 'conversation_text_search'
});

ConversationSchema.methods.updateUsage = function() {
  const { getTokenCounter } = require('../src/services/tokenCounter');
  const tokenCounter = getTokenCounter();

  const analysis = tokenCounter.analyzeConversation(this);

  this.usage = {
    promptTokens: analysis.promptTokens,
    completionTokens: analysis.completionTokens,
    totalTokens: analysis.totalTokens,
    estimatedCost: analysis.cost
  };
  this.lastUsageUpdate = new Date();

  return this.usage;
};

// V8 Indexes
ConversationSchema.index({ 'usage.estimatedCost': -1 }); // For top conversations query
ConversationSchema.index({ 'usage.totalTokens': -1 });

// Update timestamp on save
ConversationSchema.pre('save', function() {
  if (!this.$locals.transcriptBulkInsert) this.updatedAt = Date.now();
});

ConversationSchema.plugin(require('../src/services/conversations/transcriptPlugin'));

module.exports = mongoose.model('Conversation', ConversationSchema);
