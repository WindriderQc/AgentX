'use strict';
const mongoose = require('mongoose');
// The owner's own screen-command phrases for Nestor's content workspace (#924).
const schema = new mongoose.Schema({
  ownerId: { type: String, required: true, maxlength: 200 },
  revision: { type: Number, required: true, min: 1 },
  phrases: {
    type: [{ _id: false, phrase: { type: String, required: true, maxlength: 80 }, action: { type: String, required: true, maxlength: 40 } }],
    default: []
  }
}, { collection: 'screen_command_phrases', timestamps: true });
schema.index({ ownerId: 1 }, { unique: true });
module.exports = mongoose.models.ScreenCommandPhrases || mongoose.model('ScreenCommandPhrases', schema);
