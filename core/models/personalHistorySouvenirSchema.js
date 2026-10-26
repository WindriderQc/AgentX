'use strict';
const { Schema } = require('mongoose');
const precision = { type: String, enum: ['unknown', 'year', 'month', 'day', 'instant'] };
const window = new Schema({ start: String, end: String }, { _id: false });
const temporal = new Schema({
  date: String, precision, endDate: String, endPrecision: precision, ongoing: Boolean,
  dateWindow: { type: window, default: null }, ageStartWindow: { type: window, default: null }, ageEndWindow: { type: window, default: null },
  ownerTimeLabel: String, ageDateNote: String, dateEstimateNote: String
}, { _id: false });
module.exports = new Schema({
  entryId: { type: String, required: true, match: /^[a-f0-9]{24}$/ },
  contextRevision: { type: Number, required: true, min: 1 },
  contextHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  temporal: { type: temporal, required: true },
  claimsWithExactQuotes: [{ _id: false, sourceId: String, quote: String, match: String, label: String, claimAuthor: String }],
  sources: [{ _id: false, id: String, kind: String, bodySha256: String }]
}, { _id: false });
