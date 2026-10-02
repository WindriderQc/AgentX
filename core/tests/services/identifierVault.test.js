'use strict';

const { randomBytes } = require('node:crypto');
const IdentifierVaultEntry = require('../../models/IdentifierVaultEntry');
const MemoryNote = require('../../models/MemoryNote');
const vault = require('../../src/services/identifierVault');
const { personal, forSpace } = require('../../src/services/memoryNoteService');
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
    expect(vault.findIdentifiers("numéro d'assurance sociale: 046-454-286").map(f => f.kind)).toEqual(['nas']);
    expect(vault.findIdentifiers('compte REEE 123-456 789').map(f => f.value)).toEqual(['123-456 789']);
  });

  test.each([
    'Relevé REEE du 2026-09-30 reçu', 'Rapport REEE 2025-2026', 'resp. 2026-10-01 meeting',
    'en tenant compte des années 2025 2026 2027', 'tenir compte du montant de 1 250 000 $',
    'Solde du compte: 12 345 678,90', 'compte Hydro: 514-555-1234', 'Ouvrir un compte au 1 800 361 2873',
    'compte rendu du 2026-09-01 - 2026-09-30', 'Décompte des heures 1234567',
    'suivi Postes Canada 4111111111111111', 'thread 19a2b3c4d5e6f708',
  ])('leaves ordinary text alone: %s', text => {
    expect(vault.findIdentifiers(text)).toEqual([]);
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

  test('sealing is idempotent and a wrong key cannot reveal', async () => {
    const once = await vault.sealText(TEXT);
    expect((await vault.sealText(once.text)).text).toBe(once.text);
    const stored = await IdentifierVaultEntry.findOne({ kind: 'niq' }).lean();
    const key = process.env.IDENTIFIER_VAULT_KEY;
    process.env.IDENTIFIER_VAULT_KEY = randomBytes(32).toString('base64');
    try {
      await expect(vault.reveal(String(stored._id))).rejects.toMatchObject({ code: 'IDENTIFIER_VAULT_KEY_MISMATCH' });
    } finally {
      process.env.IDENTIFIER_VAULT_KEY = key;
    }
  });

  test('family notes are never sealed', async () => {
    const family = forSpace({ audience: 'household', scopeId: 'family', packIds: ['kidx_nestor'] });
    expect((await family.record({ text: 'Synthetic carte de bibliothèque 4111 1111 1111 1111' })).text).toContain('4111');
    expect(await IdentifierVaultEntry.countDocuments()).toBe(0);
  });

  test('the migration reseals a note under a new hash and id', async () => {
    const { sealNote, noteIdOf } = require('../../scripts/seal-identifiers');
    const original = 'Mon NIQ est 1234567890';
    const row = { packId: 'personal_operator', scopeId: 'personal', scope: 'owner', sensitivity: 'private', text: original,
      contentHash: require('node:crypto').createHash('sha256').update(original.toLowerCase()).digest('hex') };
    row._id = new (require('mongoose').Types.ObjectId)(noteIdOf(row, original));
    await MemoryNote.collection.insertOne(row);
    expect(await sealNote(MemoryNote.db.db, row)).toBe(1);
    const [after] = await MemoryNote.collection.find({}).toArray();
    expect(after.text).toBe('Mon NIQ est [coffre: NIQ …7890]');
    expect(String(after._id)).toBe(noteIdOf(row, after.text));
    expect(after.contentHash).not.toBe(row.contentHash);
    expect(JSON.stringify(after)).not.toContain('1234567890');
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
