'use strict';

const mongoose = require('mongoose');

// A reporting boundary, never a deletion or an inference/admission reset.
const schema = new mongoose.Schema({
  _id: { type: String, default: 'daily-use' },
  since: { type: Date, required: true, immutable: true },
  createdBy: { type: String, required: true, maxlength: 100 }
}, { collection: 'analytics_usage_period', timestamps: true });

module.exports = mongoose.models.AnalyticsUsagePeriod || mongoose.model('AnalyticsUsagePeriod', schema);
