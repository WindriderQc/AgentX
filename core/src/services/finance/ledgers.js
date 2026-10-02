'use strict';

// Separate books ("ledgers"): the owner's personal finances and his
// corporation. Existing rows without a ledger field are personal.

const LEDGERS = Object.freeze(['perso', 'corp']);

function ledgerOf(value) {
  return String(value || '').trim().toLowerCase() === 'corp' ? 'corp' : 'perso';
}

// Mongo filter selecting one ledger's statements or transactions.
function ledgerFilter(value) {
  return ledgerOf(value) === 'corp' ? { ledger: 'corp' } : { ledger: { $ne: 'corp' } };
}

// Keys of corporate statements and accounts never collide with personal ones.
function ledgerPrefix(value) {
  return ledgerOf(value) === 'corp' ? 'corp:' : '';
}

// Accounts where a positive amount means the owner owes more.
const LIABILITY_CODE = /^(CARD|MC\d*|PR\d*|ML\d*|LOAN)$/;

function isLiability(code) {
  return LIABILITY_CODE.test(String(code || '').toUpperCase());
}

function flowOf(code, amountCents) {
  return isLiability(code) ? -amountCents : amountCents;
}

module.exports = { LEDGERS, ledgerOf, ledgerFilter, ledgerPrefix, isLiability, flowOf, LIABILITY_CODE };
