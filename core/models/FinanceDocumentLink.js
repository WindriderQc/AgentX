'use strict';

const mongoose = require('mongoose');

// A link between a Secretary document and a ledger row. Keyed by the document id
// and the row's stable key (account, date, fingerprint, occurrence), so it
// survives a re-ingested statement. Only the owner moves a link to `confirmed`
// or `rejected`; `proposed` links are recomputed from the register.
const financeDocumentLinkSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  documentId: { type: String, required: true },
  transactionKey: { type: String, required: true },
  status: { type: String, enum: ['proposed', 'confirmed', 'rejected'], default: 'proposed' },
  ambiguous: { type: Boolean, default: false },
  document: { type: mongoose.Schema.Types.Mixed, default: {} },
  transaction: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Only the reviewed native book-repair executor assigns this provenance.
  // It preserves the proposal; it is never an owner confirmation.
  bookRepair: { type: mongoose.Schema.Types.Mixed, default: undefined },
  decidedAt: { type: Date, default: null },
  decidedBy: { type: String, default: null }
}, { timestamps: true });

financeDocumentLinkSchema.index({ status: 1, documentId: 1 });
financeDocumentLinkSchema.index({ transactionKey: 1, status: 1 });

module.exports = mongoose.models.FinanceDocumentLink
  || mongoose.model('FinanceDocumentLink', financeDocumentLinkSchema, 'finance_document_links');

module.exports = require('../src/services/finance/financeModelGuard')(module.exports);
