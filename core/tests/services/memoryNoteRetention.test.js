'use strict';

const MemoryNote = require('../../models/MemoryNote');
const { retentionDays, sweepMemoryNotes, createMemoryNoteRetention } = require('../../src/services/memoryNoteRetention');

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-02T12:00:00Z');
const ago = days => new Date(now.getTime() - days * DAY);

describe('memory note retention sweep with real Mongo', () => {
  beforeAll(async () => {
    await MemoryNote.createCollection();
    await MemoryNote.createIndexes();
  });
  beforeEach(() => MemoryNote.deleteMany({}));

  async function seed() {
    const base = { packId: 'personal_operator', scopeId: 'personal', scope: 'owner', sensitivity: 'private' };
    const rows = await MemoryNote.insertMany([
      { ...base, text: 'active synthetic fact' },
      { ...base, text: 'recently forgotten', status: 'forgotten', forgottenAt: ago(5) },
      { ...base, text: 'long forgotten', status: 'forgotten', forgottenAt: ago(45) },
      { ...base, text: 'recently expired', expiresAt: ago(3) },
      { ...base, text: 'long expired', expiresAt: ago(40) },
      { ...base, text: 'future expiry', expiresAt: new Date(now.getTime() + DAY) },
    ]);
    // A legacy forgotten row without forgottenAt falls back to its last update.
    await MemoryNote.collection.insertOne({ ...base, text: 'legacy forgotten', status: 'forgotten', updatedAt: ago(90), createdAt: ago(90) });
    return rows;
  }

  test('removes only notes hidden for longer than the retention period', async () => {
    await seed();

    expect(await sweepMemoryNotes({ now, days: 30, dryRun: true })).toMatchObject({ matched: 3, deleted: 0 });
    expect(await MemoryNote.countDocuments()).toBe(7);

    expect(await sweepMemoryNotes({ now, days: 30 })).toMatchObject({ enabled: true, deleted: 3 });
    const left = (await MemoryNote.find().lean()).map(row => row.text).sort();
    expect(left).toEqual(['active synthetic fact', 'future expiry', 'recently expired', 'recently forgotten']);
  });

  test('0 disables the sweep', async () => {
    await seed();
    expect(await sweepMemoryNotes({ now, days: 0 })).toEqual({ enabled: false, matched: 0, deleted: 0 });
    expect(await MemoryNote.countDocuments()).toBe(7);
  });
});

describe('memory note retention configuration and timer', () => {
  test('defaults to 30 days, honours a positive value and disables on 0 or junk', () => {
    expect(retentionDays({})).toBe(30);
    expect(retentionDays({ MEMORY_NOTE_RETENTION_DAYS: '' })).toBe(30);
    expect(retentionDays({ MEMORY_NOTE_RETENTION_DAYS: '7' })).toBe(7);
    expect(retentionDays({ MEMORY_NOTE_RETENTION_DAYS: '0' })).toBe(0);
    expect(retentionDays({ MEMORY_NOTE_RETENTION_DAYS: 'soon' })).toBe(0);
  });

  test('a failing sweep is logged, not thrown, and runs never overlap', async () => {
    let release;
    const sweep = jest.fn(() => new Promise(resolve => { release = resolve; }));
    const retention = createMemoryNoteRetention({ sweep });
    const first = retention.tick();
    expect(await retention.tick()).toBeNull();
    release({ deleted: 0 });
    await first;
    expect(sweep).toHaveBeenCalledTimes(1);

    const failing = createMemoryNoteRetention({ sweep: jest.fn(async () => { throw new Error('mongo down'); }) });
    await expect(failing.tick()).resolves.toBeNull();
  });
});
