'use strict';

const mongoose = require('mongoose');

// One ingested statement document. Identity is (issuer, account, period): a
// re-downloaded or re-issued statement replaces the previous one. The file hash
// only records provenance. Transactions exist only for reconciled statements.
const accountSchema = new mongoose.Schema({
  code: { type: String, required: true },
  accountKey: { type: String, required: true },
  openingCents: { type: Number, required: true },
  closingCents: { type: Number, required: true },
  transactionCount: { type: Number, required: true }
}, { _id: false });

const financeStatementSchema = new mongoose.Schema({
  statementKey: { type: String, default: null },
  ledger: { type: String, enum: ['perso', 'corp'], default: 'perso' },
  status: { type: String, enum: ['reconciled', 'needs_review'], required: true },
  issuer: { type: String, default: null },
  accountLast4: { type: String, default: null },
  periodStart: { type: String, default: null },
  periodEnd: { type: String, default: null },
  accounts: { type: [accountSchema], default: [] },
  problems: { type: [String], default: [] },
  fileName: { type: String, required: true },
  fileSha256: { type: String, required: true },
  archivePath: { type: String, default: null },
  model: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  source: { type: String, enum: ['text', 'image'], default: 'text' },
  ingestedAt: { type: Date, default: Date.now }
}, { timestamps: true });

financeStatementSchema.index(
  { statementKey: 1 },
  { unique: true, partialFilterExpression: { statementKey: { $type: 'string' } } }
);
financeStatementSchema.index({ fileSha256: 1 });
financeStatementSchema.index({ status: 1, periodEnd: -1 });

module.exports = mongoose.models.FinanceStatement
  || mongoose.model('FinanceStatement', financeStatementSchema, 'finance_statements');
