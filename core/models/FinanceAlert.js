'use strict';

const mongoose = require('mongoose');

// A deterministic finance alert. `key` identifies the underlying fact so the
// same fact is raised once; `acknowledgedAt` records that it was reported.
const financeAlertSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  kind: { type: String, required: true },
  severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
  title: { type: String, required: true },
  facts: { type: mongoose.Schema.Types.Mixed, default: {} },
  acknowledgedAt: { type: Date, default: null }
}, { timestamps: true });

financeAlertSchema.index({ acknowledgedAt: 1, createdAt: -1 });

module.exports = mongoose.models.FinanceAlert
  || mongoose.model('FinanceAlert', financeAlertSchema, 'finance_alerts');
