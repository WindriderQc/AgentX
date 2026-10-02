'use strict';

const MailJournalEntry = require('../../models/MailJournalEntry');
const journal = require('../../src/services/mailJournalService');

const now = new Date('2026-10-02T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('mail journal with real Mongo', () => {
  beforeAll(async () => {
    await MailJournalEntry.createCollection();
    await MailJournalEntry.createIndexes();
  });
  beforeEach(() => MailJournalEntry.deleteMany({}));

  test('records one entry per thread/message, replaces it on repeat and expires it from the mail date', async () => {
    const input = { threadId: 'thread-1', occurredAt: '2026-09-30T08:00:00Z', counterpart: 'Synthetic school',
      subject: 'Field trip', summary: 'Synthetic field trip on Friday, signed form needed', tags: ['School', 'school'] };
    const first = await journal.record(input, { now, days: 365 });
    expect(first).toMatchObject({ recorded: true, created: true, entry: { threadId: 'thread-1', tags: ['school'] } });
    expect(new Date(first.entry.expiresAt).getTime()).toBe(new Date(input.occurredAt).getTime() + 365 * DAY);

    const again = await journal.record({ ...input, summary: 'Synthetic field trip moved to Monday' }, { now, days: 365 });
    expect(again).toMatchObject({ created: false, entry: { id: first.entry.id, summary: 'Synthetic field trip moved to Monday' } });
    await journal.record({ ...input, messageId: 'msg-2', summary: 'Synthetic reminder' }, { now, days: 365 });
    expect(await MailJournalEntry.countDocuments()).toBe(2);
  });

  test('skips mail already past retention and keeps entries forever when retention is 0', async () => {
    const old = { threadId: 'old', occurredAt: '2024-01-01T00:00:00Z', summary: 'Synthetic old notice' };
    expect(await journal.record(old, { now, days: 365 })).toMatchObject({ recorded: false });
    expect((await journal.record(old, { now, days: 0 })).entry.expiresAt).toBeNull();
  });

  test('search by words, thread and date range, newest first', async () => {
    await journal.record({ threadId: 't1', occurredAt: '2026-09-01T00:00:00Z', summary: 'Synthetic invoice from the plumber' }, { now, days: 0 });
    await journal.record({ threadId: 't2', occurredAt: '2026-09-20T00:00:00Z', summary: 'Synthetic invoice paid', counterpart: 'Plumber' }, { now, days: 0 });
    await journal.record({ threadId: 't3', occurredAt: '2026-09-25T00:00:00Z', summary: 'Synthetic hockey schedule' }, { now, days: 0 });
    expect((await journal.search({ query: 'plumber' })).entries.map(e => e.threadId)).toEqual(['t2', 't1']);
    expect((await journal.search({ query: 'invoice', since: '2026-09-10' })).entries.map(e => e.threadId)).toEqual(['t2']);
    expect((await journal.search({ threadId: 't3' })).total).toBe(1);
    expect((await journal.search({ query: '(.*' })).total).toBe(0);
  });

  test('validates input and the consumer operation', async () => {
    await expect(journal.record({ occurredAt: '2026-09-01', summary: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(journal.record({ threadId: 't', occurredAt: 'soon', summary: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(journal.record({ threadId: 't', occurredAt: '2027-01-01', summary: 'x' }, { now })).rejects.toMatchObject({ statusCode: 400 });
    await expect(journal.operate({ action: 'delete' })).rejects.toMatchObject({ code: 'MAIL_JOURNAL_INVALID' });
    expect((await journal.operate({ action: 'search' })).action).toBe('search');
    expect(journal.retentionDays({})).toBe(365);
    expect(journal.retentionDays({ MAIL_JOURNAL_RETENTION_DAYS: '0' })).toBe(0);
  });
});
