'use strict';

// Categories and tags for the finance ledger. The owner teaches rules
// ("description contains X -> category, tags"); rules apply to every existing
// and future transaction, the longest matching pattern winning. Categories are
// a small fixed list so totals stay comparable; tags are free (activity,
// person, shareable...).

const FinanceRule = require('../../../models/FinanceRule');
const FinanceTransaction = require('../../../models/FinanceTransaction');
const FinanceOverride = require('../../../models/FinanceOverride');
const { ledgerFilter } = require('./ledgers');

const overrideKey = (row) => `${row.accountKey}|${row.date}|${row.fingerprint}|${row.occurrence}`;

const CATEGORIES = Object.freeze([
  'Revenus', 'Logement', 'Épicerie', 'Restaurants', 'Transport', 'Auto', 'Enfants et activités', 'Santé',
  'Abonnements', 'Assurances', 'Services publics', 'Magasinage', 'Loisirs', 'Dettes et intérêts', 'Impôts',
  'Épargne et placements', 'Frais bancaires', 'Dons et cadeaux', 'Virements internes', 'Retraits', 'Autres'
]);
const MAX_RULES_PER_CALL = 25;

class FinanceCategoryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FinanceCategoryError';
    this.code = 'FINANCE_CATEGORY_INVALID';
    this.status = 400;
  }
}

