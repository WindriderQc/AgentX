const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  role: { type: String, required: true }, // 'user', 'assistant', 'system'
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  feedback: {
    rating: { type: Number, enum: [1, -1, 0], default: 0 }, // 1: thumbs up, -1: thumbs down
    comment: String
  }
});

const ConversationSchema = new mongoose.Schema({
  userId: { type: String, default: 'default' },
  model: String,
  systemPrompt: String,
  messages: [MessageSchema],
  title: { type: String, default: 'New Conversation' }, // Auto-generated summary?
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
  }]
});

// Update timestamp on save
ConversationSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Conversation', ConversationSchema);
