'use strict';

const mongoose = require('mongoose');

// One ledger line, in integer cents (sign = effect on the account balance).
// The unique key (accountKey, date, fingerprint, occurrence) keeps two
// identical purchases on the same day and collapses overlapping statements.
const financeTransactionSchema = new mongoose.Schema({
  statementId: { type: mongoose.Schema.Types.ObjectId, ref: 'FinanceStatement', required: true },
  accountKey: { type: String, required: true },
  ledger: { type: String, enum: ['perso', 'corp'], default: 'perso' },
  accountCode: { type: String, required: true },
  date: { type: String, required: true },
  description: { type: String, required: true },
  amountCents: { type: Number, required: true },
  // Money seen from the owner's wallet: negative = money out. Equals amountCents for
  // cash accounts and its opposite for what the owner owes (cards, credit lines, loans).
  flowCents: { type: Number, default: null },
  balanceAfterCents: { type: Number, default: null },
  fingerprint: { type: String, required: true },
  occurrence: { type: Number, required: true },
  category: { type: String, default: null },
  tags: { type: [String], default: [] },
  manual: { type: Boolean, default: false }
}, { timestamps: true });

financeTransactionSchema.index({ accountKey: 1, date: 1, fingerprint: 1, occurrence: 1 }, { unique: true });
financeTransactionSchema.index({ statementId: 1 });
financeTransactionSchema.index({ date: -1 });

module.exports = mongoose.models.FinanceTransaction
  || mongoose.model('FinanceTransaction', financeTransactionSchema, 'finance_transactions');
