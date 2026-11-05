'use strict';

// A reviewed book repair retains its exact links without making an owner
// decision or reclassifying unrelated Secretary documents. Drift requires
// native review, never automatic deletion or re-matching of those relations.
const Link = require('../../../models/FinanceDocumentLink');
const Transaction = require('../../../models/FinanceTransaction');
const { keyOf, selector } = require('./financeTransactionIdentity');
const { ledgerOf, ledgerPrefix } = require('./ledgers');
const { hash } = require('./financeRepairStorage');
const { documentImage } = require('./financeRepairLinkContract');
const { error } = require('./financeAccess');
const conflict = () => error('A retained document relation needs native review', 'FINANCE_DOCUMENT_REPAIR_CONFLICT', 409);

async function retained(documents) {
  const links = await Link.find({ bookRepair: { $exists: true } }).lean();
  const assignments = new Map();
  if (!links.length) return assignments;
  const rows = await Transaction.find({ $or: links.map(link => selector(link.transactionKey)) }).lean();
  for (const link of links) {
    const proof = link.bookRepair, ledger = link.document?.ledger;
    const found = documents.filter(doc => doc.id === link.documentId);
    const matched = rows.filter(row => keyOf(row) === link.transactionKey);
    if (!proof || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(proof.requestKey || '')
      || !/^[a-f0-9]{64}$/.test(proof.documentSha256 || '') || !['perso','corp'].includes(ledger)
      || found.length !== 1 || hash(found[0]) !== proof.documentSha256
      || hash(documentImage(found[0])) !== hash(documentImage(link.document))
      || link.key !== link.documentId + '|' + link.transactionKey || matched.length !== 1
      || ledgerOf(matched[0].ledger) !== ledger || matched[0].accountKey !== link.transaction?.accountKey
      || matched[0].date !== link.transaction?.date || matched[0].flowCents !== link.transaction?.flowCents
      || matched[0].flowCents !== -found[0].amountCents
      || !matched[0].accountKey.startsWith(ledgerPrefix(ledger))
      || (ledger === 'perso' && matched[0].accountKey.startsWith('corp:'))
      || (assignments.has(link.documentId) && assignments.get(link.documentId) !== ledger)) throw conflict();
    assignments.set(link.documentId,ledger);
  }
  return assignments;
}

module.exports = { retained };
