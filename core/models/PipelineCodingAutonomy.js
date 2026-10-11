'use strict';
const mongoose = require('mongoose');

// Task state, attempts and evidence remain on PipelineTask. This singleton only
// records the operator switch and serializes selection across Core processes.
module.exports = mongoose.model('PipelineCodingAutonomy', new mongoose.Schema({
  _id: { type: String, default: 'coding-autonomy' },
  enabled: { type: Boolean, default: false },
  revision: { type: Number, default: 0 },
  actor: String,
  active: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true }));
