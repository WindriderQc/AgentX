'use strict';

// Financial plan (intent) combined with the ledger (facts) into the owner's
// situation: cash, debts with live balances, credit available, assets, net
// worth, recent monthly net, budget vs actual and annual provisions.

const FinancePlan = require('../../../models/FinancePlan');
const FinanceTransaction = require('../../../models/FinanceTransaction');
const { balances } = require('./financeQueryService');
const { CATEGORIES } = require('./financeCategories');
const { ledgerFilter } = require('./ledgers');
const { payrollCoverage } = require('./financeCompleteness');

const PERSO = ledgerFilter('perso');

const TRANSFERS = 'Virements internes';

class FinancePlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FinancePlanError';
    this.code = 'FINANCE_PLAN_INVALID';
    this.status = 400;
  }
}

function text(value, max = 160) {
  return String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cents(value, field, { optional = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (optional) return null;
    throw new FinancePlanError(`${field} is required`);
  }
  if (!Number.isSafeInteger(value)) throw new FinancePlanError(`${field} must be integer cents`);
  return value;
}

function list(value, field, max, map) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new FinancePlanError(`${field} must be a list of at most ${max}`);
  return value.map((item, index) => map(item || {}, `${field}[${index}]`));
}

// Optional structured deadline: `dueDate` (YYYY-MM-DD) and `recurrence`. Core alerts
// from dueDate; an item stays on the alerts until its dueDate is moved forward.
const RECURRENCES = ['monthly', 'quarterly', 'yearly'];
const GOAL_SOURCES = ['account', 'asset', 'tag'];

function goalSource(value, field) {
  if (!GOAL_SOURCES.includes(value)) throw new FinancePlanError(`${field} must be one of ${GOAL_SOURCES.join(', ')}`);
  return value;
}

// `payment` items are worded "à payer" in the brief; any other item keeps a neutral wording.
const ITEM_KINDS = ['payment', 'task'];

function dueDate(value, field) {
  const date = String(value ?? '').trim();
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new FinancePlanError(`${field} must be a YYYY-MM-DD date`);
  }
  return date;
}

function recurrence(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (!RECURRENCES.includes(value)) throw new FinancePlanError(`${field} must be one of ${RECURRENCES.join(', ')}`);
  return value;
}

function last4Field(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d{4}$/.test(String(value))) throw new FinancePlanError(`${field} must be exactly four digits`);
  return String(value);
}

function ledgerField(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (!['perso', 'corp'].includes(value)) throw new FinancePlanError(`${field} must be perso or corp`);
  return value;
}

function accountCode(value) {
  const code = text(value, 16).replace(/\s+/g, '').toUpperCase();
  return code || null;
}

