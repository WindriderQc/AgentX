'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  ownerId: { type: String, required: true, maxlength: 200 },
  surface: { type: String, required: true, enum: ['playground', 'psyx', 'nestor', 'family'] },
  revision: { type: Number, required: true, min: 1 },
  values: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} }
}, { collection: 'conversation_preferences', timestamps: true });
schema.index({ ownerId: 1, surface: 1 }, { unique: true });
module.exports = mongoose.models.ConversationPreferences || mongoose.model('ConversationPreferences', schema);
