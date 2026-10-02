'use strict';

const mongoose = require('mongoose');

// Owner's decision for one transaction (category and tags), kept apart from
// the ledger rows so it survives a statement being re-ingested. It is keyed
// like the transaction itself and wins over any rule.
const financeOverrideSchema = new mongoose.Schema({
  accountKey: { type: String, required: true },
  date: { type: String, required: true },
  fingerprint: { type: String, required: true },
  occurrence: { type: Number, required: true },
  category: { type: String, required: true },
  tags: { type: [String], default: [] },
  createdBy: { type: String, default: 'owner' }
}, { timestamps: true });

financeOverrideSchema.index({ accountKey: 1, date: 1, fingerprint: 1, occurrence: 1 }, { unique: true });

module.exports = mongoose.models.FinanceOverride
  || mongoose.model('FinanceOverride', financeOverrideSchema, 'finance_overrides');
