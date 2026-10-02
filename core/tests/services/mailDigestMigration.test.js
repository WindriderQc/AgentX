'use strict';

const MemoryNote = require('../../models/MemoryNote');
const MailJournalEntry = require('../../models/MailJournalEntry');
const { classify, planMigration, applyMigration } = require('../../src/services/mailDigestMigration');

const base = { packId: 'personal_operator', scopeId: 'personal', scope: 'owner', sensitivity: 'private', source: 'explicit-ui' };
const long = words => `${words} ${'detail '.repeat(40)}`;

describe('mail digest migration with real Mongo', () => {
  beforeAll(async () => {
    await Promise.all([MemoryNote.createCollection(), MailJournalEntry.createCollection()]);
    await Promise.all([MemoryNote.createIndexes(), MailJournalEntry.createIndexes()]);
  });
  beforeEach(() => Promise.all([MemoryNote.deleteMany({}), MailJournalEntry.deleteMany({})]));

  test('classifies by Gmail id, then by mail wording and length', () => {
    expect(classify({ text: 'Selon le courriel 19a2b3c4d5e6f708 du 3 sept.' })).toEqual({ kind: 'digest', threadId: '19a2b3c4d5e6f708' });
    expect(classify({ text: long('Selon la facture du plombier') })).toEqual({ kind: 'review' });
    expect(classify({ text: 'Synthetic owner prefers tea' })).toEqual({ kind: 'fact' });
    expect(classify({ text: 'Short courriel mention' })).toEqual({ kind: 'fact' });
  });

  test('dry run changes nothing; apply journals each digest, forgets its note and keeps facts', async () => {
    const filed = new Date();
    const [a, b, , fact] = await MemoryNote.insertMany([
      { ...base, text: 'Selon le courriel 19a2b3c4d5e6f708, synthetic school trip', createdAt: filed },
      { ...base, text: 'Selon le fil 19a2b3c4d5e6f708, synthetic follow-up', createdAt: filed },
      { ...base, text: long('Selon la facture synthetic du plombier') },
      { ...base, text: 'Synthetic owner prefers tea', kind: 'preference' },
      { ...base, text: 'Forgotten 0123456789abcdef', status: 'forgotten', forgottenAt: filed },
    ]);
    const plan = await planMigration();
    expect(plan).toMatchObject({ total: 4, digests: 2, review: 1, facts: 1 });
    expect(plan.rows.every(row => row.preview.split(' ').length <= 8)).toBe(true);
    expect(await MailJournalEntry.countDocuments()).toBe(0);

    const result = await applyMigration({ ids: [String(a._id)] });
    expect(result.moved).toHaveLength(1);
    expect(await MailJournalEntry.countDocuments()).toBe(1);

    const all = await applyMigration();
    expect(all.moved.map(row => row.id)).toEqual([String(b._id)]);
    const entries = await MailJournalEntry.find().lean();
    expect(entries.map(entry => entry.threadId)).toEqual(['19a2b3c4d5e6f708', '19a2b3c4d5e6f708']);
    expect(entries.every(entry => entry.source === 'notes-migration' && entry.tags.includes('migrated-from-notes'))).toBe(true);
    expect((await MemoryNote.findById(a._id).lean()).status).toBe('forgotten');
    expect((await MemoryNote.findById(fact._id).lean()).status).toBe('active');
    expect(await MemoryNote.countDocuments({ status: 'active' })).toBe(2);
  });
});
