'use strict';

// CSV export of ledger transactions for a spreadsheet (French Excel: UTF-8
// BOM, semicolon separator, decimal comma), with the totals Core computed.

const FinanceTransaction = require('../../../models/FinanceTransaction');
const { transactionFilter } = require('./financeQueryService');
const { csvCell } = require('../../../../shared/csvCell');

const MAX_EXPORT_ROWS = 20000;

// Bank descriptions are third-party text: the shared rule keeps them inert.
const cell = (value) => csvCell(value, ';');

function amount(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

function toCsv(rows) {
  const lines = [['Date', 'Compte', 'Description', 'Catégorie', 'Tags', 'Montant'].join(';')];
  let inCents = 0;
  let outCents = 0;
  for (const row of rows) {
    if (row.flowCents > 0) inCents += row.flowCents; else outCents += row.flowCents;
    lines.push([row.date, row.accountCode, row.description, row.category || '', (row.tags || []).join(', '), amount(row.flowCents)]
      .map(cell).join(';'));
  }
  lines.push('', ['Total entrées', '', '', '', '', amount(inCents)].join(';'),
    ['Total sorties', '', '', '', '', amount(outCents)].join(';'),
    ['Net', '', '', '', '', amount(inCents + outCents)].join(';'),
    [`${rows.length} opération(s)`, '', '', '', '', ''].join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

async function exportCsv(query = {}) {
  const rows = await FinanceTransaction.find(transactionFilter(query)).sort({ date: 1, _id: 1 })
    .limit(MAX_EXPORT_ROWS).select('date accountCode description flowCents category tags -_id').lean();
  const parts = ['finances', query.tag, query.category, query.q, query.from, query.to]
    .filter(Boolean).map((part) => String(part).normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9-]+/g, '-'));
  return { csv: toCsv(rows), fileName: `${parts.join('_').slice(0, 100)}.csv`, rows: rows.length };
}

module.exports = { exportCsv, toCsv, amount };
