const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  role: { type: String, required: true }, // 'user', 'assistant', 'system'
  content: { type: String, required: true },
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
      source: { type: String, enum: ['environment', 'database', 'default', 'unconfigured'] }
    },
    calculatedAt: Date
  }
});

const ConversationSchema = new mongoose.Schema({
  userId: { type: String, default: 'default' },
  model: String,
  systemPrompt: String,
  messages: [MessageSchema],
  title: { type: String, default: 'New Conversation' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  
  // V3: RAG support
  ragUsed: { type: Boolean, default: false },
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
  }
});

// Indexes for V4 analytics queries
ConversationSchema.index({ createdAt: 1 });
ConversationSchema.index({ model: 1, createdAt: 1 });
ConversationSchema.index({ promptConfigId: 1 });
ConversationSchema.index({ promptName: 1, promptVersion: 1 });
ConversationSchema.index({ ragUsed: 1 });
ConversationSchema.index({ 'messages.feedback.rating': 1 });

// V5: Indexes for cost tracking analytics
ConversationSchema.index({ 'totalCost.sum': 1 });
ConversationSchema.index({ model: 1, 'totalCost.sum': 1 });

// Update timestamp on save
ConversationSchema.pre('save', function() {
  this.updatedAt = Date.now();
});

module.exports = mongoose.model('Conversation', ConversationSchema);
