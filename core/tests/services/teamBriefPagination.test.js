'use strict';
const mongoose = require('mongoose');
const Journal = require('../../models/MailJournalEntry');
const Alert = require('../../models/FinanceAlert');
const Statement = require('../../models/FinanceStatement');
const journal = require('../../src/services/mailJournalService');
const alerts = require('../../src/services/finance/financeAlerts');
const finance = require('../../src/services/finance/financeQueryService');
const { brief } = require('../../src/services/teamBriefService');
const now = () => new Date('2026-03-15T12:00:00Z');

beforeEach(async () => {
  await Promise.all([Journal.deleteMany({}), Alert.deleteMany({}), Statement.deleteMany({}),
    mongoose.connection.collection('emailactions').deleteMany({})]);
});

async function allPages(read, key, total, limit) {
  let offset = 0;
  const ids = [];
  do {
    const page = await read({ limit, offset });
    expect(page.total).toBe(total);
    expect(page.pagination).toMatchObject({ offset, limit, returned: page[key].length, consistency: 'live' });
    ids.push(...page[key].map(row => row.id || row.threadId));
    expect(page.truncated).toBe(page.pagination.hasMore);
    offset = page.pagination.nextOffset;
  } while (offset !== null);
  expect(ids).toHaveLength(total);
  expect(new Set(ids).size).toBe(total);
}

test('all journal entries remain reachable beyond its page cap with tied dates', async () => {
  await Journal.insertMany(Array.from({ length: 53 }, (_, i) => ({
    key: 'key-' + i, threadId: 'thread-' + i, occurredAt: now(), summary: 'Synthetic summary', source: 'secretary'
  })));
  await allPages(journal.search, 'entries', 53, 50);
  await expect(journal.search({ offset: -1 })).rejects.toMatchObject({ code: 'MAIL_JOURNAL_INVALID' });
  expect((await journal.search({ offset: 99 })).pagination).toMatchObject({ returned: 0, hasMore: false, nextOffset: null });
});

test('all pending alerts and review statements remain reachable with tied dates', async () => {
  await Alert.insertMany(Array.from({ length: 103 }, (_, i) => ({
    key: 'alert-' + i, kind: 'synthetic', title: 'Synthetic alert', createdAt: now()
  })));
  await Statement.insertMany(Array.from({ length: 503 }, (_, i) => ({
    status: 'needs_review', fileName: 'synthetic-' + i, fileSha256: 'synthetic-hash-' + i,
    periodEnd: '2026-03-01', ingestedAt: now()
  })));
  await allPages(alerts.list, 'alerts', 103, 100);
  await allPages(input => finance.statements({ status: 'needs_review', ...input }), 'statements', 503, 500);
  await expect(alerts.list({ offset: -1 })).rejects.toMatchObject({ code: 'FINANCE_QUERY_INVALID' });
  await expect(finance.statements({ offset: 0.5 })).rejects.toMatchObject({ code: 'FINANCE_QUERY_INVALID' });
});

test('flagged actions expose count and continuation beyond the former twenty-row cut', async () => {
  await mongoose.connection.collection('emailactions').insertMany(Array.from({ length: 43 }, (_, i) => ({
    gmailThreadId: 'thread-' + i, createdAt: now(), action: 'Synthetic action'
  })));
  await allPages(async input => (await brief({ member: 'secretary', section: 'flaggedForOwner', ...input }, { now })).sections.flaggedForOwner,
    'actions', 43, 20);
});
