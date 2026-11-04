'use strict';

// The HTTP reader states the book and filters it actually passes to the domain
// service. Unknown selectors fail instead of silently widening a question.
const FILTERS = ['account', 'from', 'to', 'q', 'category', 'tag', 'excludeCategory', 'excludeTag'];
const SPECS = {
  balances: [], statements: ['status'], coverage: ['account', 'from', 'to'], tags: [],
  transactions: [...FILTERS, 'limit'], monthly: FILTERS, yearly: FILTERS,
  merchants: [...FILTERS, 'limit'], categories: FILTERS,
  insights: [...FILTERS, 'months'], uncategorized: ['limit'], documents: ['minCents'],
  rules: [], goals: [], review: []
};
const LIMITS = { transactions: [100, 500], merchants: [10, 50], uncategorized: [15, 50] };
const LENGTHS = { account: 80, q: 80, category: 60, tag: 60, excludeCategory: 60, excludeTag: 500, status: 20, from: 10, to: 10 };
const invalid = message => Object.assign(new Error(message), { code: 'FINANCE_QUERY_INVALID', status: 400 });

function readScope(action, input = {}) {
  const supported = Object.hasOwn(SPECS, action) ? SPECS[action] : null;
  if (!supported) throw invalid('Unsupported finance question');
  const query = {};
  const ledger = input.ledger == null || input.ledger === '' ? 'perso' : input.ledger;
  if (typeof ledger !== 'string' || !['perso', 'corp'].includes(ledger)) throw invalid('ledger must be perso or corp');
  if (['goals', 'review'].includes(action) && ledger !== 'perso') throw invalid(`${action} is a personal-plan question`);
  for (const [key, value] of Object.entries(input)) {
    if (key === 'ledger' || value === undefined || value === null || value === '') continue;
    if (!supported.includes(key)) throw invalid(`${key} is not supported for ${action}`);
    if (['limit', 'months', 'minCents'].includes(key)) {
      if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) throw invalid(`${key} must be a positive integer`);
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1) throw invalid(`${key} must be a positive integer`);
      query[key] = number;
      continue;
    }
    if (typeof value !== 'string' || value.trim().length > LENGTHS[key]) throw invalid(`${key} must be a bounded string`);
    query[key] = value.trim();
    if (['from', 'to'].includes(key) && !require('./financeCompleteness').validDate(query[key])) throw invalid(`${key} must be a valid YYYY-MM-DD date`);
  }
  if (query.from && query.to && query.from > query.to) throw invalid('from must not be after to');
  if (query.status && !['reconciled', 'needs_review'].includes(query.status)) throw invalid('status must be reconciled or needs_review');
  if (query.account && !query.account.includes('|')) query.account = query.account.replace(/\s+/g, '').toUpperCase();
  if (LIMITS[action]) {
    const [fallback, maximum] = LIMITS[action];
    query.limit = Math.min(query.limit || fallback, maximum);
  }
  if (action === 'insights') query.months = Math.min(Math.max(query.months || 12, 3), 60);
  query.ledger = ledger;
  const scope = action === 'rules' ? { kind: 'shared', ledgers: ['perso', 'corp'] }
    : { kind: ['goals', 'review'].includes(action) ? 'personal' : 'ledger', ledger,
      filters: Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'ledger')) };
  return { query, scope };
}

module.exports = { readScope };
