const mongoose = require('mongoose');

const EmbeddingCacheStatsSchema = new mongoose.Schema({
  _id: {
    type: String,
    required: true
  },
  hitCount: {
    type: Number,
    default: 0
  },
  missCount: {
    type: Number,
    default: 0
  },
  evictionCount: {
    type: Number,
    default: 0
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  versionKey: false
});

module.exports = mongoose.model('EmbeddingCacheStats', EmbeddingCacheStatsSchema);
