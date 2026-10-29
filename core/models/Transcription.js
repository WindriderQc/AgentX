'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: String,
  intentHash: { type: String, required: true },
  url: { type: String, required: true },
  language: String, timeZone: String, requestedAt: Date,
  retryOf: { type: String, default: null },
  queueId: { type: String, default: null, index: true },
  state: { type: String, default: 'queued', index: true },
  stage: { type: String, default: 'queued' },
  title: String, duration: Number, detectedLanguage: String,
  startedAt: Date, finishedAt: Date, error: String, planningError: String,
  nativeBase: { type: String, select: false },
  admission: { type: mongoose.Schema.Types.Mixed, select: false },
  cancelRequested: { type: Boolean, default: false },
  runtimeReleased: { type: Boolean, default: false },
  result: { type: mongoose.Schema.Types.Mixed, select: false }
}, { timestamps: true, collection: 'transcriptions' });
schema.index({ createdAt: -1 });
module.exports = mongoose.models.Transcription || mongoose.model('Transcription', schema);
