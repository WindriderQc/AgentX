'use strict';

const { error } = require('./financeAccess');
const { hash, canonical } = require('./financeRepairStorage');
const { keyOf } = require('./financeTransactionIdentity');
const { loadRegister } = require('./financeDocumentRegister');
const invalid = message => error(message, 'FINANCE_REPAIR_MANIFEST_INVALID', 400);
const documentImage = doc => Object.fromEntries(['supplier','documentNumber','documentDate','kind','amountCents','originalFilename'].map(k => [k,doc[k]]));

function sets(manifest, group, { source, target, move }) {
  const documents = manifest.verifiedIdentity.documents;
  const ids = group.links.map(u => u.before.documentId);
  if (!group.links.length || !Array.isArray(documents) || documents.length > 50
    || documents.some(d => !d || typeof d !== 'object' || Array.isArray(d) || !/^[a-f0-9]{16}$/.test(d.id || ''))
    || new Set(documents.map(d => d.id)).size !== documents.length
    || canonical(documents.map(d => d.id).sort()) !== canonical([...new Set(ids)].sort())) {
    throw invalid('Version 3 requires the exact registered documents of its links');
  }
  return group.links.map(update => {
    const link = update.before;
    const row = group.transactions.find(u => keyOf(u.before) === link.transactionKey)?.before;
    const doc = documents.find(d => d.id === link.documentId);
    if (!row || !doc || !/^[a-f0-9]{16}$/.test(doc.id) || !['invoice','receipt','payment_proof','claim','remit_advice','quote','tax','other'].includes(doc.kind)
      || link.key !== doc.id + '|' + keyOf(row) || !['proposed','confirmed','rejected'].includes(link.status)
      || typeof link.ambiguous !== 'boolean' || link.document?.ledger !== source
      || canonical(documentImage(doc)) !== canonical(documentImage(link.document))
      || !Number.isSafeInteger(doc.amountCents) || doc.amountCents <= 0 || row.flowCents !== -doc.amountCents
      || link.transaction?.accountKey !== row.accountKey || link.transaction?.date !== row.date
      || link.transaction?.description !== row.description || link.transaction?.flowCents !== row.flowCents
      || link.transaction?.category !== row.category) throw invalid('The document link must follow its exact reviewed row and registered document');
    return { key: doc.id + '|' + move(link.transactionKey), transactionKey: move(link.transactionKey),
      'transaction.accountKey': move(row.accountKey), ...(source === target ? {} : { 'document.ledger': target }),
      bookRepair: { requestKey: manifest.requestKey, documentSha256: hash(doc) } };
  });
}

async function verifyDocuments(manifest) {
  if (![3,4].includes(manifest.schemaVersion) || !manifest.verifiedIdentity.documents.length) return;
  const register = await loadRegister();
  if (register.status !== 'ok' || manifest.verifiedIdentity.documents.some(expected => {
    const found = register.invoices.filter(doc => doc.id === expected.id);
    return found.length !== 1 || hash(found[0]) !== hash(expected);
  })) throw error('The reviewed Secretary documents changed or are unavailable', 'FINANCE_REPAIR_DOCUMENTS_CHANGED', 409);
}

module.exports = { sets, verifyDocuments, documentImage };