// Validates a whole plan; unknown fields are dropped.
function cleanPlan(input = {}) {
  return {
    phase: text(input.phase, 600),
    // Tags of exceptional rows (e.g. a refinancing) kept out of averages and budget actuals.
    excludeTags: Array.isArray(input.excludeTags)
      ? [...new Set(input.excludeTags.map((tag) => text(tag, 40).toLowerCase()).filter(Boolean))].slice(0, 10) : ['refi'],
    budget: list(input.budget, 'budget', 80, (line, field) => {
      const category = CATEGORIES.find((name) => name === text(line.category, 60)) || null;
      if (!category) throw new FinancePlanError(`${field}.category must be one of the ledger categories`);
      return { label: text(line.label, 80) || category, category, tag: text(line.tag, 40).toLowerCase() || null,
        monthlyCents: cents(line.monthlyCents, `${field}.monthlyCents`, { optional: false }) };
    }),
    debts: list(input.debts, 'debts', 40, (debt, field) => ({
      name: text(debt.name, 80), accountCode: accountCode(debt.accountCode), issuer: text(debt.issuer, 40) || null,
      balanceCents: cents(debt.balanceCents, `${field}.balanceCents`), rateBp: cents(debt.rateBp, `${field}.rateBp`),
      paymentCents: cents(debt.paymentCents, `${field}.paymentCents`), endDate: text(debt.endDate, 10) || null,
      status: text(debt.status, 120)
    })),
    credit: list(input.credit, 'credit', 40, (line, field) => ({
      name: text(line.name, 80), accountCode: accountCode(line.accountCode), issuer: text(line.issuer, 40) || null,
      limitCents: cents(line.limitCents, `${field}.limitCents`), balanceCents: cents(line.balanceCents, `${field}.balanceCents`),
      status: text(line.status, 120)
    })),
    provisions: list(input.provisions, 'provisions', 40, (item, field) => ({
      name: text(item.name, 80), annualCents: cents(item.annualCents, `${field}.annualCents`, { optional: false }),
      due: text(item.due, 40), note: text(item.note, 200)
    })),
    assets: list(input.assets, 'assets', 40, (asset, field) => ({
      name: text(asset.name, 80), valueCents: cents(asset.valueCents, `${field}.valueCents`, { optional: false }),
      asOf: text(asset.asOf, 10) || null, note: text(asset.note, 200)
    })),
    milestones: list(input.milestones, 'milestones', 60, (item) => ({ text: text(item.text, 240), done: item.done === true })),
    openItems: list(input.openItems, 'openItems', 40, (item, field) => ({ title: text(item.title, 120), detail: text(item.detail, 400),
      severity: ['critical', 'warning', 'info'].includes(item.severity) ? item.severity : 'info', briefLabel: text(item.briefLabel, 60) || null,
      kind: ITEM_KINDS.includes(item.kind) ? item.kind : null,
      dueDate: dueDate(item.dueDate, `${field}.dueDate`), recurrence: recurrence(item.recurrence, `${field}.recurrence`) })),
    allocations: list(input.allocations, 'allocations', 20, (item, field) => ({ step: text(item.step, 120),
      amountCents: cents(item.amountCents, `${field}.amountCents`), amountText: text(item.amountText, 60),
      status: text(item.status, 30), effect: text(item.effect, 240) })),
    watch: list(input.watch, 'watch', 40, (item, field) => ({ date: text(item.date, 40), what: text(item.what, 300), status: text(item.status, 30),
      briefLabel: text(item.briefLabel, 60) || null, kind: ITEM_KINDS.includes(item.kind) ? item.kind : null,
      dueDate: dueDate(item.dueDate, `${field}.dueDate`), recurrence: recurrence(item.recurrence, `${field}.recurrence`) })),
    // Statement series (issuer and last four) named for the alerts; `closed` series raise no stale or dormant alert.
    // A goal's progress comes from a ledger account, a plan asset, or the sum of a tag; `ref` names it.
    goals: list(input.goals, 'goals', 20, (item, field) => ({ name: text(item.name, 80), targetCents: cents(item.targetCents, `${field}.targetCents`, { optional: false }),
      targetDate: dueDate(item.targetDate, `${field}.targetDate`), priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
      source: { kind: goalSource(item.source?.kind, `${field}.source.kind`), ref: text(item.source?.ref, 80) } })),
    // last4 and ledger let a Secretary statement find its series: the issuer has no last four in the ledger.
    seriesStatus: list(input.seriesStatus, 'seriesStatus', 60, (item, field) => ({ series: text(item.series, 80), label: text(item.label, 80),
      closed: item.closed === true, note: text(item.note, 200), last4: last4Field(item.last4, `${field}.last4`),
      ledger: ledgerField(item.ledger, `${field}.ledger`) })),
    taxRoom: list(input.taxRoom, 'taxRoom', 10, (item, field) => ({ name: text(item.name, 40),
      roomCents: cents(item.roomCents, `${field}.roomCents`, { optional: false }), asOf: text(item.asOf, 10) || null }))
  };
}

async function getPlan() {
  const plan = await FinancePlan.findById('plan').lean();
  return plan ? { ...cleanPlan(plan), updatedAt: plan.updatedAt } : { ...cleanPlan({}), updatedAt: null };
}

async function savePlan(input) {
  const plan = cleanPlan(input);
  await FinancePlan.updateOne({ _id: 'plan' }, { $set: plan }, { upsert: true });
  return getPlan();
}

const SECTIONS = ['phase', 'excludeTags', 'budget', 'debts', 'credit', 'provisions', 'assets', 'milestones',
  'openItems', 'allocations', 'watch', 'taxRoom', 'seriesStatus', 'goals'];

// Replaces one section (the page editor saves a whole table at once).
async function saveSection(section, value) {
  if (!SECTIONS.includes(section)) throw new FinancePlanError(`unknown plan section: ${section}`);
  const current = await getPlan();
  return savePlan({ ...current, [section]: value });
}

const RECURRENCE_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };

// Moves a YYYY-MM-DD date by whole months. A last-day date stays on the last day of the target month.
function addMonths(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const isLastDay = new Date(Date.UTC(year, month, 0)).getUTCDate() === day;
  return new Date(Date.UTC(y, m, isLastDay ? lastDay : Math.min(day, lastDay))).toISOString().slice(0, 10);
}

