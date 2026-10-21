const mongoose = require('mongoose');

// One embedding index build, identified by the Core heavy-work request that
// launched it, so a lost answer is found again instead of started twice.
const EmbeddingBuildSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  model: { type: String, required: true },
  dimension: { type: Number, required: true },
  sourceCollection: { type: String, required: true },
  sourceModel: { type: String, required: true },
  sourceDimension: { type: Number, required: true },
  targetCollection: { type: String, required: true },
  fromRevision: { type: Number, required: true },
  status: { type: String, enum: ['copying', 'finalizing', 'activated', 'failed', 'cancelled'], required: true },
  cancelRequested: { type: Boolean, default: false },
  progress: { type: mongoose.Schema.Types.Mixed, default: {} },
  error: { type: String, default: null },
  profileRevision: { type: Number, default: null },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, default: null }
}, { collection: 'embedding_builds', versionKey: false });

EmbeddingBuildSchema.index({ status: 1 });
EmbeddingBuildSchema.index({ startedAt: -1 });

module.exports = mongoose.models.EmbeddingBuild || mongoose.model('EmbeddingBuild', EmbeddingBuildSchema);
