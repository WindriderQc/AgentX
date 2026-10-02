'use strict';
const mongoose = require('mongoose');

// Bytes stay outside the transcript; canonical user messages retain references.
const schema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true },
  mimeType: { type: String, required: true },
  kind: { type: String, enum: ['image', 'document'], required: true },
  size: { type: Number, required: true },
  sha256: { type: String, required: true },
  data: { type: Buffer, required: true },
  text: { type: String, default: undefined },
  createdAt: { type: Date, default: Date.now }
});
// Retrying the same upload in one conversation reuses the immutable attachment.
schema.index({ conversationId: 1, sha256: 1, name: 1, mimeType: 1 }, { unique: true });
module.exports = mongoose.model('ConversationAttachment', schema);