// Small edits for the finance persona: add, update (by index or by a text
// match on the first text field) or remove items, or set a scalar section.
async function applyOps(ops) {
  const list = Array.isArray(ops) ? ops : [ops];
  if (!list.length || list.length > 20) throw new FinancePlanError('send 1 to 20 plan operations');
  const plan = await getPlan();
  const applied = [];
  for (const op of list) {
    const section = String(op?.section || '');
    if (!SECTIONS.includes(section)) throw new FinancePlanError(`unknown plan section: ${section}`);
    if (!Array.isArray(plan[section])) {
      if (op.op !== 'set') throw new FinancePlanError(`${section} only supports set`);
      plan[section] = op.value;
      applied.push({ op: 'set', section });
      continue;
    }
    const items = plan[section];
    const find = () => {
      if (Number.isInteger(op.index)) return op.index;
      const needle = String(op.match || '').toLowerCase();
      return needle ? items.findIndex((item) => Object.values(item).some((v) => typeof v === 'string' && v.toLowerCase().includes(needle))) : -1;
    };
    if (op.op === 'add') {
      items.push(op.item || {});
      applied.push({ op: 'add', section, index: items.length - 1 });
    } else if (op.op === 'update' || op.op === 'remove') {
      const index = find();
      if (index < 0 || index >= items.length) throw new FinancePlanError(`no ${section} item matches ${op.match ?? op.index}`);
      if (op.op === 'remove') items.splice(index, 1); else items[index] = { ...items[index], ...(op.item || {}) };
      applied.push({ op: op.op, section, index });
    } else if (op.op === 'done') {
      // Settled: a recurring item moves to its next dueDate; any other item is removed and kept as a settled milestone.
      if (!['watch', 'openItems'].includes(section)) throw new FinancePlanError(`${section} does not take done`);
      const index = find();
      if (index < 0 || index >= items.length) throw new FinancePlanError(`no ${section} item matches ${op.match ?? op.index}`);
      const item = items[index];
      if (item.recurrence) {
        if (!item.dueDate) throw new FinancePlanError(`${section} item with a recurrence needs a dueDate`);
        items[index] = { ...item, dueDate: addMonths(item.dueDate, RECURRENCE_MONTHS[item.recurrence]) };
      } else {
        items.splice(index, 1);
        plan.milestones.push({ text: `${item.what || item.title} — réglé le ${new Date().toISOString().slice(0, 10)}`, done: true });
      }
      applied.push({ op: 'done', section, index });
    } else {
      throw new FinancePlanError('op must be add, update, remove, set or done');
    }
  }
  const saved = await savePlan(plan);
  return { applied, plan: saved };
}

// The newest month counts only once it is complete: a month a few days in
// would be divided like a full one and make the averages look too low.
function lastFullMonth(latestDate) {
  const [year, month, day] = latestDate.slice(0, 10).split('-').map(Number);
  const monthEnd = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= monthEnd ? latestDate : new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
}

function lastMonths(latestDate, count) {
  const [year, month] = latestDate.slice(0, 7).split('-').map(Number);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(year, month - 1 - (count - 1 - i), 1)).toISOString().slice(0, 7));
}

