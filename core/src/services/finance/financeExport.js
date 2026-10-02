'use strict';

// CSV export of ledger transactions for a spreadsheet (French Excel: UTF-8
// BOM, semicolon separator, decimal comma). Every matching row is streamed,
// oldest first, and the closing totals and count cover all of them. An export
// cut by a database failure ends without those totals, so it reads as
// incomplete.

const FinanceTransaction = require('../../../models/FinanceTransaction');
const { transactionFilter } = require('./financeQueryService');
const { csvCell } = require('../../../../shared/csvCell');

const ROWS_PER_CHUNK = 500;

// Bank descriptions are third-party text: the shared rule keeps them inert.
const cell = (value) => csvCell(value, ';');

function amount(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

// A generator body runs on the first read, so the cursor opens only then.
async function* csvChunks(filter) {
  const rows = FinanceTransaction.find(filter).sort({ date: 1, _id: 1 })
    .select('date accountCode description flowCents category tags -_id').lean().cursor();
  let lines = ['\uFEFF' + ['Date', 'Compte', 'Description', 'Catégorie', 'Tags', 'Montant'].join(';')];
  let inCents = 0;
  let outCents = 0;
  let count = 0;
  for await (const row of rows) {
    if (row.flowCents > 0) inCents += row.flowCents; else outCents += row.flowCents;
    count += 1;
    lines.push([row.date, row.accountCode, row.description, row.category || '', (row.tags || []).join(', '), amount(row.flowCents)]
      .map(cell).join(';'));
    if (lines.length >= ROWS_PER_CHUNK) {
      yield `${lines.join('\r\n')}\r\n`;
      lines = [];
    }
  }
  lines.push('', ['Total entrées', '', '', '', '', amount(inCents)].join(';'),
    ['Total sorties', '', '', '', '', amount(outCents)].join(';'),
    ['Net', '', '', '', '', amount(inCents + outCents)].join(';'),
    [`${count} opération(s)`, '', '', '', '', ''].join(';'));
  yield `${lines.join('\r\n')}\r\n`;
}

/**
 * Validate the filter (an invalid one rejects before anything is sent) and
 * return the file name with the CSV as an async iterable of text chunks.
 */
async function exportCsv(query = {}) {
  const filter = transactionFilter(query);
  const parts = ['finances', query.tag, query.category, query.q, query.from, query.to]
    .filter(Boolean).map((part) => String(part).normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9-]+/g, '-'));
  return { fileName: `${parts.join('_').slice(0, 100)}.csv`, chunks: csvChunks(filter) };
}

module.exports = { exportCsv, amount };
