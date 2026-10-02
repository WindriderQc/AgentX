'use strict';

// Statement extraction: a local model turns the text layer of a bank or
// credit-card statement into JSON, and deterministic arithmetic decides whether
// the result is accepted. The model never produces totals; every account must
// satisfy opening + sum(amounts) = closing, and every printed running balance
// must match, to the cent. On mismatch the model receives the exact failing row
// and retries.

const DEFAULT_MAX_RETRIES = Math.min(Math.max(Number.parseInt(process.env.FINANCE_EXTRACTION_RETRIES, 10) || 3, 0), 5);

const PROMPT = `You extract a Canadian bank or credit-card statement (often French) into JSON.
Top level: issuer (bank or card name, e.g. "Desjardins", "Odyssee"), account_last4 (last 4 digits of the
statement's main account or card number, or null), period_start and period_end (YYYY-MM-DD).
accounts: every account section that has a balance: chequing/savings folios (codes like EOP, ES1, ET1, CS),
lines of credit (MC1, MC2), loans (PR3, PR4). For a credit-card statement use the single account code "CARD".
For each account give:
- code
- opening_cents: the opening balance ("Solde reporté", "Solde précédent", first balance) in integer cents
- closing_cents: the closing balance ("Solde de fermeture", "Nouveau solde", last balance) in integer cents
- transactions: EVERY transaction row in order, with date (YYYY-MM-DD), description, amount_cents,
  and balance_after_cents = the running balance printed on that row (null when the row prints none).
amount_cents is a signed integer: its sign is the effect on that account's balance, so that
opening_cents + sum(amount_cents) == closing_cents exactly. For a credit card the balance is the amount owed
(purchases and interest positive, payments and credits negative); a card balance followed by "CR" is a credit
balance, so the amount owed is negative (e.g. "1 738,29 $ CR" gives -173829). French amounts use a space or dot for
thousands and a comma for decimals; "CR" marks a credit. A trailing minus ("1 234.56-") or parentheses mark
a negative balance (overdraft): keep that sign on opening_cents, closing_cents and balance_after_cents.
Copy digits exactly; never compute or round.
Output JSON only.`;

const SCHEMA = {
  type: 'object',
  properties: {
    issuer: { type: 'string' },
    account_last4: { type: ['string', 'null'] },
    period_start: { type: 'string' },
    period_end: { type: 'string' },
    accounts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          opening_cents: { type: 'integer' },
          closing_cents: { type: 'integer' },
          transactions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string' },
                description: { type: 'string' },
                amount_cents: { type: 'integer' },
                balance_after_cents: { type: ['integer', 'null'] }
              },
              required: ['date', 'description', 'amount_cents']
            }
          }
        },
        required: ['code', 'opening_cents', 'closing_cents', 'transactions']
      }
    }
  },
  required: ['issuer', 'period_start', 'period_end', 'accounts']
};

