const mongoose = require('mongoose');

// The embedding model, dimension and collection RAG serves, as one document.
// `revision` changes only when another collection takes over; a write freeze
// holds ingestion for the few seconds a build needs to switch collections.
const ProfileSchema = new mongoose.Schema({
  model: { type: String, required: true },
  dimension: { type: Number, required: true },
  collection: { type: String, required: true }
}, { _id: false });

const EmbeddingProfileSchema = new mongoose.Schema({
  _id: { type: String, default: 'active' },
  active: { type: ProfileSchema, required: true },
  previous: { type: ProfileSchema, default: null },
  revision: { type: Number, default: 0 },
  freeze: {
    type: new mongoose.Schema({ buildId: String, since: Date, until: Date }, { _id: false }),
    default: null
  },
  activatedAt: { type: Date, default: null },
  activatedBy: { type: String, default: null }
}, { collection: 'embedding_profile', versionKey: false });

module.exports = mongoose.models.EmbeddingProfile || mongoose.model('EmbeddingProfile', EmbeddingProfileSchema);
