'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const FinanceStatement = require('../../models/FinanceStatement');
const FinanceTransaction = require('../../models/FinanceTransaction');
const { extractStatement, findProblems, normalizeExtraction, normalizeIssuer } = require('../../src/services/finance/statementExtraction');
const { ingestDocument } = require('../../src/services/finance/financeIngestionService');
const query = require('../../src/services/finance/financeQueryService');
const { createFinanceInbox } = require('../../src/services/finance/financeInboxService');
const FinanceRule = require('../../models/FinanceRule');
const FinanceAlert = require('../../models/FinanceAlert');
const FinanceOverride = require('../../models/FinanceOverride');
const categories = require('../../src/services/finance/financeCategories');

// Synthetic statement: a chequing folio and a line of credit whose automatic
// repayment sits in the interest column and leaves the balance unchanged (the
// trap a column-blind reading falls into).
function statement({ period = ['2026-06-01', '2026-06-30'], trap = false, coffees = 2 } = {}) {
  const coffeeRows = Array.from({ length: coffees }, () => ({
    date: '2026-06-03', description: 'CAFE DU COIN', amount_cents: -450, balance_after_cents: null
  }));
  let balance = 100000;
  const cheque = [...coffeeRows, { date: '2026-06-15', description: 'PAIE EMPLOYEUR', amount_cents: 250000, balance_after_cents: null }]
    .map((row) => { balance += row.amount_cents; return { ...row, balance_after_cents: balance }; });
  return {
    issuer: 'Caisse Exemple', account_last4: '0000', period_start: period[0], period_end: period[1],
    accounts: [
      { code: 'EOP', opening_cents: 100000, closing_cents: balance, transactions: cheque },
      {
        code: 'MC 1', opening_cents: 1452051, closing_cents: 1494277,
        transactions: [
          { date: '2026-06-05', description: 'Avance au compte EOP', amount_cents: 42226, balance_after_cents: 1494277 },
          { date: '2026-06-08', description: 'Remboursement automatique', amount_cents: trap ? -13363 : 0, balance_after_cents: 1494277 }
        ]
      }
    ]
  };
}

function fakeInference(answers) {
  const calls = [];
  const execute = async (body) => {
    calls.push(body);
    const next = answers.shift();
    if (next?.status) return { ok: false, status: next.status, body: { code: next.code, message: 'busy' } };
    return { ok: true, status: 200, body: { model: 'fake-model', message: { content: JSON.stringify(next) } }, headers: {} };
  };
  return { execute, calls };
}

let tmp;
async function writeDoc(name, content = name) {
  const file = path.join(tmp, name);
  await fs.writeFile(file, content);
  return file;
}
const extractWith = (...answers) => (text) => extractStatement(text, fakeInference(answers));
const readText = async () => 'statement text layer '.repeat(40);

