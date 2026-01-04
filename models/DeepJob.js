const mongoose = require('mongoose');

const DeepJobSchema = new mongoose.Schema({
  // Unique Job ID (could use _id, but an explicit ID is often useful for correlation)
  jobId: { type: String, required: true, unique: true },

  // Link to conversation context
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  messageId: { type: mongoose.Schema.Types.ObjectId, required: true },

  // Status of the heavy operation
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },

  // Input parameters
  payload: {
    query: String,
    model: String,
    params: mongoose.Schema.Types.Mixed
  },

  // Output results from n8n
  result: {
    evidence: [{
      source: String,
      content: String,
      confidence: Number,
      url: String
    }],
    finalAnswer: String,
    rawOutput: mongoose.Schema.Types.Mixed
  },

  error: {
    message: String,
    stack: String,
    details: mongoose.Schema.Types.Mixed
  },

  // Timings
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
});

DeepJobSchema.index({ conversationId: 1 });
DeepJobSchema.index({ status: 1 });
DeepJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 }); // 7 days retention

DeepJobSchema.pre('save', function() {
  this.updatedAt = Date.now();
  if (this.status === 'completed' && !this.completedAt) {
    this.completedAt = Date.now();
  }
});

module.exports = mongoose.model('DeepJob', DeepJobSchema);
