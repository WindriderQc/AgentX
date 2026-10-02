'use strict';

const { randomBytes } = require('node:crypto');
const IdentifierVaultEntry = require('../../models/IdentifierVaultEntry');
const MemoryNote = require('../../models/MemoryNote');
const vault = require('../../src/services/identifierVault');
const { personal } = require('../../src/services/memoryNoteService');
const journal = require('../../src/services/mailJournalService');

// Synthetic values only: NAS 046 454 286 and card 4111… are public test numbers.
const TEXT = 'Mon NIQ : 1234567890, NAS 046 454 286, REEE no 98765432, compte folio 1234567, carte 4111 1111 1111 1111.';

describe('identifier vault with real Mongo', () => {
  const previous = process.env.IDENTIFIER_VAULT_KEY;
  beforeAll(async () => {
    process.env.IDENTIFIER_VAULT_KEY = randomBytes(32).toString('base64');
    await IdentifierVaultEntry.createCollection();
    await IdentifierVaultEntry.createIndexes();
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.IDENTIFIER_VAULT_KEY;
    else process.env.IDENTIFIER_VAULT_KEY = previous;
  });
  beforeEach(() => Promise.all([IdentifierVaultEntry.deleteMany({}), MemoryNote.deleteMany({})]));

  test('detects named identifiers and Luhn-valid cards, never dates or amounts', () => {
    expect(vault.findIdentifiers(TEXT).map(found => found.kind)).toEqual(['niq', 'nas', 'reee', 'account', 'card']);
    expect(vault.findIdentifiers('compte rendu du 2026-09-01, montant 1234567890123, NAS 123 456 789')).toEqual([]);
  });

  test('seals text, stores each value once encrypted and reveals it', async () => {
    const first = await vault.sealText(TEXT, { seenIn: 'test' });
    expect(first.text).not.toMatch(/1234567890|046 454 286|98765432|1234567\b|4111/);
    expect(first.text).toContain('[coffre: NIQ …7890]');
    await vault.sealText('Rappel NIQ 1234567890', { seenIn: 'other' });
    expect(await IdentifierVaultEntry.countDocuments()).toBe(5);
    const stored = await IdentifierVaultEntry.findOne({ kind: 'niq' }).lean();
    expect(stored.sealed).not.toContain('1234567890');
    expect(stored.seenIn.sort()).toEqual(['other', 'test']);
    const listed = await vault.list();
    expect(listed.identifiers.every(entry => entry.value === undefined)).toBe(true);
    expect((await vault.reveal(String(stored._id))).value).toBe('1234567890');
  });

  test('memory notes and mail journal entries keep only the reference', async () => {
    const saved = await personal().remember({ text: 'Mon NIQ est 1234567890' });
    expect(saved.text).toBe('Mon NIQ est [coffre: NIQ …7890]');
    expect(saved.sealed).toEqual([expect.objectContaining({ label: 'NIQ' })]);
    expect(await MemoryNote.countDocuments({ text: /1234567890/ })).toBe(0);
    const entry = await journal.record({ threadId: 't-vault', occurredAt: new Date().toISOString(),
      summary: 'Relevé REEE no 98765432 reçu' }, { days: 0 });
    expect(entry.entry.summary).toBe('Relevé REEE no [coffre: REEE …5432] reçu');
  });

  test('without a key the text is stored unchanged and reveal is refused', async () => {
    const key = process.env.IDENTIFIER_VAULT_KEY;
    delete process.env.IDENTIFIER_VAULT_KEY;
    try {
      expect(await vault.sealText(TEXT)).toEqual({ text: TEXT, sealed: [] });
      await expect(vault.reveal('a'.repeat(24))).rejects.toMatchObject({ code: 'IDENTIFIER_VAULT_NOT_CONFIGURED' });
    } finally {
      process.env.IDENTIFIER_VAULT_KEY = key;
    }
  });
});