class StatementExtractionError extends Error {
  constructor(message, code = 'FINANCE_EXTRACTION_FAILED', status = 502) {
    super(message);
    this.name = 'StatementExtractionError';
    this.code = code;
    this.status = status;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Product-tier words vary between statements of the same card ("Odyssee" vs
// "Odyssee World Elite Mastercard"); dropping them keeps one issuer name, so
// one card keeps one ledger account.
const ISSUER_NOISE = /\b(world\s*elite|worldelite|mastercard|master\s*card|visa|infinite|signature|elite|avion|carte|card|de\s+credit|credit|cr[eé]dit)\b/gi;

function normalizeIssuer(value) {
  const text = cleanText(value, 60).replace(ISSUER_NOISE, ' ').replace(/[®™]/g, ' ').replace(/\s+/g, ' ').trim();
  return text || cleanText(value, 60);
}

function cleanText(value, max = 200) {
  return String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cents(value, field) {
  if (!Number.isSafeInteger(value)) throw new StatementExtractionError(`${field} must be an integer number of cents`);
  return value;
}

function isoDate(value, field) {
  const text = cleanText(value, 10);
  if (!ISO_DATE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new StatementExtractionError(`${field} must be a YYYY-MM-DD date`);
  }
  return text;
}

// Validates the model output and returns a normalized statement. Throws on a
// structurally unusable answer; arithmetic problems are reported by findProblems.
function normalizeExtraction(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts)) {
    throw new StatementExtractionError('The model did not return a statement with accounts');
  }
  const last4 = cleanText(raw.account_last4, 8).replace(/\D/g, '').slice(-4);
  const statement = {
    issuer: normalizeIssuer(raw.issuer),
    accountLast4: last4 || null,
    periodStart: isoDate(raw.period_start, 'period_start'),
    periodEnd: isoDate(raw.period_end, 'period_end'),
    accounts: raw.accounts.map((account, a) => ({
      code: cleanText(account?.code, 16).replace(/\s+/g, '').toUpperCase(),
      openingCents: cents(account?.opening_cents, `accounts[${a}].opening_cents`),
      closingCents: cents(account?.closing_cents, `accounts[${a}].closing_cents`),
      transactions: (Array.isArray(account?.transactions) ? account.transactions : []).map((row, t) => ({
        date: isoDate(row?.date, `accounts[${a}].transactions[${t}].date`),
        description: cleanText(row?.description),
        amountCents: cents(row?.amount_cents, `accounts[${a}].transactions[${t}].amount_cents`),
        balanceAfterCents: row?.balance_after_cents == null
          ? null
          : cents(row.balance_after_cents, `accounts[${a}].transactions[${t}].balance_after_cents`)
      }))
    }))
  };
  if (!statement.issuer) throw new StatementExtractionError('The model did not name the statement issuer');
  if (!statement.accounts.length) throw new StatementExtractionError('The statement has no account');
  const codes = statement.accounts.map((account) => account.code);
  if (codes.some((code) => !code) || new Set(codes).size !== codes.length) {
    throw new StatementExtractionError('Account codes must be present and unique');
  }
  return statement;
}

const money = (value) => (value / 100).toFixed(2);

// Deterministic checks. Each problem is a sentence the model can act on.
function findProblems(statement) {
  const problems = [];
  for (const account of statement.accounts) {
    let balance = account.openingCents;
    let rowProblem = false;
    for (const [index, row] of account.transactions.entries()) {
      balance += row.amountCents;
      if (row.balanceAfterCents != null && row.balanceAfterCents !== balance) {
        problems.push(`Account ${account.code}, row ${index + 1} (${row.date} ${row.description.slice(0, 40)}): `
          + `previous balance + amount gives ${money(balance)} but the row prints ${money(row.balanceAfterCents)}. `
          + 'Check the amount\'s column (fees/interest/withdrawal/deposit) and its sign.');
        rowProblem = true;
        break;
      }
    }
    if (!rowProblem && balance !== account.closingCents) {
      problems.push(balance === -account.closingCents && balance !== 0
        ? `Account ${account.code}: opening + sum of amounts = ${money(balance)}, exactly the opposite of the closing `
          + `balance ${money(account.closingCents)}: the closing sign is probably reversed (a balance marked CR or with a `
          + 'trailing minus is negative for a credit card owed amount or an overdraft).'
        : `Account ${account.code}: opening + sum of amounts = ${money(balance)}, `
          + `but closing is ${money(account.closingCents)}. A row is missing, duplicated or has a wrong sign.`);
    }
  }
  return problems;
}

function parseContent(result) {
  const text = result?.body?.message?.content ?? result?.body?.response ?? '';
  try {
    return JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    throw new StatementExtractionError('The model did not return valid JSON');
  }
}

/**
 * Extracts a statement from its text layer. Returns
 * { statement, problems, attempts, model }: problems is empty only when every
 * account reconciles to the cent. Inference refusals (host busy, admission)
 * propagate as errors with the inference status so callers can retry later.
 */
async function extractStatement(text, {
  execute = require('../inferenceService').executeInference,
  model = process.env.FINANCE_EXTRACTION_MODEL || '',
  maxRetries = DEFAULT_MAX_RETRIES,
  timeoutMs = 600000,
  signal
} = {}) {
  const layout = String(text || '').trim();
  if (!layout) throw new StatementExtractionError('The document has no text layer', 'FINANCE_NO_TEXT', 422);
  const messages = [{ role: 'user', content: `${PROMPT}\n\nSTATEMENT TEXT:\n${layout}` }];
  let attempts = 0;
  let resolvedModel = null;
  for (;;) {
    attempts += 1;
    const result = await execute({
      callerDetail: 'finance-ingestion',
      ...(model ? { model } : { taskType: 'analysis' }),
      messages,
      stream: false,
      think: false,
      format: SCHEMA,
      options: { temperature: 0, num_predict: 16000 }
    }, { signal, timeoutMs });
    if (result === undefined) throw new StatementExtractionError('Extraction cancelled', 'FINANCE_EXTRACTION_CANCELLED', 499);
    if (!result.ok) {
      throw new StatementExtractionError(
        result.body?.message || result.body?.error || 'Local inference is unavailable',
        result.body?.code || 'FINANCE_INFERENCE_UNAVAILABLE',
        result.status || 503
      );
    }
    resolvedModel = result.headers?.['X-Resolved-Model'] || result.body?.model || model || null;
    const content = result.body?.message?.content ?? result.body?.response ?? '';
    const statement = normalizeExtraction(parseContent(result));
    const problems = findProblems(statement);
    if (!problems.length || attempts > maxRetries) return { statement, problems, attempts, model: resolvedModel };
    messages.push(
      { role: 'assistant', content },
      { role: 'user', content: `The deterministic check found problems:\n- ${problems.join('\n- ')}\n`
        + 'Return the full corrected JSON for all accounts.' }
    );
  }
}

module.exports = { extractStatement, findProblems, normalizeExtraction, normalizeIssuer, StatementExtractionError, SCHEMA };