// Plan + ledger. `months` = window for actual monthly averages (default 3).
async function situation({ months } = {}) {
  const window = Math.min(Math.max(Number.parseInt(months, 10) || 3, 1), 24);
  const [plan, { accounts }] = await Promise.all([getPlan(), balances({ ledger: 'perso' })]);
  // Several cards share the code CARD: an optional issuer word picks the right one.
  const findAccount = (code, issuer) => (code ? accounts.filter((account) => account.code === code
    && (!issuer || account.issuer.toLowerCase().includes(issuer.toLowerCase())))
    .sort((a, b) => b.asOf.localeCompare(a.asOf))[0] || null : null);

  const debts = plan.debts.map((debt) => {
    const account = findAccount(debt.accountCode, debt.issuer);
    // A liability's positive balance is owed; a credit balance (overpaid) is not debt.
    const owed = account ? Math.max(account.balanceCents, 0) : null;
    return { ...debt, liveBalanceCents: owed, asOf: account?.asOf || null, currentCents: account ? owed : debt.balanceCents };
  });
  const credit = plan.credit.map((line) => {
    const account = findAccount(line.accountCode, line.issuer);
    const used = account ? Math.max(account.balanceCents, 0) : line.balanceCents;
    return { ...line, usedCents: used, availableCents: line.limitCents != null && used != null ? line.limitCents - used : null,
      asOf: account?.asOf || null };
  });

  const latest = await FinanceTransaction.findOne(PERSO).sort({ date: -1 }).select('date').lean();
  // A statement ending on a month's last day completes that month even when its last
  // transaction is earlier; otherwise the newest transaction's month is partial.
  const statementEnd = accounts.map((account) => account.asOf).filter(Boolean).sort().at(-1) || '';
  const monthsWindow = latest ? lastMonths(lastFullMonth(statementEnd > latest.date ? statementEnd : latest.date), window) : [];
  const fetched = monthsWindow.length ? await FinanceTransaction.find({
    ...PERSO, date: { $gte: `${monthsWindow[0]}-01`, $lte: `${monthsWindow.at(-1)}-31` }, category: { $ne: TRANSFERS },
    ...(plan.excludeTags.length && { tags: { $nin: plan.excludeTags } })
  }).select('date flowCents category tags').lean() : [];
  // Averages count only months the payroll statements fully cover; the others are listed apart.
  const payroll = await payrollCoverage({ ledger: 'perso' });
  const averageMonths = monthsWindow.filter((month) => payroll.isComplete(month));
  const counted = new Set(averageMonths);
  const rows = fetched.filter((row) => counted.has(row.date.slice(0, 7)));

  let inCents = 0;
  let outCents = 0;
  for (const row of rows) { if (row.flowCents > 0) inCents += row.flowCents; else outCents += row.flowCents; }
  const perMonth = (total) => (averageMonths.length ? Math.round(total / averageMonths.length) : 0);

  // Budget lines grouped by (category, tag): a tagged group takes its tagged
  // rows; the untagged group of a category takes the rest, so nothing counts twice.
  const groups = new Map();
  for (const line of plan.budget) {
    const key = `${line.category}|${line.tag || ''}`;
    const group = groups.get(key) || { category: line.category, tag: line.tag, labels: [], monthlyCents: 0 };
    group.labels.push(line.label);
    group.monthlyCents += line.monthlyCents;
    groups.set(key, group);
  }
  const taggedIn = (category) => [...groups.values()].filter((g) => g.category === category && g.tag).map((g) => g.tag);
  const budget = [...groups.values()].map((group) => {
    const others = group.tag ? [] : taggedIn(group.category);
    const matches = rows.filter((row) => row.category === group.category
      && (group.tag ? (row.tags || []).includes(group.tag) : !(row.tags || []).some((tag) => others.includes(tag))));
    const total = matches.reduce((sum, row) => sum + (group.category === 'Revenus'
      ? Math.max(row.flowCents, 0) : Math.max(-row.flowCents, 0)), 0);
    const actual = perMonth(total);
    return { label: group.labels.join(' + '), category: group.category, tag: group.tag,
      monthlyCents: group.monthlyCents, actualMonthlyCents: actual, gapCents: actual - group.monthlyCents };
  });

  const cash = findAccount('EOP');
  const totalDebtCents = debts.reduce((sum, debt) => sum + (debt.currentCents || 0), 0);
  const totalAssetsCents = plan.assets.reduce((sum, asset) => sum + asset.valueCents, 0) + (cash ? Math.max(cash.balanceCents, 0) : 0);
  return {
    phase: plan.phase,
    excludeTags: plan.excludeTags,
    planUpdatedAt: plan.updatedAt,
    window: { months: monthsWindow, averageMonths, incompleteMonths: monthsWindow.filter((m) => !counted.has(m)),
      from: monthsWindow[0] || null, to: latest?.date || null, dataAsOf: payroll.asOf },
    cash: cash ? { balanceCents: cash.balanceCents, asOf: cash.asOf } : null,
    monthly: { inCents: perMonth(inCents), outCents: perMonth(outCents), netCents: perMonth(inCents + outCents) },
    totalDebtCents,
    creditAvailableCents: credit.reduce((sum, line) => sum + (line.availableCents || 0), 0),
    totalAssetsCents,
    netWorthCents: totalAssetsCents - totalDebtCents,
    debts,
    credit,
    budget,
    budgetTotals: {
      monthlyCents: budget.filter((l) => l.category !== 'Revenus').reduce((s, l) => s + l.monthlyCents, 0),
      actualMonthlyCents: budget.filter((l) => l.category !== 'Revenus').reduce((s, l) => s + l.actualMonthlyCents, 0)
    },
    provisions: plan.provisions,
    provisionsMonthlyCents: Math.round(plan.provisions.reduce((sum, item) => sum + item.annualCents, 0) / 12),
    assets: plan.assets,
    milestones: plan.milestones,
    openItems: plan.openItems,
    allocations: plan.allocations,
    watch: plan.watch,
    taxRoom: plan.taxRoom,
    seriesStatus: plan.seriesStatus,
    taxRoomCents: plan.taxRoom.reduce((sum, item) => sum + item.roomCents, 0)
  };
}

module.exports = { getPlan, savePlan, saveSection, applyOps, situation, cleanPlan, FinancePlanError, SECTIONS };

require('./financeAccess').guard(module.exports, ['getPlan', 'savePlan', 'saveSection', 'applyOps', 'situation']);