// Lowercase, accent-free, reference numbers dropped, spaces collapsed.
function descriptionKey(value) {
  return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\d{4,}/g, ' ').replace(/[^a-z0-9$&.'/-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanTag(value) {
  return descriptionKey(value).replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function cleanRule(input) {
  const pattern = descriptionKey(input?.pattern);
  if (pattern.length < 3 || pattern.length > 80) throw new FinanceCategoryError('pattern must be 3 to 80 characters of the description');
  const category = CATEGORIES.find((name) => descriptionKey(name) === descriptionKey(input?.category));
  if (!category) throw new FinanceCategoryError(`category must be one of: ${CATEGORIES.join(', ')}`);
  const tags = [...new Set((Array.isArray(input?.tags) ? input.tags : []).map(cleanTag).filter(Boolean))].slice(0, 8);
  return { pattern, category, tags };
}

function matchRule(rules, key) {
  let best = null;
  for (const rule of rules) {
    if (key.includes(rule.pattern) && (!best || rule.pattern.length > best.pattern.length)) best = rule;
  }
  return best;
}

// Recomputes category/tags for the given transactions (all by default).
async function applyRules(filter = {}) {
  const [rules, overrides] = await Promise.all([FinanceRule.find().lean(), FinanceOverride.find().lean()]);
  const manual = new Map(overrides.map((item) => [overrideKey(item), item]));
  let changed = 0;
  const winners = new Map();
  const cursor = FinanceTransaction.find(filter)
    .select('accountKey date fingerprint occurrence description category tags manual').lean().cursor();
  const ops = [];
  for await (const row of cursor) {
    const decided = manual.get(overrideKey(row));
    const rule = decided ? null : matchRule(rules, descriptionKey(row.description));
    if (rule) winners.set(rule.pattern, (winners.get(rule.pattern) || 0) + 1);
    const category = decided ? decided.category : rule ? rule.category : null;
    const tags = decided ? decided.tags : rule ? rule.tags : [];
    const isManual = Boolean(decided);
    if (row.category !== category || JSON.stringify(row.tags || []) !== JSON.stringify(tags) || Boolean(row.manual) !== isManual) {
      ops.push({ updateOne: { filter: { _id: row._id }, update: { $set: { category, tags, manual: isManual } } } });
    }
    if (ops.length >= 500) { changed += (await FinanceTransaction.bulkWrite(ops.splice(0))).modifiedCount; }
  }
  if (ops.length) changed += (await FinanceTransaction.bulkWrite(ops)).modifiedCount;
  return { changed, winners };
}

async function listRules() {
  const rules = await FinanceRule.find().sort({ category: 1, pattern: 1 }).lean();
  return { categories: CATEGORIES, rules: rules.map(({ _id, pattern, category, tags, createdBy, updatedAt }) => ({
    id: String(_id), pattern, category, tags, createdBy, updatedAt })) };
}

async function saveRules(input, { createdBy = 'owner' } = {}) {
  const list = Array.isArray(input) ? input : [input];
  if (!list.length || list.length > MAX_RULES_PER_CALL) throw new FinanceCategoryError(`send 1 to ${MAX_RULES_PER_CALL} rules`);
  const rules = list.map(cleanRule);
  for (const rule of rules) {
    await FinanceRule.updateOne({ pattern: rule.pattern }, { $set: { ...rule, createdBy } }, { upsert: true });
  }
  const { changed, winners } = await applyRules();
  return {
    saved: rules.map((rule) => ({ ...rule, transactions: winners.get(rule.pattern) || 0 })),
    transactionsUpdated: changed
  };
}

async function deleteRule(id) {
  const removed = await FinanceRule.findByIdAndDelete(String(id)).lean().catch(() => null);
  if (!removed) throw Object.assign(new FinanceCategoryError('rule not found'), { status: 404, code: 'FINANCE_RULE_NOT_FOUND' });
  return { deleted: removed.pattern, transactionsUpdated: (await applyRules()).changed };
}

// Owner decisions for individual transactions (by ledger id). category null
// removes the decision and the rules apply again.
async function setTransactions(items, { createdBy = 'owner' } = {}) {
  const list = Array.isArray(items) ? items : [items];
  if (!list.length || list.length > 100) throw new FinanceCategoryError('send 1 to 100 transactions');
  const results = [];
  for (const item of list) {
    const id = String(item?.id || '');
    if (!/^[a-f0-9]{24}$/.test(id)) throw new FinanceCategoryError('each transaction needs its ledger id');
    const row = await FinanceTransaction.findById(id).select('accountKey date fingerprint occurrence description').lean();
    if (!row) throw Object.assign(new FinanceCategoryError(`transaction ${id} not found`), { status: 404, code: 'FINANCE_TRANSACTION_NOT_FOUND' });
    const key = { accountKey: row.accountKey, date: row.date, fingerprint: row.fingerprint, occurrence: row.occurrence };
    if (item.category === null || item.category === '') {
      await FinanceOverride.deleteOne(key);
      results.push({ id, description: row.description, category: null, cleared: true });
      continue;
    }
    const { category, tags } = cleanRule({ pattern: 'xxx', category: item.category, tags: item.tags });
    await FinanceOverride.updateOne(key, { $set: { ...key, category, tags, createdBy } }, { upsert: true });
    results.push({ id, description: row.description, category, tags });
  }
  const { changed } = await applyRules({ _id: { $in: list.map((item) => String(item.id)) } });
  return { saved: results, transactionsUpdated: changed };
}

// Descriptions nobody has categorized yet, biggest amounts first, so the
// persona asks about what matters.
async function uncategorized({ limit, ledger } = {}) {
  const max = Math.min(Math.max(Number.parseInt(limit, 10) || 15, 1), 50);
  const rows = await FinanceTransaction.find({ category: null, ...ledgerFilter(ledger) }).select('description date flowCents accountCode').lean();
  const groups = new Map();
  for (const row of rows) {
    const key = descriptionKey(row.description);
    const group = groups.get(key) || { description: row.description, suggestedPattern: key, count: 0, totalCents: 0,
      firstDate: row.date, lastDate: row.date, accounts: new Set() };
    group.count += 1;
    group.totalCents += row.flowCents;
    group.firstDate = row.date < group.firstDate ? row.date : group.firstDate;
    group.lastDate = row.date > group.lastDate ? row.date : group.lastDate;
    group.accounts.add(row.accountCode);
    groups.set(key, group);
  }
  const sorted = [...groups.values()].sort((a, b) => Math.abs(b.totalCents) - Math.abs(a.totalCents));
  return {
    remainingTransactions: rows.length,
    remainingDescriptions: sorted.length,
    descriptions: sorted.slice(0, max).map((group) => ({ ...group, accounts: [...group.accounts].sort() }))
  };
}

module.exports = { CATEGORIES, descriptionKey, cleanRule, matchRule, applyRules, listRules, saveRules, deleteRule, uncategorized,
  setTransactions, FinanceCategoryError };