beforeEach(async () => {
  await Promise.all([FinanceStatement.deleteMany({}), FinanceTransaction.deleteMany({}), FinanceRule.deleteMany({}), FinanceAlert.deleteMany({}), FinanceOverride.deleteMany({})]);
  await Promise.all([FinanceStatement.syncIndexes(), FinanceTransaction.syncIndexes()]);
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-test-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('statement extraction', () => {
  test('keeps one issuer name per card whatever tier words the statement prints', () => {
    expect(normalizeIssuer('Desjardins Odyssee Worldelite Mastercard')).toBe('Desjardins Odyssee');
    expect(normalizeIssuer('Desjardins Odyssée World Elite Mastercard®')).toBe('Desjardins Odyssée');
    expect(normalizeIssuer('Scotiabank Scene+ Visa')).toBe('Scotiabank Scene+');
    expect(normalizeIssuer('Desjardins')).toBe('Desjardins');
    expect(normalizeIssuer('Visa')).toBe('Visa');
  });

  test('says when the closing balance sign looks reversed, as with a card credit balance marked CR', () => {
    const card = { issuer: 'Carte Exemple', account_last4: '1234', period_start: '2024-01-01', period_end: '2024-01-31',
      accounts: [{ code: 'CARD', opening_cents: -114836, closing_cents: 173829,
        transactions: [{ date: '2024-01-10', description: 'REMISE', amount_cents: -58993 }] }] };
    expect(findProblems(normalizeExtraction(card))[0]).toMatch(/closing sign is probably reversed/);
  });

  test('points at the exact row whose printed balance disagrees', () => {
    const problems = findProblems(normalizeExtraction(statement({ trap: true })));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Account MC1, row 2 .*gives 14809\.14 but the row prints 14942\.77/);
  });

  test('retries with the deterministic feedback until every account reconciles', async () => {
    const { execute, calls } = fakeInference([statement({ trap: true }), statement()]);
    const result = await extractStatement('text', { execute, maxRetries: 2 });
    expect(result).toMatchObject({ problems: [], attempts: 2 });
    expect(calls[0]).toMatchObject({ callerDetail: 'finance-ingestion', taskType: 'analysis', think: false, stream: false });
    expect(calls[0].format.required).toContain('accounts');
    expect(calls[1].messages.at(-1).content).toMatch(/row 2/);
  });

  test('tells the model how negative balances are printed and retries three times by default', async () => {
    const { execute, calls } = fakeInference([statement({ trap: true }), statement({ trap: true }), statement({ trap: true }), statement()]);
    const result = await extractStatement('text', { execute });
    expect(result).toMatchObject({ problems: [], attempts: 4 });
    expect(calls[0].messages[0].content).toMatch(/trailing minus/);
  });

  test('gives up after the retry budget and reports what is still wrong', async () => {
    const { execute } = fakeInference([statement({ trap: true }), statement({ trap: true })]);
    const result = await extractStatement('text', { execute, maxRetries: 1 });
    expect(result.attempts).toBe(2);
    expect(result.problems).toHaveLength(1);
  });

  test('refuses non-integer amounts, empty text and busy hosts', async () => {
    const bad = statement();
    bad.accounts[0].transactions[0].amount_cents = -4.5;
    expect(() => normalizeExtraction(bad)).toThrow(/integer number of cents/);
    await expect(extractStatement('  ', fakeInference([]))).rejects.toMatchObject({ code: 'FINANCE_NO_TEXT' });
    await expect(extractStatement('text', fakeInference([{ status: 503, code: 'RUNTIME_INFERENCE_ADMISSION_DENIED' }])))
      .rejects.toMatchObject({ status: 503, code: 'RUNTIME_INFERENCE_ADMISSION_DENIED' });
  });
});

describe('ledger ingestion', () => {
  test('writes a reconciled statement and keeps identical same-day purchases', async () => {
    const result = await ingestDocument(await writeDoc('june.pdf'), { readText, extract: extractWith(statement()) });
    expect(result).toMatchObject({ outcome: 'reconciled', accounts: 2, inserted: 5, overlapping: 0, replaced: false });
    const coffees = await FinanceTransaction.find({ description: 'CAFE DU COIN' }).sort({ occurrence: 1 }).lean();
    expect(coffees.map((row) => row.occurrence)).toEqual([1, 2]);
    expect(coffees[0].accountKey).toBe('caisse-exemple|0000|EOP');
  });

  test('records a statement that does not reconcile without writing any transaction', async () => {
    const result = await ingestDocument(await writeDoc('june.pdf'),
      { readText, extract: extractWith(...Array.from({ length: 4 }, () => statement({ trap: true }))) });
    expect(result.outcome).toBe('needs_review');
    expect(await FinanceTransaction.countDocuments()).toBe(0);
    expect(await FinanceStatement.findOne().lean()).toMatchObject({ status: 'needs_review', statementKey: null });
  });

  test('replaces a re-downloaded statement for the same period and skips a known file', async () => {
    await ingestDocument(await writeDoc('june.pdf', 'bytes-a'), { readText, extract: extractWith(statement({ coffees: 1 })) });
    const again = await ingestDocument(await writeDoc('june-again.pdf', 'bytes-b'), { readText, extract: extractWith(statement()) });
    expect(again).toMatchObject({ outcome: 'reconciled', replaced: true, inserted: 5 });
    expect(await FinanceStatement.countDocuments()).toBe(1);
    expect(await FinanceTransaction.countDocuments()).toBe(5);

    const extract = jest.fn();
    expect(await ingestDocument(path.join(tmp, 'june-again.pdf'), { readText, extract }))
      .toMatchObject({ outcome: 'duplicate' });
    expect(extract).not.toHaveBeenCalled();
  });

  test('collapses the rows an overlapping export shares with a statement', async () => {
    await ingestDocument(await writeDoc('june.pdf', 'a'), { readText, extract: extractWith(statement()) });
    const overlap = await ingestDocument(await writeDoc('export.pdf', 'b'),
      { readText, extract: extractWith(statement({ period: ['2026-06-01', '2026-06-20'] })) });
    expect(overlap).toMatchObject({ outcome: 'reconciled', inserted: 0, overlapping: 5 });
    expect(await FinanceTransaction.countDocuments()).toBe(5);
  });
});

describe('ledger questions', () => {
  beforeEach(async () => {
    await ingestDocument(await writeDoc('june.pdf'), { readText, extract: extractWith(statement()) });
  });

  test('totals matching transactions in cents', async () => {
    const result = await query.transactions({ q: 'cafe', from: '2026-06-01', to: '2026-06-30' });
    expect(result.totals).toEqual({ count: 2, inCents: 0, outCents: -900, netCents: -900 });
    expect(result.rows).toHaveLength(2);
    expect((await query.monthly({ account: 'eop' })).months)
      .toEqual([{ month: '2026-06', count: 3, inCents: 250000, outCents: -900, netCents: 249100 }]);
  });

  test('reports the latest closing balance per account', async () => {
    const { accounts } = await query.balances();
    expect(accounts.map((a) => [a.code, a.balanceCents, a.asOf]))
      .toEqual([['EOP', 349100, '2026-06-30'], ['MC1', 1494277, '2026-06-30']]);
    await expect(query.transactions({ from: '2026-13-01x' })).rejects.toMatchObject({ code: 'FINANCE_QUERY_INVALID' });
  });
});

describe('finance inbox', () => {
  test('archives reconciled files, sets aside reviews and leaves deferred files for later', async () => {
    const inbox = path.join(tmp, 'inbox');
    const archive = path.join(tmp, 'archive');
    await fs.mkdir(inbox);
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf', 'notes.txt']) await fs.writeFile(path.join(inbox, name), name);
    const outcomes = {
      'a.pdf': async (file) => ingestDocument(file, { readText, extract: extractWith(statement()) }),
      'b.pdf': async () => ({ outcome: 'needs_review', problems: ['x'] }),
      'c.pdf': async () => { throw Object.assign(new Error('busy'), { status: 503 }); }
    };
    const service = createFinanceInbox({
      env: { FINANCE_INBOX_PATH: inbox, FINANCE_ARCHIVE_PATH: archive },
      ingest: (file) => outcomes[path.basename(file)](file),
      logger: { warn: () => {} }
    });
    const { results } = await service.scanOnce();
    expect(results.map((r) => r.outcome)).toEqual(['reconciled', 'needs_review', 'deferred']);
    expect(await fs.readdir(path.join(archive, '2026'))).toEqual(['a.pdf']);
    expect(await fs.readdir(path.join(inbox, 'a-verifier'))).toEqual(['b.pdf']);
    expect((await fs.readdir(inbox)).sort()).toEqual(['a-verifier', 'c.pdf', 'notes.txt']);
    expect((await FinanceStatement.findOne().lean()).archivePath).toBe(path.join(archive, '2026', 'a.pdf'));
  });

  test('stays off without absolute paths', () => {
    expect(createFinanceInbox({ env: { FINANCE_INBOX_PATH: 'relative' } }).settings.enabled).toBe(false);
  });
});

describe('finance routes', () => {
  const express = require('express');
  const request = require('supertest');
  const createFinanceRoutes = require('../../routes/finance');

  test('answers ledger questions and refuses a scan while the inbox is off', async () => {
    await ingestDocument(await writeDoc('june.pdf'), { readText, extract: extractWith(statement()) });
    const off = createFinanceInbox({ env: {} });
    const app = express().use('/api/finance', express.json(), createFinanceRoutes({ inbox: () => off }));

    const totals = await request(app).get('/api/finance/transactions').query({ q: 'paie' });
    expect(totals.status).toBe(200);
    expect(totals.body.data.totals).toMatchObject({ count: 1, netCents: 250000 });
    expect((await request(app).get('/api/finance/transactions').query({ to: 'yesterday' })).body)
      .toMatchObject({ status: 'error', code: 'FINANCE_QUERY_INVALID' });
    expect((await request(app).get('/api/finance/statements')).body.data.statements).toHaveLength(1);
    expect((await request(app).post('/api/finance/inbox/scan')).status).toBe(409);
  });
});

describe('finance page', () => {
  test('ranks where the money goes by description', async () => {
    await ingestDocument(await writeDoc('june.pdf'), { readText, extract: extractWith(statement()) });
    const { merchants } = await query.merchants({ account: 'EOP' });
    expect(merchants).toEqual([{ description: 'CAFE DU COIN', count: 2, outCents: -900 }]);
  });

  test('renders the page shell and mounts the API and page together', async () => {
    const ejs = require('ejs');
    const html = await ejs.renderFile(path.join(__dirname, '../../views/pages/finance.ejs'), {});
    for (const id of ['financeBalances', 'monthlyChart', 'monthlyTable', 'financeMerchants', 'financeSearch', 'statementsTable']) {
      expect(html).toContain(`id="${id}"`);
    }
    const calls = [];
    const fakeApp = { use: (...args) => calls.push(['use', args[0]]), get: (...args) => calls.push(['get', args[0]]) };
    require('../../routes/finance').mount(fakeApp, (_req, _res, next) => next());
    expect(calls).toEqual([['use', '/api/finance'], ['get', '/finance']]);
  });
});

describe('categories taught by the owner', () => {
  beforeEach(async () => {
    await FinanceRule.syncIndexes();
    await ingestDocument(await writeDoc('june.pdf'), { readText, extract: extractWith(statement()) });
  });

  test('lists what is not categorized yet, largest amounts first', async () => {
    const result = await categories.uncategorized({ limit: 2 });
    expect(result).toMatchObject({ remainingTransactions: 5, remainingDescriptions: 4 });
    expect(result.descriptions.map((d) => d.suggestedPattern)).toEqual(['paie employeur', 'avance au compte eop']);
    expect(result.descriptions[0]).toMatchObject({ count: 1, totalCents: 250000, accounts: ['EOP'] });
  });

  test('a rule categorizes past rows, the longest pattern wins, and totals follow', async () => {
    const saved = await categories.saveRules([
      { pattern: 'Café', category: 'restaurants', tags: ['Matin', 'matin'] },
      { pattern: 'cafe du coin', category: 'Loisirs', tags: ['Olivier', 'partageable'] }
    ]);
    expect(saved.saved).toEqual([
      { pattern: 'cafe', category: 'Restaurants', tags: ['matin'], transactions: 0 },
      { pattern: 'cafe du coin', category: 'Loisirs', tags: ['olivier', 'partageable'], transactions: 2 }
    ]);
    expect((await query.transactions({ tag: 'olivier' })).totals).toMatchObject({ count: 2, outCents: -900 });
    const byCategory = (await query.byCategory({ account: 'EOP' })).categories;
    expect(byCategory).toEqual([
      { category: 'Loisirs', count: 2, inCents: 0, outCents: -900, netCents: -900 },
      { category: null, count: 1, inCents: 250000, outCents: 0, netCents: 250000 }
    ]);
    expect((await query.monthly({ account: 'EOP', excludeCategory: 'Loisirs' })).months[0].count).toBe(1);

    const rule = (await categories.listRules()).rules.find((r) => r.pattern === 'cafe du coin');
    expect(await categories.deleteRule(rule.id)).toMatchObject({ deleted: 'cafe du coin', transactionsUpdated: 2 });
    expect((await query.transactions({ category: 'Restaurants' })).totals.count).toBe(2);
  });

  test('new statements are categorized at ingestion and bad rules are refused', async () => {
    await categories.saveRules({ pattern: 'paie', category: 'Revenus' });
    await Promise.all([FinanceStatement.deleteMany({}), FinanceTransaction.deleteMany({})]);
    const fresh = await ingestDocument(await writeDoc('july.pdf', 'july'), { readText,
      extract: extractWith(statement({ period: ['2026-07-01', '2026-07-31'] })) });
    expect(fresh.inserted).toBe(5);
    expect((await query.transactions({ category: 'Revenus' })).totals.count).toBe(1);
    await expect(categories.saveRules({ pattern: 'ab', category: 'Revenus' })).rejects.toMatchObject({ code: 'FINANCE_CATEGORY_INVALID' });
    await expect(categories.saveRules({ pattern: 'dojo', category: 'Karaté' })).rejects.toThrow(/category must be one of/);
  });
});

describe('history, insights and export', () => {
  const analysis = require('../../src/services/finance/financeInsights');
  const { exportCsv, amount } = require('../../src/services/finance/financeExport');

  function month(period, rows) {
    let balance = 100000;
    const tx = rows.map(([date, description, cents]) => {
      balance += cents;
      return { date, description, amount_cents: cents, balance_after_cents: balance };
    });
    return { issuer: 'Caisse Exemple', account_last4: '0000', period_start: period[0], period_end: period[1],
      accounts: [{ code: 'EOP', opening_cents: 100000, closing_cents: balance, transactions: tx }] };
  }

  beforeEach(async () => {
    const plan = [
      ['2025-01', [['2025-01-02', 'PAIE EMPLOYEUR', 300000], ['2025-01-05', 'NETFLIX', -1799], ['2025-01-09', 'DOJO XYZ', -14900]]],
      ['2025-02', [['2025-02-02', 'PAIE EMPLOYEUR', 300000], ['2025-02-05', 'NETFLIX', -1799], ['2025-02-09', 'EPICERIE', -40000]]],
      ['2025-03', [['2025-03-02', 'PAIE EMPLOYEUR', 300000], ['2025-03-05', 'NETFLIX', -1799], ['2025-03-09', 'DOJO XYZ', -14900]]],
      ['2026-01', [['2026-01-02', 'PAIE EMPLOYEUR', 310000], ['2026-01-05', 'NETFLIX', -1999], ['2026-01-20', 'VIREMENT A EPARGNE', -50000]]]
    ];
    for (const [ym, rows] of plan) {
      await ingestDocument(await writeDoc(`${ym}.pdf`, ym), { readText,
        extract: extractWith(month([`${ym}-01`, `${ym}-28`], rows)) });
    }
    await categories.saveRules([
      { pattern: 'dojo', category: 'Enfants et activités', tags: ['karate'] },
      { pattern: 'virement a epargne', category: 'Virements internes' }
    ]);
  });

  test('totals each year, for everything or one tag', async () => {
    expect((await analysis.yearly({ tag: 'karate' })).years)
      .toEqual([{ year: '2025', count: 2, inCents: 0, outCents: -29800, netCents: -29800, firstDate: '2025-01-09', lastDate: '2025-03-09' }]);
    expect((await analysis.yearly({})).years.map((y) => [y.year, y.count])).toEqual([['2025', 9], ['2026', 3]]);
  });

  test('finds stable recurring charges and excludes internal transfers', async () => {
    const result = await analysis.insights({ months: 18 });
    expect(result.period).toEqual({ from: '2024-08-01', to: '2026-01-20', months: 18 });
    expect(result.recurring.map((r) => [r.description, r.months, r.monthlyCents])).toEqual([['NETFLIX', 4, -1799]]);
    expect(result.largeExpenses.map((e) => e.description)).not.toContain('VIREMENT A EPARGNE');
    const january = result.savings.find((s) => s.month === '2026-01');
    expect(january).toEqual({ month: '2026-01', inCents: 310000, outCents: -1999, netCents: 308001, savingsRatePercent: 99.4 });
  });

  test('exports an Excel-friendly CSV with totals', async () => {
    const { csv, fileName, rows } = await exportCsv({ tag: 'karate' });
    expect(rows).toBe(2);
    expect(fileName).toBe('finances_karate.csv');
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Date;Compte;Description;Catégorie;Tags;Montant');
    expect(lines[1]).toBe('2025-01-09;EOP;DOJO XYZ;Enfants et activités;karate;-149,00');
    expect(lines).toContain('Total sorties;;;;;-298,00');
    expect(amount(-5)).toBe('-0,05');
  });

  test('keeps a formula-like description inert in the CSV', async () => {
    await FinanceTransaction.updateOne({ date: '2025-03-09' }, { $set: { description: '=HYPERLINK("http://x";"go")' } });
    const { csv } = await exportCsv({ tag: 'karate' });
    expect(csv).toContain('\r\n2025-03-09;EOP;"\'=HYPERLINK(""http://x"";""go"")";Enfants et activités;karate;-149,00\r\n');
  });
});

describe('deterministic alerts', () => {
  const alerts = require('../../src/services/finance/financeAlerts');
  const env = { FINANCE_ALERT_LARGE_EXPENSE_CENTS: '100000', FINANCE_ALERT_MIN_BALANCE_CENTS: '400000', FINANCE_ALERT_STALE_DAYS: '45' };

  beforeEach(async () => {
    await FinanceAlert.syncIndexes();
    let balance = 500000;
    const rows = [['2026-06-02', 'PAIE EMPLOYEUR', 250000], ['2026-06-10', 'GARAGE XYZ', -180000], ['2026-06-20', 'VIREMENT A EPARGNE', -300000]]
      .map(([date, description, cents]) => { balance += cents; return { date, description, amount_cents: cents, balance_after_cents: balance }; });
    await ingestDocument(await writeDoc('june.pdf'), { readText, extract: extractWith({
      issuer: 'Caisse Exemple', account_last4: '0000', period_start: '2026-06-01', period_end: '2026-06-30',
      accounts: [{ code: 'EOP', opening_cents: 500000, closing_cents: balance, transactions: rows }] }) });
    await categories.saveRules({ pattern: 'virement a epargne', category: 'Virements internes' });
  });

  test('raises low balance, large expense and stale data, never transfers', async () => {
    const found = await alerts.evaluate({ env, now: new Date('2026-09-01T00:00:00Z') });
    expect(found.map((a) => a.kind).sort()).toEqual(['large_expense', 'low_balance', 'stale_data']);
    expect(found.find((a) => a.kind === 'large_expense').facts).toMatchObject({ description: 'GARAGE XYZ', amountCents: -180000 });
    expect(found.find((a) => a.kind === 'low_balance').facts).toMatchObject({ account: 'EOP', balanceCents: 270000, minimumCents: 400000 });
  });

  test('reports each fact once, then stays quiet', async () => {
    const first = await alerts.report({ env, now: new Date('2026-07-05T00:00:00Z') });
    expect(first.alerts.map((a) => a.kind).sort()).toEqual(['large_expense', 'low_balance']);
    expect((await alerts.report({ env, now: new Date('2026-07-06T00:00:00Z') })).alerts).toEqual([]);
    expect((await alerts.list({ includeAcknowledged: true })).alerts).toHaveLength(2);
  });

  test('flags a statement that needs review', async () => {
    await ingestDocument(await writeDoc('bad.pdf', 'bad'), { readText,
      extract: extractWith(...Array.from({ length: 4 }, () => statement({ trap: true }))) });
    const found = await alerts.evaluate({ env: {}, now: new Date('2026-07-05T00:00:00Z') });
    expect(found.map((a) => a.kind)).toContain('statement_needs_review');
  });
});

describe('statement coverage', () => {
  test('lists the months each statement series covers and the gaps between', async () => {
    for (const [name, period] of [['a.pdf', ['2026-01-01', '2026-01-31']], ['b.pdf', ['2026-04-01', '2026-04-30']]]) {
      await ingestDocument(await writeDoc(name, name), { readText, extract: extractWith(statement({ period })) });
    }
    expect((await query.coverage()).series).toEqual([
      { series: 'Caisse Exemple ···0000', first: '2026-01', last: '2026-04', months: 2, missing: ['2026-02', '2026-03'] }
    ]);
  });
});

describe('category suggestions', () => {
  const { suggest } = require('../../src/services/finance/financeSuggestions');

  test('proposes categories for the heaviest descriptions without saving anything', async () => {
    await ingestDocument(await writeDoc('june.pdf'), { readText, extract: extractWith(statement()) });
    let sent;
    const execute = async (body) => {
      sent = body;
      return { ok: true, status: 200, body: { message: { content: JSON.stringify({ suggestions: [
        { index: 0, label: 'PAIE EMPLOYEUR', category: 'Revenus', tags: ['Salaire'], confidence: 'haute' },
        { index: 1, label: 'Avance au compte EOP', category: 'Karaté', confidence: 'haute' },
        { index: 2, label: 'PAIE EMPLOYEUR', category: 'Restaurants', confidence: 'haute' }
      ] }) } } };
    };
    const { suggestions } = await suggest({ limit: 3 }, { execute });
    expect(sent).toMatchObject({ callerDetail: 'finance-suggestions', think: false, stream: false });
    expect(sent.messages[0].content).toContain('0. PAIE EMPLOYEUR');
    expect(sent.messages[0].content).not.toMatch(/250000|2 500/);
    expect(sent.messages[0].content).toMatch(/Paiement facture/);
    expect(suggestions.map((s) => [s.pattern, s.category, s.confidence, s.aligned])).toEqual([
      ['paie employeur', 'Revenus', 'haute', true],
      ['avance au compte eop', null, 'basse', true],
      ['cafe du coin', 'Restaurants', 'basse', false]
    ]);
    expect(await FinanceRule.countDocuments()).toBe(0);
  });
});

describe('financial plan and situation', () => {
  const FinancePlan = require('../../models/FinancePlan');
  const plan = require('../../src/services/finance/financePlan');

  beforeEach(async () => {
    await FinancePlan.deleteMany({});
    await ingestDocument(await writeDoc('june.pdf'), { readText, extract: extractWith(statement()) });
    await categories.saveRules([
      { pattern: 'paie employeur', category: 'Revenus' },
      { pattern: 'cafe du coin', category: 'Restaurants', tags: ['cafe'] },
      { pattern: 'avance au compte eop', category: 'Virements internes' }
    ]);
  });

  test('combines the plan with live ledger balances, budget actuals and net worth', async () => {
    await plan.savePlan({
      phase: 'Reconstruction', budget: [
        { label: 'Paye', category: 'Revenus', monthlyCents: 300000 },
        { label: 'Café', category: 'Restaurants', tag: 'cafe', monthlyCents: 500 },
        { label: 'Restos', category: 'Restaurants', monthlyCents: 10000 }
      ],
      debts: [{ name: 'Marge', accountCode: 'MC1', rateBp: 845, paymentCents: 0, status: 'Sain' },
        { name: 'Impôt', balanceCents: 50000, status: 'À payer' }],
      credit: [{ name: 'Marge', accountCode: 'MC1', limitCents: 1700000, status: 'Coussin' }],
      provisions: [{ name: 'Taxes', annualCents: 360000 }],
      assets: [{ name: 'Maison', valueCents: 50000000 }],
      taxRoom: [{ name: 'REER', roomCents: 1000000 }],
      openItems: [{ title: 'Relevé manquant', severity: 'warning' }], junk: 'dropped'
    });
    const s = await plan.situation({ months: 1 });
    expect(s.cash).toEqual({ balanceCents: 349100, asOf: '2026-06-30' });
    expect(s.debts.map((d) => [d.name, d.currentCents])).toEqual([['Marge', 1494277], ['Impôt', 50000]]);
    expect(s.totalDebtCents).toBe(1544277);
    expect(s.credit[0]).toMatchObject({ usedCents: 1494277, availableCents: 205723 });
    expect(s.netWorthCents).toBe(50000000 + 349100 - 1544277);
    expect(s.budget.map((b) => [b.label, b.actualMonthlyCents])).toEqual([['Paye', 250000], ['Café', 900], ['Restos', 0]]);
    expect(s.monthly).toEqual({ inCents: 250000, outCents: -900, netCents: 249100 });
    expect(s).toMatchObject({ provisionsMonthlyCents: 30000, taxRoomCents: 1000000, phase: 'Reconstruction' });
    expect(s.openItems).toEqual([{ title: 'Relevé manquant', detail: '', severity: 'warning' }]);
    expect(s.excludeTags).toEqual(['refi']);
    await categories.saveRules({ pattern: 'cafe du coin', category: 'Restaurants', tags: ['cafe', 'refi'] });
    expect((await plan.situation({ months: 1 })).monthly).toEqual({ inCents: 250000, outCents: 0, netCents: 250000 });
    expect((await query.monthly({ account: 'EOP', excludeTag: 'refi' })).months[0].count).toBe(1);
    expect((await query.transactions({ tag: 'cafe', excludeTag: 'refi' })).totals.count).toBe(0);
    expect((await plan.getPlan()).junk).toBeUndefined();
  });

  test('refuses a budget line outside the ledger categories or with non-integer cents', async () => {
    await expect(plan.savePlan({ budget: [{ category: 'Karaté', monthlyCents: 100 }] })).rejects.toMatchObject({ code: 'FINANCE_PLAN_INVALID' });
    await expect(plan.savePlan({ debts: [{ name: 'x', balanceCents: 12.5 }] })).rejects.toThrow(/integer cents/);
    expect((await plan.situation()).debts).toEqual([]);
  });
});

describe('simulations', () => {
  const sim = require('../../src/services/finance/financeSimulation');

  test('amortizes, applies extra money avalanche-style and reports interest saved', () => {
    const debts = [
      { name: 'Hypothèque', balanceCents: 10000000, rateBp: 370, paymentCents: 60000 },
      { name: 'Carte', balanceCents: 200000, rateBp: 2090, paymentCents: 10000 }
    ];
    const base = sim.runTrajectory(debts, { months: 24, start: '2026-07', extraMonthlyCents: 0, lumpSumCents: 0, lumpSumMonth: 0, annualBonusCents: 0 });
    const extra = sim.runTrajectory(debts, { months: 24, start: '2026-07', extraMonthlyCents: 20000, lumpSumCents: 0, lumpSumMonth: 0, annualBonusCents: 0 });
    expect(base.points).toHaveLength(25);
    expect(base.points[1].totalCents).toBe(10000000 + 30833 - 60000 + 200000 + 3483 - 10000);
    expect(extra.debts.find((d) => d.name === 'Carte').paidOffMonth < (base.debts.find((d) => d.name === 'Carte').paidOffMonth || '9999')).toBe(true);
    expect(extra.interestCents).toBeLessThan(base.interestCents);
    expect(sim.addMonths('2026-11', 3)).toBe('2027-02');
  });

  test('projects cash from the budget, provisions and one-off events', async () => {
    const FinancePlan = require('../../models/FinancePlan');
    await FinancePlan.deleteMany({});
    await ingestDocument(await writeDoc('june.pdf'), { readText, extract: extractWith(statement()) });
    await require('../../src/services/finance/financePlan').savePlan({
      budget: [{ category: 'Revenus', monthlyCents: 300000 }, { category: 'Épicerie', monthlyCents: 100000 }],
      provisions: [{ name: 'Taxes', annualCents: 120000 }]
    });
    const f = await sim.forecast({ months: 3, cushionCents: 700000, events: [{ month: '2026-08', amountCents: -50000, label: 'garage' }] });
    expect(f.startCashCents).toBe(349100);
    expect(f.rows.map((r) => [r.month, r.closingCents, r.belowCushion])).toEqual([
      ['2026-07', 349100 + 190000, true], ['2026-08', 349100 + 380000 - 50000, true], ['2026-09', 349100 + 570000 - 50000, false]
    ]);
    const history = await sim.balanceHistory();
    expect(history.series.find((s) => s.code === 'EOP').points).toEqual([{ date: '2026-06-30', balanceCents: 349100 }]);
    const cm = await sim.categoryMonths({ months: 3 });
    expect(cm.months).toEqual(['2026-04', '2026-05', '2026-06']);
  });
});

describe('decisions for individual transactions', () => {
  test('an owner decision beats rules, survives re-ingestion and can be cleared', async () => {
    await FinanceOverride.syncIndexes();
    await ingestDocument(await writeDoc('june.pdf', 'a'), { readText, extract: extractWith(statement()) });
    await categories.saveRules({ pattern: 'cafe du coin', category: 'Restaurants' });
    const [first] = (await query.transactions({ q: 'cafe' })).rows.sort((a, b) => a.id.localeCompare(b.id));
    expect(first.id).toMatch(/^[a-f0-9]{24}$/);
    await categories.setTransactions([{ id: first.id, category: 'Enfants et activités', tags: ['Olivier'] }]);
    const tagged = await query.transactions({ tag: 'olivier' });
    expect(tagged.rows).toHaveLength(1);
    expect(tagged.rows[0]).toMatchObject({ category: 'Enfants et activités', manual: true });

    await ingestDocument(await writeDoc('june-again.pdf', 'b'), { readText, extract: extractWith(statement()) });
    expect((await query.transactions({ tag: 'olivier' })).totals.count).toBe(1);

    const [again] = (await query.transactions({ tag: 'olivier' })).rows;
    await categories.setTransactions([{ id: again.id, category: null }]);
    expect((await query.transactions({ tag: 'olivier' })).totals.count).toBe(0);
    expect((await query.transactions({ category: 'Restaurants' })).totals.count).toBe(2);
    await expect(categories.setTransactions([{ id: 'nope', category: 'Loisirs' }])).rejects.toMatchObject({ code: 'FINANCE_CATEGORY_INVALID' });
  });
});

describe('scanned statements', () => {
  const { extractScannedStatement, merge } = require('../../src/services/finance/scannedStatement');

  test('reads a scan page by page, merges rows in order and reconciles', async () => {
    const pages = [
      { issuer: 'Banque Exemple Mastercard', account_last4: '1234', period_start: '2024-01-01', period_end: '2024-01-31',
        account_code: 'CARD', opening_cents: 10000, closing_cents: null, rows: [{ date: '2024-01-05', description: 'EPICERIE', amount_cents: 5000 }] },
      { issuer: null, account_code: 'CARD', opening_cents: null, closing_cents: 12000, rows: [{ date: '2024-01-20', description: 'PAIEMENT', amount_cents: -3000 }] }
    ];
    const calls = [];
    const execute = async (body) => {
      calls.push(body);
      return { ok: true, status: 200, body: { message: { content: JSON.stringify(pages[calls.length - 1]) } } };
    };
    const result = await extractScannedStatement('scan.pdf', { execute, render: async () => ['img1', 'img2'] });
    expect(result.problems).toEqual([]);
    expect(result.statement).toMatchObject({ issuer: 'Banque Exemple', accountLast4: '1234', periodEnd: '2024-01-31' });
    expect(result.statement.accounts[0]).toMatchObject({ code: 'CARD', openingCents: 10000, closingCents: 12000 });
    expect(calls[1].messages[0]).toMatchObject({ images: ['img2'] });
    expect(calls[0].callerDetail).toBe('finance-ingestion-scan');
    expect(merge([{ account_code: 'eop', rows: [] }]).accounts).toEqual([]);
  });

  test('ingestion sends a PDF without text layer to the image path', async () => {
    const extract = jest.fn();
    const extractScanned = jest.fn(async () => ({ statement: normalizeExtraction(statement()), problems: [], attempts: 1, model: 'vision' }));
    const result = await ingestDocument(await writeDoc('scan.pdf', 'scan'), { readText: async () => '  \n ', extract, extractScanned });
    expect(result.outcome).toBe('reconciled');
    expect(extract).not.toHaveBeenCalled();
    expect((await FinanceStatement.findOne().lean()).source).toBe('image');
  });
});

describe('separate ledgers', () => {
  test('corporate statements never mix with personal totals, balances or coverage', async () => {
    await ingestDocument(await writeDoc('perso.pdf', 'p'), { readText, extract: extractWith(statement()) });
    const corp = await ingestDocument(await writeDoc('corp.pdf', 'c'), { readText, ledger: 'corp', extract: extractWith(statement()) });
    expect(corp).toMatchObject({ outcome: 'reconciled', inserted: 5, overlapping: 0 });
    expect(corp.statementKey.startsWith('corp:')).toBe(true);
    expect((await query.transactions({})).totals.count).toBe(5);
    expect((await query.transactions({ ledger: 'corp' })).totals.count).toBe(5);
    expect((await query.balances()).accounts.map((a) => a.accountKey)).toEqual(['caisse-exemple|0000|EOP', 'caisse-exemple|0000|MC1']);
    expect((await query.balances({ ledger: 'corp' })).accounts.every((a) => a.accountKey.startsWith('corp:'))).toBe(true);
    expect((await query.statements({ ledger: 'corp' })).statements).toHaveLength(1);
    expect((await query.coverage()).series).toHaveLength(1);
  });

  test('the inbox corp folder feeds the corporate ledger and archives apart', async () => {
    const inbox = path.join(tmp, 'inbox');
    const archive = path.join(tmp, 'archive');
    await fs.mkdir(path.join(inbox, 'corp'), { recursive: true });
    await fs.writeFile(path.join(inbox, 'corp', 'c.pdf'), 'c');
    const seen = [];
    const service = createFinanceInbox({ env: { FINANCE_INBOX_PATH: inbox, FINANCE_ARCHIVE_PATH: archive },
      ingest: async (file, options) => { seen.push(options.ledger); return ingestDocument(file, { ...options, readText, extract: extractWith(statement()) }); },
      refreshAlerts: async () => {}, logger: { warn: () => {} } });
    const { results } = await service.scanOnce();
    expect(seen).toEqual(['corp']);
    expect(results[0]).toMatchObject({ outcome: 'reconciled', ledger: 'corp' });
    expect(await fs.readdir(path.join(archive, 'corp', '2026'))).toEqual(['c.pdf']);
  });
});

describe('money flow seen from the owner', () => {
  const { backfillFlow } = require('../../src/services/finance/financeIngestionService');

  function card() {
    return { issuer: 'Carte Test', account_last4: '9999', period_start: '2026-06-01', period_end: '2026-06-30',
      accounts: [{ code: 'CARD', opening_cents: 0, closing_cents: 12941, transactions: [
        { date: '2026-06-10', description: 'KARATE SPORTIF', amount_cents: 14941, balance_after_cents: 14941 },
        { date: '2026-06-20', description: 'PAIEMENT MERCI', amount_cents: -2000, balance_after_cents: 12941 }] }] };
  }

  test('a card purchase is money out and appears in spending totals', async () => {
    await ingestDocument(await writeDoc('card.pdf'), { readText, extract: extractWith(card()) });
    const karate = await query.transactions({ q: 'karate' });
    expect(karate.totals).toMatchObject({ count: 1, inCents: 0, outCents: -14941, netCents: -14941 });
    expect(karate.rows[0]).toMatchObject({ amountCents: 14941, flowCents: -14941 });
    expect((await query.merchants({})).merchants[0]).toMatchObject({ description: 'KARATE SPORTIF', outCents: -14941 });
    const { csv } = await require('../../src/services/finance/financeExport').exportCsv({ q: 'karate' });
    expect(csv).toContain(';-149,41');
  });

  test('backfills the flow of rows written before it existed', async () => {
    await ingestDocument(await writeDoc('card.pdf'), { readText, extract: extractWith(card()) });
    await FinanceTransaction.updateMany({}, { $set: { flowCents: null } });
    expect(await backfillFlow()).toEqual({ updated: 2 });
    const rows = await FinanceTransaction.find().sort({ date: 1 }).lean();
    expect(rows.map((r) => [r.amountCents, r.flowCents])).toEqual([[14941, -14941], [-2000, 2000]]);
    expect(await backfillFlow()).toEqual({ updated: 0 });
  });
});

describe('editing the plan', () => {
  const FinancePlan = require('../../models/FinancePlan');
  const plan = require('../../src/services/finance/financePlan');

  test('the page saves one section and the persona applies small operations', async () => {
    await FinancePlan.deleteMany({});
    await plan.savePlan({ openItems: [{ title: 'T2 corp', severity: 'critical' }, { title: 'Kia', severity: 'info' }],
      budget: [{ label: 'Karaté', category: 'Enfants et activités', tag: 'karate', monthlyCents: 14941 }] });
    const saved = await plan.saveSection('watch', [{ date: '15 déc.', what: 'Acomptes RQ', status: 'À vérifier' }]);
    expect(saved.watch).toHaveLength(1);
    expect(saved.openItems).toHaveLength(2);

    const result = await plan.applyOps([
      { op: 'remove', section: 'openItems', match: 't2 corp' },
      { op: 'update', section: 'budget', match: 'karaté', item: { monthlyCents: 16000 } },
      { op: 'add', section: 'milestones', item: { text: 'T2 corp payé', done: true } },
      { op: 'set', section: 'phase', value: 'Reconstruction' }
    ]);
    expect(result.applied.map((a) => a.op)).toEqual(['remove', 'update', 'add', 'set']);
    expect(result.plan.openItems.map((i) => i.title)).toEqual(['Kia']);
    expect(result.plan.budget[0].monthlyCents).toBe(16000);
    expect(result.plan.milestones).toEqual([{ text: 'T2 corp payé', done: true }]);
    expect(result.plan.phase).toBe('Reconstruction');
    await expect(plan.applyOps({ op: 'update', section: 'budget', match: 'hockey', item: {} })).rejects.toThrow(/no budget item matches/);
    await expect(plan.saveSection('secrets', [])).rejects.toMatchObject({ code: 'FINANCE_PLAN_INVALID' });
  });
});
