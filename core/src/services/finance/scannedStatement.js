'use strict';

// Statements without a text layer (scans, photos saved as PDF). Each page is
// rendered at 200 dpi and read by the local vision model one page at a time;
// pages are merged in order and the same cent reconciliation decides. On a
// mismatch every page is read again with the problem stated (bounded).

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { normalizeExtraction, findProblems, StatementExtractionError } = require('./statementExtraction');

const DPI = 200;
const MAX_PAGES = 12;

const PAGE_PROMPT = `This image is page {page} of {pages} of a Canadian bank or credit-card statement (often French).
Return JSON with:
- issuer, account_last4, period_start, period_end (YYYY-MM-DD) if printed on THIS page, else null;
- account_code: "CARD" for a credit card, else the folio code (EOP, MC1...) of the rows on this page;
- opening_cents / closing_cents: previous balance ("Solde précédent", "Solde reporté") and new balance ("Nouveau solde",
  "Solde de fermeture") if printed on THIS page, else null. Integer cents; a balance marked CR or with a trailing minus
  is negative for an owed amount or an overdraft;
- rows: EVERY transaction row on this page in order: date (YYYY-MM-DD, statement year), description, amount_cents
  signed as the effect on the balance (card: purchases/interest/fees positive, payments/credits negative).
Ignore summaries, rewards, interest-rate tables and legal text. Copy digits exactly. JSON only.`;

const PAGE_SCHEMA = {
  type: 'object',
  properties: {
    issuer: { type: ['string', 'null'] }, account_last4: { type: ['string', 'null'] },
    period_start: { type: ['string', 'null'] }, period_end: { type: ['string', 'null'] },
    account_code: { type: 'string' },
    opening_cents: { type: ['integer', 'null'] }, closing_cents: { type: ['integer', 'null'] },
    rows: { type: 'array', items: { type: 'object', properties: {
      date: { type: 'string' }, description: { type: 'string' }, amount_cents: { type: 'integer' } },
    required: ['date', 'description', 'amount_cents'] } }
  },
  required: ['rows']
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (error, stdout) => {
      if (error) reject(Object.assign(new Error(`${command} failed: ${error.message}`), { code: 'FINANCE_RENDER_FAILED', status: 422 }));
      else resolve(stdout);
    });
  });
}

async function renderPages(filePath) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-scan-'));
  try {
    await run('pdftoppm', ['-r', String(DPI), '-png', '-l', String(MAX_PAGES), filePath, path.join(dir, 'p')]);
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.png')).sort();
    return Promise.all(files.map(async (name) => (await fs.readFile(path.join(dir, name))).toString('base64')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function merge(pages) {
  const first = (field) => pages.map((page) => page[field]).find((value) => value !== null && value !== undefined && value !== '');
  const accounts = new Map();
  for (const page of pages) {
    const code = String(page.account_code || 'CARD').replace(/\s+/g, '').toUpperCase();
    const account = accounts.get(code) || { code, opening_cents: null, closing_cents: null, transactions: [] };
    if (account.opening_cents === null && Number.isSafeInteger(page.opening_cents)) account.opening_cents = page.opening_cents;
    if (Number.isSafeInteger(page.closing_cents)) account.closing_cents = page.closing_cents;
    account.transactions.push(...(page.rows || []).map((row) => ({ ...row, balance_after_cents: null })));
    accounts.set(code, account);
  }
  return {
    issuer: first('issuer'), account_last4: first('account_last4'),
    period_start: first('period_start'), period_end: first('period_end'),
    accounts: [...accounts.values()].filter((account) => account.transactions.length || account.opening_cents !== null)
  };
}

/**
 * Extracts a scanned statement. Same result shape as extractStatement:
 * { statement, problems, attempts, model }.
 */
async function extractScannedStatement(filePath, {
  execute = require('../inferenceService').executeInference,
  model = process.env.FINANCE_EXTRACTION_MODEL || '',
  maxRetries = 1,
  render = renderPages,
  timeoutMs = 900000
} = {}) {
  const images = await render(filePath);
  if (!images.length) throw new StatementExtractionError('The document has no page to read', 'FINANCE_NO_PAGES', 422);
  let feedback = '';
  let attempts = 0;
  let resolvedModel = null;
  for (;;) {
    attempts += 1;
    const pages = [];
    for (const [index, image] of images.entries()) {
      const result = await execute({
        callerDetail: 'finance-ingestion-scan',
        ...(model ? { model } : { taskType: 'analysis' }),
        messages: [{ role: 'user', content: PAGE_PROMPT.replace('{page}', index + 1).replace('{pages}', images.length) + feedback,
          images: [image] }],
        stream: false, think: false, format: PAGE_SCHEMA, options: { temperature: 0, num_predict: 6000 }
      }, { timeoutMs });
      if (result === undefined) throw new StatementExtractionError('Extraction cancelled', 'FINANCE_EXTRACTION_CANCELLED', 499);
      if (!result.ok) {
        throw new StatementExtractionError(result.body?.message || 'Local inference is unavailable',
          result.body?.code || 'FINANCE_INFERENCE_UNAVAILABLE', result.status || 503);
      }
      resolvedModel = result.headers?.['X-Resolved-Model'] || result.body?.model || model || null;
      try {
        pages.push(JSON.parse(String(result.body?.message?.content ?? '').trim()));
      } catch {
        throw new StatementExtractionError(`The model did not return valid JSON for page ${index + 1}`);
      }
    }
    const statement = normalizeExtraction(merge(pages));
    const problems = findProblems(statement);
    if (!problems.length || attempts > maxRetries) return { statement, problems, attempts, model: resolvedModel };
    feedback = `\n\nA previous reading of this statement did not reconcile: ${problems.join(' ')} Read this page again carefully.`;
  }
}

module.exports = { extractScannedStatement, merge, renderPages };
