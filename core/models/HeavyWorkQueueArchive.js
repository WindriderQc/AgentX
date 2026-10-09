'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  key: { type: String, required: true, unique: true },
  digest: { type: String, required: true },
  job: { type: mongoose.Schema.Types.Mixed, required: true },
  archivedAt: { type: Date, default: Date.now }
}, { collection: 'heavy_work_queue_archive', minimize: false });
module.exports = mongoose.models.HeavyWorkQueueArchive || mongoose.model('HeavyWorkQueueArchive', schema);
